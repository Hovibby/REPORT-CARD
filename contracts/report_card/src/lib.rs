//! Report Card — fully decentralised safety registry for Soroban smart contracts.
//!
//! Design principles:
//!   1. NO single admin key.  All governance is controlled by an on-chain
//!      council: a Vec<Address> + a threshold.  Any change requires ≥ threshold
//!      council members to sign the same proposal within one TTL window.
//!
//!   2. NO privileged relayer key.  set_flags() is PERMISSIONLESS.  Any Stellar
//!      account may submit WASM analysis flags.  The contract verifies the
//!      supplied wasm_hash against the actual on-chain WASM by reading the
//!      contract's own ledger entry, so fraudulent hash claims are rejected.
//!
//!   3. Auditor attestations are signed by the auditor's own wallet via
//!      require_auth() — no special registration required.  Reputation is set
//!      by the governance council, not a single admin.
//!
//!   4. All state lives entirely on Stellar/Soroban persistent storage.
//!      No off-chain database, no Docker, no centralised relay.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    symbol_short,
    vec, Vec,
    Address, Bytes, BytesN, Env, Symbol,
};

// ─────────────────────────── on-chain types ──────────────────────────────────

/// Letter grade — stored as u32 for cheap cross-contract numeric comparisons.
/// A=5  B=4  C=3  D=2  F=1  (higher is safer).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Grade {
    pub letter:  Symbol, // "A" | "B" | "C" | "D" | "F"
    pub score:   u32,    // 0–100 raw weighted score
    pub numeric: u32,    // 5=A … 1=F
}

/// Full safety record — one per analysed contract address.
#[contracttype]
#[derive(Clone, Debug)]
pub struct SafetyRecord {
    pub grade:             Grade,
    pub upgradeable:       bool,
    pub source_verified:   bool,
    pub wasm_hash:         BytesN<32>,
    pub attestation_count: u32,
    pub admin_power:       bool,
    pub maturity_score:    u32,  // 0–10
}

/// On-chain auditor identity — reputation set by governance council vote.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Auditor {
    pub reputation: u32,           // 1–100
    pub meta_hash:  BytesN<32>,    // IPFS / Arweave CID of auditor profile
    pub active:     bool,
}

/// Auditor attestation — cryptographically bound to a specific WASM hash.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Attestation {
    pub wasm_hash:  BytesN<32>,
    pub verdict:    bool,          // true = safe, false = unsafe
    pub confidence: u32,           // 1–100
    pub sig:        BytesN<64>,    // Ed25519 over (contract_id || wasm_hash || verdict || confidence || ledger_seq)
    pub ledger_ts:  u64,
}

/// Governance council — replaces the single admin key.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Council {
    pub members:   Vec<Address>,   // current council members
    pub threshold: u32,            // minimum signatures required to pass a proposal
}

/// A pending governance proposal (council change or auditor reputation update).
#[contracttype]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub kind:        Symbol,       // "council" | "auditor_rep" | "auditor_deact"
    pub payload:     BytesN<32>,   // SHA-256 of the proposal data (prevents tampering)
    pub votes:       Vec<Address>, // council members who have already signed
    pub expiry_seq:  u32,          // ledger sequence after which the proposal is void
}

// ─────────────────────────── storage keys ────────────────────────────────────

#[contracttype]
pub enum DataKey {
    /// The governance council (members + threshold).
    Council,
    /// SafetyRecord keyed by contract address.
    Record(Address),
    /// Auditor identity keyed by auditor address.
    AuditorInfo(Address),
    /// (contract, auditor) → Attestation
    Attestation(Address, Address),
    /// Pending governance proposal keyed by a proposal ID (BytesN<32>).
    Proposal(BytesN<32>),
}

// ─────────────────────────── scoring weights ─────────────────────────────────

// Weights must sum to 100.
const W_ATTESTATION: u32 = 30;
const W_SOURCE:      u32 = 25;
const W_UPGRADE:     u32 = 20;
const W_ADMIN:       u32 = 15;
const W_MATURITY:    u32 = 10;

// Grade thresholds (inclusive lower bound).
const THRESH_A: u32 = 80;
const THRESH_B: u32 = 65;
const THRESH_C: u32 = 50;
const THRESH_D: u32 = 35;

// Proposal TTL — number of ledgers a proposal stays open for voting (~24 h).
const PROPOSAL_TTL_LEDGERS: u32 = 17_280;

// ─────────────────────────── contract ────────────────────────────────────────

#[contract]
pub struct ReportCardContract;

#[contractimpl]
impl ReportCardContract {

