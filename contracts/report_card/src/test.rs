//! Tests for the fully-decentralised Report Card contract.
//!
//! Key changes from the old single-admin model:
//!   - initialize() takes a Vec<Address> council + threshold.
//!   - set_flags() is permissionless — any account may call it.
//!   - Auditor reputation is set via governance proposals, not admin().
//!   - No single Relayer key.

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, BytesN, Env, Symbol,
};

// ─────────────────────────── helpers ─────────────────────────────────────────

/// Deploy + initialise with a 2-of-3 governance council.
fn setup() -> (
    Env,
    ReportCardContractClient<'static>,
    Address, // council[0]
    Address, // council[1]
    Address, // council[2]
) {
    let env = Env::default();
    env.mock_all_auths();

    let c0 = Address::generate(&env);
    let c1 = Address::generate(&env);
    let c2 = Address::generate(&env);

    let contract_id = env.register_contract(None, ReportCardContract);
    let client      = ReportCardContractClient::new(&env, &contract_id);

    client.initialize(&vec![&env, c0.clone(), c1.clone(), c2.clone()], &2u32);

    (env, client, c0, c1, c2)
}

fn dummy_hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn dummy_sig(env: &Env) -> BytesN<64> {
    BytesN::from_array(env, &[0u8; 64])
}

// ─────────────────────────── initialize ──────────────────────────────────────

#[test]
fn test_initialize_stores_council() {
    let (env, client, c0, c1, c2) = setup();
    let council = client.get_council();
    assert_eq!(council.members.len(), 3);
    assert_eq!(council.threshold, 2);
}

#[test]
#[should_panic(expected = "already initialised")]
fn test_initialize_twice_panics() {
    let (env, client, c0, c1, _) = setup();
    client.initialize(&vec![&env, c0.clone()], &1u32);
}

#[test]
#[should_panic(expected = "threshold must be between 1 and council size")]
fn test_initialize_bad_threshold_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let c0 = Address::generate(&env);
    let contract_id = env.register_contract(None, ReportCardContract);
    let client = ReportCardContractClient::new(&env, &contract_id);
    client.initialize(&vec![&env, c0.clone()], &5u32); // threshold > len
}

// ─────────────────────────── governance — propose + vote ─────────────────────

#[test]
fn test_proposal_reaches_threshold_and_executes() {
    let (env, client, c0, c1, _c2) = setup();

    // We'll vote to deactivate a (non-existent) auditor — just checking
    // the vote-counting and execution logic. Use "aud_dact" kind.
    let auditor = Address::generate(&env);

    // First register the auditor so deactivation doesn't panic.
    // We skip the proposal path for this helper registration since we're
    // testing voting mechanics, not auditor reg.
    // Instead, let's create a "council" proposal that replaces itself
    // with a single-member 1-of-1 council (simplest exec path).
    let new_council = Council {
        members:   vec![&env, c0.clone()],
        threshold: 1,
    };
    let new_council_xdr = new_council.to_xdr(&env);
    let payload: BytesN<32> = env.crypto().sha256(&new_council_xdr);
    let proposal_id = dummy_hash(&env, 0xAB);

    client.propose(&c0, &proposal_id, &symbol_short!("council"), &payload);

    // One vote (c0 proposed, which counts as a vote). Threshold=2, need c1.
    client.vote(&c1, &proposal_id, &new_council_xdr);

    // After execution the proposal is removed and council updated.
    let updated = client.get_council();
    assert_eq!(updated.members.len(), 1);
    assert_eq!(updated.threshold, 1);
}

#[test]
#[should_panic(expected = "caller is not a council member")]
fn test_non_member_cannot_propose() {
    let (env, client, _c0, _c1, _c2) = setup();
    let outsider = Address::generate(&env);
    client.propose(
        &outsider,
        &dummy_hash(&env, 0x01),
        &symbol_short!("council"),
        &dummy_hash(&env, 0x02),
    );
}

#[test]
#[should_panic(expected = "proposal expired")]
fn test_expired_proposal_cannot_be_voted() {
    let (env, client, c0, c1, _c2) = setup();

    let payload     = dummy_hash(&env, 0x10);
    let proposal_id = dummy_hash(&env, 0x11);

    client.propose(&c0, &proposal_id, &symbol_short!("council"), &payload);

    // Advance ledger sequence past expiry.
    env.ledger().with_mut(|l| {
        l.sequence_number += 17_281; // PROPOSAL_TTL_LEDGERS + 1
    });

    client.vote(&c1, &proposal_id, &Bytes::from_array(&env, &[0u8; 32]));
}

// ─────────────────────────── set_flags — permissionless ──────────────────────

#[test]
fn test_set_flags_any_account_can_submit() {
    let (env, client, _c0, _c1, _c2) = setup();

    let anyone  = Address::generate(&env);
    let target  = Address::generate(&env);
    let wh      = dummy_hash(&env, 0x01);

    // In tests, verify_wasm_hash is bypassed via mock_all_auths (the deployer
    // host function is not available in the test harness, so we test the logic
    // path where verification succeeds by default under mock).
    client.set_flags(&anyone, &target, &wh, &false, &false, &false, &5u32);

    let record = client.is_safe(&target);
    assert_eq!(record.grade.numeric, 2); // D — no attestations, no source
}

#[test]
#[should_panic(expected = "maturity_score must be 0-10")]
fn test_set_flags_bad_maturity() {
    let (env, client, _c0, _c1, _c2) = setup();
    let anyone = Address::generate(&env);
    let target = Address::generate(&env);
    client.set_flags(
        &anyone, &target, &dummy_hash(&env, 1),
        &false, &false, &false, &11u32,
    );
}

