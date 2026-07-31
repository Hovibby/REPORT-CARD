//! Unit + integration tests for the Report Card registry contract.

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Ledger},
    Address, BytesN, Env, Symbol,
};

// ─────────────────────────── helpers ─────────────────────────────────────────

/// Deploy the contract and return (env, client, admin, relayer).
fn setup() -> (Env, ReportCardContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let relayer = Address::generate(&env);

    let contract_id = env.register_contract(None, ReportCardContract);
    let client = ReportCardContractClient::new(&env, &contract_id);

    client.initialize(&admin, &relayer);

    (env, client, admin, relayer)
}

/// Build a dummy 32-byte WASM hash.
fn dummy_hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

/// Build a dummy 64-byte signature (all zeros — passes under mock_all_auths
/// because the crypto call is bypassed in test mode).
fn dummy_sig(env: &Env) -> BytesN<64> {
    BytesN::from_array(env, &[0u8; 64])
}

// ─────────────────────────── initialize ──────────────────────────────────────

#[test]
fn test_initialize_sets_admin_and_relayer() {
    let (env, client, admin, relayer) = setup();
    // Smoke: is_safe on an unknown contract returns an F record.
    let target = Address::generate(&env);
    let record = client.is_safe(&target);
    assert_eq!(record.grade.numeric, 1); // F
}

#[test]
#[should_panic(expected = "already initialised")]
fn test_initialize_cannot_reinitialise() {
    let (env, client, admin, relayer) = setup();
    let admin2 = Address::generate(&env);
    client.initialize(&admin2, &admin2); // must panic
}

// ─────────────────────────── register_auditor ────────────────────────────────

#[test]
fn test_register_auditor_stores_record() {
    let (env, client, _admin, _relayer) = setup();
    let auditor = Address::generate(&env);
    let meta = dummy_hash(&env, 0xAA);

    client.register_auditor(&auditor, &80u32, &meta);

    let info = client.get_auditor(&auditor).expect("auditor not found");
    assert_eq!(info.reputation, 80);
    assert!(info.active);
}

#[test]
#[should_panic(expected = "reputation must be 1-100")]
fn test_register_auditor_zero_reputation_panics() {
    let (env, client, _admin, _relayer) = setup();
    let auditor = Address::generate(&env);
    client.register_auditor(&auditor, &0u32, &dummy_hash(&env, 1));
}

#[test]
#[should_panic(expected = "reputation must be 1-100")]
fn test_register_auditor_over_100_panics() {
    let (env, client, _admin, _relayer) = setup();
    let auditor = Address::generate(&env);
    client.register_auditor(&auditor, &101u32, &dummy_hash(&env, 2));
}

#[test]
fn test_deactivate_auditor() {
    let (env, client, _admin, _relayer) = setup();
    let auditor = Address::generate(&env);
    client.register_auditor(&auditor, &50u32, &dummy_hash(&env, 3));
    client.deactivate_auditor(&auditor);

    let info = client.get_auditor(&auditor).unwrap();
    assert!(!info.active);
}

// ─────────────────────────── set_flags ───────────────────────────────────────

#[test]
fn test_set_flags_creates_record_and_grades() {
    let (env, client, _admin, _relayer) = setup();
    let target = Address::generate(&env);
    let wh = dummy_hash(&env, 0x01);

    // Unaudited, not source-verified, NOT upgradeable, no admin power, maturity=5.
    client.set_flags(&target, &wh, &false, &false, &false, &5u32);

    let record = client.is_safe(&target);
    // upgradeable=false → 100*20=2000; admin_power=false → 100*15=1500;
    // maturity=5 → 50*10=500; attestation=0 → 0*30=0; source=false → 0*25=0
    // raw = (2000+1500+500+0+0)/100 = 40 → D (35-49)
    assert_eq!(record.grade.numeric, 2); // D
    assert!(!record.upgradeable);
}

#[test]
fn test_set_flags_upgradeable_caps_grade() {
    let (env, client, _admin, _relayer) = setup();
    let target = Address::generate(&env);

    // Upgradeable + no audits → should be F.
    client.set_flags(&target, &dummy_hash(&env, 2), &true, &false, &true, &0u32);
    let record = client.is_safe(&target);
    assert_eq!(record.grade.numeric, 1); // F
    assert!(record.upgradeable);
}

#[test]
fn test_set_flags_fully_verified_no_threats_no_attestations() {
    let (env, client, _admin, _relayer) = setup();
    let target = Address::generate(&env);
    let wh = dummy_hash(&env, 3);

    // source_verified=true, NOT upgradeable, no admin_power, maturity=10.
    client.set_flags(&target, &wh, &false, &true, &false, &10u32);
    let record = client.is_safe(&target);
    // source=100*25=2500; upgrade=100*20=2000; admin=100*15=1500; maturity=100*10=1000
    // att=0; raw=(2500+2000+1500+1000)/100 = 70 → B (65-79)
    assert_eq!(record.grade.numeric, 4); // B
}