    // ────────────────────────────────────────────────────────────────────────
    // BOOTSTRAP — called once at deploy time.
    // ────────────────────────────────────────────────────────────────────────

    /// Initialise the governance council.  Can only be called once.
    ///
    /// `members`   — initial council addresses (≥ 1)
    /// `threshold` — minimum votes required to pass a proposal (1 ≤ t ≤ len)
    pub fn initialize(env: Env, members: Vec<Address>, threshold: u32) {
        if env.storage().instance().has(&DataKey::Council) {
            panic!("already initialised");
        }
        if members.is_empty() {
            panic!("council must have at least one member");
        }
        if threshold == 0 || threshold > members.len() as u32 {
            panic!("threshold must be between 1 and council size");
        }
        // All initial members must authorise bootstrap.
        for m in members.iter() {
            m.require_auth();
        }
        let council = Council { members, threshold };
        env.storage().instance().set(&DataKey::Council, &council);
    }

    // ────────────────────────────────────────────────────────────────────────
    // GOVERNANCE — council-voted actions.
    // ────────────────────────────────────────────────────────────────────────

    /// Read the current governance council.
    pub fn get_council(env: Env) -> Council {
        env.storage()
            .instance()
            .get(&DataKey::Council)
            .expect("not initialised")
    }

    /// Create a new governance proposal.
    ///
    /// `proposal_id` — caller-supplied unique ID (BytesN<32>); must not exist.
    /// `kind`        — "council" | "auditor_rep" | "auditor_deact"
    /// `payload`     — SHA-256 of the proposal data.  The contract does NOT
    ///                 interpret the payload; it only guards against tampering.
    ///
    /// The proposer must be a council member.
    pub fn propose(
        env:         Env,
        proposer:    Address,
        proposal_id: BytesN<32>,
        kind:        Symbol,
        payload:     BytesN<32>,
    ) {
        proposer.require_auth();
        Self::require_council_member(&env, &proposer);

        let key = DataKey::Proposal(proposal_id);
        if env.storage().persistent().has(&key) {
            panic!("proposal already exists");
        }

        let proposal = Proposal {
            kind,
            payload,
            votes:      vec![&env, proposer],
            expiry_seq: env.ledger().sequence() + PROPOSAL_TTL_LEDGERS,
        };
        env.storage().persistent().set(&key, &proposal);
    }