#[test]
fn test_set_flags_upgradeable_grades_f() {
    let (env, client, _c0, _c1, _c2) = setup();
    let anyone = Address::generate(&env);
    let target = Address::generate(&env);
    client.set_flags(&anyone, &target, &dummy_hash(&env, 2), &true, &false, &true, &0u32);
    let record = client.is_safe(&target);
    assert_eq!(record.grade.numeric, 1); // F
}

#[test]
fn test_set_flags_fully_safe_no_attestations() {
    let (env, client, _c0, _c1, _c2) = setup();
    let anyone = Address::generate(&env);
    let target = Address::generate(&env);
    // source_verified=true, not upgradeable, no admin power, maturity=10
    client.set_flags(&anyone, &target, &dummy_hash(&env, 3), &false, &true, &false, &10u32);
    let record = client.is_safe(&target);
    // score = (25*100 + 20*100 + 15*100 + 10*100) / 100 = 70 → B
    assert_eq!(record.grade.numeric, 4); // B
}

// ─────────────────────────── submit_attestation ───────────────────────────────

#[test]
#[should_panic(expected = "auditor not registered")]
fn test_unregistered_auditor_cannot_attest() {
    let (env, client, _c0, _c1, _c2) = setup();
    let stranger = Address::generate(&env);
    let target   = Address::generate(&env);
    client.submit_attestation(
        &stranger, &target, &dummy_hash(&env, 4),
        &true, &80u32, &dummy_sig(&env),
    );
}

#[test]
fn test_attestation_increments_count_and_improves_grade() {
    let (env, client, c0, c1, _c2) = setup();

    let target  = Address::generate(&env);
    let auditor = Address::generate(&env);
    let wh      = dummy_hash(&env, 0x10);

    // Seed flags first.
    let anyone = Address::generate(&env);
    client.set_flags(&anyone, &target, &wh, &false, &true, &false, &8u32);

    // Register auditor via a governance proposal (aud_rep kind).
    // We construct the payload manually: [4-byte addr_len LE][addr_xdr][4-byte rep LE][32 meta].
    let auditor_xdr  = auditor.to_xdr(&env);
    let addr_len     = auditor_xdr.len() as u32;
    let reputation: u32 = 90;
    let meta_hash    = dummy_hash(&env, 0x20);

    let mut rep_data = Bytes::new(&env);
    for b in addr_len.to_le_bytes().iter() { rep_data.push_back(*b); }
    rep_data.append(&auditor_xdr);
    for b in reputation.to_le_bytes().iter() { rep_data.push_back(*b); }
    let mh_bytes: Bytes = meta_hash.clone().into();
    rep_data.append(&mh_bytes);

    let payload_hash: BytesN<32> = env.crypto().sha256(&rep_data);
    let prop_id = dummy_hash(&env, 0xC0);

    client.propose(&c0, &prop_id, &symbol_short!("aud_rep"), &payload_hash);
    client.vote(&c1, &prop_id, &rep_data); // reaches threshold=2

    // Auditor is now registered.
    let info = client.get_auditor(&auditor).expect("auditor not registered after proposal");
    assert_eq!(info.reputation, 90);

    // Submit attestation.
    client.submit_attestation(
        &auditor, &target, &wh,
        &true, &95u32, &dummy_sig(&env),
    );

    let att = client.get_attestation(&target, &auditor).expect("attestation missing");
    assert!(att.verdict);

    let record = client.is_safe(&target);
    assert!(record.attestation_count >= 1);
    assert!(record.grade.numeric >= 4); // B or better
}

// ─────────────────────────── is_safe — unknown contract ──────────────────────

#[test]
fn test_is_safe_unknown_returns_f() {
    let (env, client, _c0, _c1, _c2) = setup();
    let unknown = Address::generate(&env);
    let record  = client.is_safe(&unknown);
    assert_eq!(record.grade.letter, Symbol::new(&env, "F"));
    assert_eq!(record.grade.numeric, 1);
    assert!(record.upgradeable);
    assert!(record.admin_power);
}

// ─────────────────────────── full A-grade path ────────────────────────────────

#[test]
fn test_full_a_grade() {
    let (env, client, c0, c1, _c2) = setup();
    let target  = Address::generate(&env);
    let anyone  = Address::generate(&env);
    let wh      = dummy_hash(&env, 0xFF);

    // Set all-green flags.
    client.set_flags(&anyone, &target, &wh, &false, &true, &false, &10u32);

    // Register 5 auditors and submit attestations.
    for i in 0u8..5 {
        let auditor = Address::generate(&env);
        let aud_xdr = auditor.to_xdr(&env);
        let alen    = aud_xdr.len() as u32;
        let mut pd  = Bytes::new(&env);
        for b in alen.to_le_bytes().iter() { pd.push_back(*b); }
        pd.append(&aud_xdr);
        let rep: u32 = 100;
        for b in rep.to_le_bytes().iter() { pd.push_back(*b); }
        let mhb: Bytes = dummy_hash(&env, i).into();
        pd.append(&mhb);

        let ph: BytesN<32> = env.crypto().sha256(&pd);
        let pid = dummy_hash(&env, i + 10);

        client.propose(&c0, &pid, &symbol_short!("aud_rep"), &ph);
        client.vote(&c1, &pid, &pd);

        client.submit_attestation(&auditor, &target, &wh, &true, &100u32, &dummy_sig(&env));
    }

    let record = client.is_safe(&target);
    assert_eq!(record.grade.numeric, 5); // A
}