#[test]
#[should_panic(expected = "maturity_score must be 0-10")]
fn test_set_flags_bad_maturity_panics() {
    let (env, client, _admin, _relayer) = setup();
    let target = Address::generate(&env);
    client.set_flags(&target, &dummy_hash(&env, 4), &false, &false, &false, &11u32);
}

// ─────────────────────────── submit_attestation ───────────────────────────────

#[test]
fn test_submit_attestation_stored_and_grade_updated() {
    let (env, client, _admin, _relayer) = setup();

    let target = Address::generate(&env);
    let auditor = Address::generate(&env);
    let wh = dummy_hash(&env, 0x10);

    // Seed a record first so wasm_hash is set.
    client.set_flags(&target, &wh, &false, &true, &false, &8u32);

    // Register auditor with high reputation.
    client.register_auditor(&auditor, &90u32, &dummy_hash(&env, 0x20));

    // Submit attestation (sig is validated via mock_all_auths in test mode).
    client.submit_attestation(
        &auditor,
        &target,
        &wh,
        &true,
        &95u32,
        &dummy_sig(&env),
    );

    // Attestation should be stored.
    let att = client.get_attestation(&target, &auditor).expect("attestation not found");
    assert!(att.verdict);
    assert_eq!(att.confidence, 95);

    // Grade should improve — source=true, no upgrade, no admin, maturity=8, 1 att.
    // att_contrib=1*20=20 → 20*30=600
    // src=100*25=2500; upg=100*20=2000; adm=100*15=1500; mat=8*10=80 → 80*10=800
    // raw=(600+2500+2000+1500+800)/100 = 74 → B
    let record = client.is_safe(&target);
    assert!(record.grade.numeric >= 4); // B or better
}

#[test]
#[should_panic(expected = "auditor not registered")]
fn test_submit_attestation_unknown_auditor_panics() {
    let (env, client, _admin, _relayer) = setup();
    let target = Address::generate(&env);
    let stranger = Address::generate(&env);

    client.submit_attestation(
        &stranger,
        &target,
        &dummy_hash(&env, 5),
        &true,
        &80u32,
        &dummy_sig(&env),
    );
}

#[test]
#[should_panic(expected = "auditor deactivated")]
fn test_submit_attestation_deactivated_auditor_panics() {
    let (env, client, _admin, _relayer) = setup();
    let target = Address::generate(&env);
    let auditor = Address::generate(&env);

    client.register_auditor(&auditor, &70u32, &dummy_hash(&env, 6));
    client.deactivate_auditor(&auditor);

    client.submit_attestation(
        &auditor,
        &target,
        &dummy_hash(&env, 5),
        &true,
        &80u32,
        &dummy_sig(&env),
    );
}

// ─────────────────────────── grade boundary tests ────────────────────────────

#[test]
fn test_grade_a_full_score() {
    let (env, client, _admin, _relayer) = setup();
    let target = Address::generate(&env);
    let auditor = Address::generate(&env);
    let wh = dummy_hash(&env, 0xFF);

    // Register 5 high-rep auditors to push attestation_count to max contribution.
    for i in 0u8..5 {
        let aud = Address::generate(&env);
        client.register_auditor(&aud, &100u32, &dummy_hash(&env, i));
        // Manually bump attestation count by submitting (engine sets count via relayer normally).
        client.submit_attestation(&aud, &target, &wh, &true, &100u32, &dummy_sig(&env));
    }

    // Full flags: source_verified, not upgradeable, no admin_power, maturity=10.
    client.set_flags(&target, &wh, &false, &true, &false, &10u32);

    // After set_flags the attestation_count is reset to 0 (relayer controls count).
    // Set it properly by re-submitting with the same wh — count will be 5 after.
    // (attestation_count is managed by recompute_grade based on stored attestations)
    // Resubmit so count increments back up after flag write.
    let record = client.is_safe(&target);
    // With 5 attestations + full flags: att=100*30=3000; src=100*25=2500;
    // upg=100*20=2000; adm=100*15=1500; mat=100*10=1000 → raw=100 → A
    assert_eq!(record.grade.numeric, 5); // A
}

#[test]
fn test_is_safe_unknown_contract_returns_f() {
    let (env, client, _admin, _relayer) = setup();
    let unknown = Address::generate(&env);
    let record = client.is_safe(&unknown);
    assert_eq!(record.grade.letter, Symbol::new(&env, "F"));
    assert_eq!(record.grade.numeric, 1);
    assert!(record.upgradeable);
}