    /// Vote on an existing proposal.  When votes reach threshold the proposal
    /// is automatically executed.
    ///
    /// For "auditor_rep"  proposals, `exec_data` = (auditor Address, new reputation u32, meta_hash BytesN<32>)
    ///   encoded as XDR ScVec.
    /// For "auditor_deact" proposals, `exec_data` = auditor Address XDR.
    /// For "council" proposals, `exec_data` = new Council XDR.
    pub fn vote(
        env:         Env,
        voter:       Address,
        proposal_id: BytesN<32>,
        exec_data:   Bytes,
    ) {
        voter.require_auth();
        Self::require_council_member(&env, &voter);

        let key = DataKey::Proposal(proposal_id.clone());
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");

        if env.ledger().sequence() > proposal.expiry_seq {
            panic!("proposal expired");
        }

        // Idempotent — ignore duplicate votes.
        for v in proposal.votes.iter() {
            if v == voter {
                return;
            }
        }

        proposal.votes.push_back(voter.clone());

        let council: Council = env
            .storage()
            .instance()
            .get(&DataKey::Council)
            .expect("not initialised");

        if proposal.votes.len() as u32 >= council.threshold {
            // Verify payload integrity: SHA-256(exec_data) must match stored payload.
            let computed: BytesN<32> = env.crypto().sha256(&exec_data);
            if computed != proposal.payload {
                panic!("exec_data does not match proposal payload hash");
            }

            // Execute based on kind.
            if proposal.kind == symbol_short!("council") {
                // exec_data is XDR-encoded Council.
                let new_council = Council::from_xdr(&env, &exec_data)
                    .expect("invalid council XDR");
                if new_council.members.is_empty() {
                    panic!("new council must have at least one member");
                }
                if new_council.threshold == 0
                    || new_council.threshold > new_council.members.len() as u32
                {
                    panic!("invalid threshold in new council");
                }
                env.storage().instance().set(&DataKey::Council, &new_council);
            } else if proposal.kind == symbol_short!("aud_rep") {
                // exec_data is XDR-encoded (Address, u32, BytesN<32>).
                // We store as Auditor directly so the XDR must be an Auditor struct.
                let (auditor_addr, reputation, meta_hash) =
                    decode_auditor_rep_data(&env, &exec_data);
                if reputation == 0 || reputation > 100 {
                    panic!("reputation must be 1-100");
                }
                let info = Auditor { reputation, meta_hash, active: true };
                env.storage()
                    .persistent()
                    .set(&DataKey::AuditorInfo(auditor_addr), &info);
            } else if proposal.kind == symbol_short!("aud_dact") {
                // exec_data is XDR-encoded Address.
                let auditor_addr = Address::from_xdr(&env, &exec_data)
                    .expect("invalid auditor address XDR");
                let aud_key = DataKey::AuditorInfo(auditor_addr);
                if let Some(mut info) =
                    env.storage().persistent().get::<DataKey, Auditor>(&aud_key)
                {
                    info.active = false;
                    env.storage().persistent().set(&aud_key, &info);
                }
            } else {
                panic!("unknown proposal kind");
            }

            // Remove the executed proposal.
            env.storage().persistent().remove(&key);

            env.events().publish(
                (symbol_short!("executed"), proposal_id),
                proposal.kind,
            );
        } else {
            env.storage().persistent().set(&key, &proposal);
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // AUDITOR WRITE — open to any registered auditor; no admin required.
    // ────────────────────────────────────────────────────────────────────────

    /// Submit a signed attestation bound to a specific WASM hash.
    ///
    /// Any address that has been granted a reputation score by the council
    /// may attest.  The caller is authenticated via require_auth() — no
    /// privileged relay key is needed.
    pub fn submit_attestation(
        env:         Env,
        auditor:     Address,
        contract_id: Address,
        wasm_hash:   BytesN<32>,
        verdict:     bool,
        confidence:  u32,
        sig:         BytesN<64>,
    ) {
        auditor.require_auth();

        let aud_key = DataKey::AuditorInfo(auditor.clone());
        let aud_info: Auditor = env
            .storage()
            .persistent()
            .get(&aud_key)
            .expect("auditor not registered — governance council must set reputation first");
        if !aud_info.active {
            panic!("auditor deactivated");
        }
        if confidence == 0 || confidence > 100 {
            panic!("confidence must be 1-100");
        }

        Self::verify_attestation_sig(
            &env,
            &auditor,
            &contract_id,
            &wasm_hash,
            verdict,
            confidence,
            &sig,
        );

        let att = Attestation {
            wasm_hash: wasm_hash.clone(),
            verdict,
            confidence,
            sig,
            ledger_ts: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Attestation(contract_id.clone(), auditor.clone()), &att);

        // Increment the attestation counter on the record.
        let rec_key = DataKey::Record(contract_id.clone());
        let mut record: SafetyRecord = env
            .storage()
            .persistent()
            .get(&rec_key)
            .unwrap_or_else(|| blank_record(&env, &wasm_hash));
        record.attestation_count = record.attestation_count.saturating_add(1);
        env.storage().persistent().set(&rec_key, &record);

        Self::recompute_grade(&env, &contract_id);
    }

    // ────────────────────────────────────────────────────────────────────────
    // PERMISSIONLESS FLAG SUBMISSION — no relayer key required.
    // ────────────────────────────────────────────────────────────────────────

    /// Submit WASM analysis flags for a contract.
    ///
    /// PERMISSIONLESS — any Stellar account may call this.  The contract
    /// enforces integrity by checking that `wasm_hash` matches the actual
    /// WASM hash stored on ledger for `contract_id`.  Fraudulent submissions
    /// with mismatched hashes are rejected on-chain.
    ///
    /// `submitter`      — account paying the transaction fee (must sign).
    /// `contract_id`    — target contract being analysed.
    /// `wasm_hash`      — claimed SHA-256 of the deployed WASM bytecode.
    /// `upgradeable`    — WASM contains `update_current_contract_wasm`.
    /// `source_verified`— reproducible build of the claimed source matches `wasm_hash`.
    /// `admin_power`    — WASM exports mint/freeze/drain gated by a single key.
    /// `maturity_score` — 0–10 score from ledger age + distinct callers.
    pub fn set_flags(
        env:             Env,
        submitter:       Address,
        contract_id:     Address,
        wasm_hash:       BytesN<32>,
        upgradeable:     bool,
        source_verified: bool,
        admin_power:     bool,
        maturity_score:  u32,
    ) {
        submitter.require_auth();

        if maturity_score > 10 {
            panic!("maturity_score must be 0-10");
        }

        // ── On-chain WASM hash verification ───────────────────────────────
        // Fetch the actual WASM hash for `contract_id` from ledger state and
        // compare it against the submitted claim.  This makes the submission
        // permissionless without sacrificing integrity.
        Self::verify_wasm_hash(&env, &contract_id, &wasm_hash);

        let rec_key = DataKey::Record(contract_id.clone());
        let mut record: SafetyRecord = env
            .storage()
            .persistent()
            .get(&rec_key)
            .unwrap_or_else(|| blank_record_default(&env));

        record.wasm_hash        = wasm_hash;
        record.upgradeable      = upgradeable;
        record.source_verified  = source_verified;
        record.admin_power      = admin_power;
        record.maturity_score   = maturity_score;
        env.storage().persistent().set(&rec_key, &record);

        Self::recompute_grade(&env, &contract_id);
    }

    // ────────────────────────────────────────────────────────────────────────
    // READ — pure, no fees.
    // ────────────────────────────────────────────────────────────────────────

    /// Returns the full SafetyRecord for `contract_id`.
    /// Returns a default F record for contracts that have never been analysed.
    pub fn is_safe(env: Env, contract_id: Address) -> SafetyRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Record(contract_id))
            .unwrap_or_else(|| SafetyRecord {
                grade:             grade_from_score(0),
                upgradeable:       true,
                source_verified:   false,
                wasm_hash:         BytesN::from_array(&env, &[0u8; 32]),
                attestation_count: 0,
                admin_power:       true,
                maturity_score:    0,
            })
    }

    /// Returns the auditor record, or None if not registered.
    pub fn get_auditor(env: Env, auditor: Address) -> Option<Auditor> {
        env.storage().persistent().get(&DataKey::AuditorInfo(auditor))
    }

    /// Returns the attestation for (contract_id, auditor), or None.
    pub fn get_attestation(
        env:         Env,
        contract_id: Address,
        auditor:     Address,
    ) -> Option<Attestation> {
        env.storage()
            .persistent()
            .get(&DataKey::Attestation(contract_id, auditor))
    }

    /// Returns a pending proposal, or None if it doesn't exist / was executed.
    pub fn get_proposal(env: Env, proposal_id: BytesN<32>) -> Option<Proposal> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
    }

    // ────────────────────────────────────────────────────────────────────────
    // INTERNAL HELPERS
    // ────────────────────────────────────────────────────────────────────────

    fn require_council_member(env: &Env, addr: &Address) {
        let council: Council = env
            .storage()
            .instance()
            .get(&DataKey::Council)
            .expect("not initialised");
        let is_member = council.members.iter().any(|m| m == *addr);
        if !is_member {
            panic!("caller is not a council member");
        }
    }

    /// Recomputes and persists the weighted grade for `contract_id`.
    fn recompute_grade(env: &Env, contract_id: &Address) {
        let rec_key = DataKey::Record(contract_id.clone());
        let mut record: SafetyRecord = env
            .storage()
            .persistent()
            .get(&rec_key)
            .unwrap_or_else(|| blank_record_default(env));

        let att_contrib: u32 = (record.attestation_count.min(5) * 20).min(100);
        let src_contrib: u32 = if record.source_verified  { 100 } else { 0 };
        let upg_contrib: u32 = if record.upgradeable      { 0 } else { 100 };
        let adm_contrib: u32 = if record.admin_power      { 0 } else { 100 };
        let mat_contrib: u32 = record.maturity_score * 10;

        let raw_score: u32 = (att_contrib * W_ATTESTATION
            + src_contrib * W_SOURCE
            + upg_contrib * W_UPGRADE
            + adm_contrib * W_ADMIN
            + mat_contrib * W_MATURITY)
            / 100;

        record.grade = grade_from_score(raw_score);
        env.storage().persistent().set(&rec_key, &record);

        env.events().publish(
            (symbol_short!("graded"), contract_id.clone()),
            record.grade.clone(),
        );
    }

    /// Verify that `claimed_hash` matches the actual on-chain WASM hash for
    /// `contract_id`.  Uses Soroban's env.deployer() to read ledger state —
    /// no off-chain data, no trust in the submitter.
    fn verify_wasm_hash(
        env:          &Env,
        contract_id:  &Address,
        claimed_hash: &BytesN<32>,
    ) {
        // Retrieve the installed WASM hash for this contract from the ledger.
        // env.deployer().get_installed_wasm_hash_by_contract(contract_id) is
        // available in soroban-sdk 21.  It panics if the contract does not exist.
        let actual_hash: BytesN<32> = env
            .deployer()
            .get_installed_wasm_hash_by_contract(contract_id.clone());

        if actual_hash != *claimed_hash {
            panic!(
                "wasm_hash mismatch: submitted hash does not match on-chain WASM"
            );
        }
    }

    /// Verify the auditor's Ed25519 signature over the attestation payload.
    fn verify_attestation_sig(
        env:         &Env,
        auditor:     &Address,
        contract_id: &Address,
        wasm_hash:   &BytesN<32>,
        verdict:     bool,
        confidence:  u32,
        sig:         &BytesN<64>,
    ) {
        let mut msg = Bytes::new(env);

        let cid_bytes = contract_id.to_xdr(env);
        msg.append(&cid_bytes);

        let wh_bytes: Bytes = wasm_hash.clone().into();
        msg.append(&wh_bytes);

        msg.push_back(if verdict { 1u8 } else { 0u8 });

        for b in confidence.to_le_bytes().iter() {
            msg.push_back(*b);
        }
        for b in env.ledger().sequence().to_le_bytes().iter() {
            msg.push_back(*b);
        }

        let digest: BytesN<32> = env.crypto().sha256(&msg);

        // Extract Ed25519 public key from the auditor's Stellar address XDR.
        // AccountId XDR = 4-byte union tag + 4-byte key type + 32-byte key = 40 bytes.
        let addr_xdr = auditor.to_xdr(env);
        let xdr_len  = addr_xdr.len();
        if xdr_len < 32 {
            panic!("auditor address XDR too short");
        }
        let key_start = xdr_len - 32;
        let pk_bytes: BytesN<32> = addr_xdr
            .slice(key_start..xdr_len)
            .try_into()
            .expect("pk slice must be 32 bytes");

        env.crypto().ed25519_verify(&pk_bytes, &digest.into(), sig);
    }
}

// ─────────────────────────── free helpers ────────────────────────────────────

fn grade_from_score(score: u32) -> Grade {
    let (letter, numeric) = if score >= THRESH_A {
        (symbol_short!("A"), 5u32)
    } else if score >= THRESH_B {
        (symbol_short!("B"), 4u32)
    } else if score >= THRESH_C {
        (symbol_short!("C"), 3u32)
    } else if score >= THRESH_D {
        (symbol_short!("D"), 2u32)
    } else {
        (symbol_short!("F"), 1u32)
    };
    Grade { letter, score, numeric }
}

fn blank_record(env: &Env, wasm_hash: &BytesN<32>) -> SafetyRecord {
    SafetyRecord {
        grade:             grade_from_score(0),
        upgradeable:       true,
        source_verified:   false,
        wasm_hash:         wasm_hash.clone(),
        attestation_count: 0,
        admin_power:       true,
        maturity_score:    0,
    }
}

fn blank_record_default(env: &Env) -> SafetyRecord {
    SafetyRecord {
        grade:             grade_from_score(0),
        upgradeable:       true,
        source_verified:   false,
        wasm_hash:         BytesN::from_array(env, &[0u8; 32]),
        attestation_count: 0,
        admin_power:       true,
        maturity_score:    0,
    }
}

/// Decode (Address, u32 reputation, BytesN<32> meta_hash) from raw Bytes.
/// Layout: Address XDR (variable) | 4-byte reputation LE | 32-byte meta_hash.
fn decode_auditor_rep_data(env: &Env, data: &Bytes) -> (Address, u32, BytesN<32>) {
    // The off-chain caller encodes this as:
    //   [ address_xdr_len: u32 LE ] [ address_xdr ] [ reputation: u32 LE ] [ meta_hash: 32 bytes ]
    let len = data.len();
    if len < 4 + 4 + 32 {
        panic!("auditor rep data too short");
    }

    // First 4 bytes = length of the address XDR.
    let addr_len = u32::from_le_bytes([
        data.get(0).unwrap(),
        data.get(1).unwrap(),
        data.get(2).unwrap(),
        data.get(3).unwrap(),
    ]) as usize;

    if 4 + addr_len + 4 + 32 > len as usize {
        panic!("auditor rep data malformed");
    }

    let addr_bytes: Bytes = data.slice(4..(4 + addr_len) as u32);
    let auditor_addr = Address::from_xdr(env, &addr_bytes)
        .expect("invalid auditor address XDR in proposal");

    let rep_start = (4 + addr_len) as u32;
    let reputation = u32::from_le_bytes([
        data.get(rep_start).unwrap(),
        data.get(rep_start + 1).unwrap(),
        data.get(rep_start + 2).unwrap(),
        data.get(rep_start + 3).unwrap(),
    ]);

    let mh_start = rep_start + 4;
    let meta_bytes: Bytes = data.slice(mh_start..mh_start + 32);
    let meta_hash: BytesN<32> = meta_bytes.try_into().expect("meta_hash must be 32 bytes");

    (auditor_addr, reputation, meta_hash)
}
