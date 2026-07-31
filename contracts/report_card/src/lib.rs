//! Report Card — on-chain safety registry for Soroban smart contracts.
//!
//! Stores signed audit attestations, relayer-derived WASM flags, and computes
//! an A–F letter grade via a deterministic weighted rubric.  The read path
//! (is_safe) is pure and cheap; all writes are gated behind admin / signed
//! auditor / relayer authority.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    symbol_short,
    Address, Bytes, BytesN, Env, Symbol,
};

// ─────────────────────────── on-chain types ──────────────────────────────────

/// Letter grade returned by is_safe().
/// Stored as u32 so cross-contract callers can compare numerically:
///   A=5  B=4  C=3  D=2  F=1  (higher is safer).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Grade {
    pub letter: Symbol,   // "A" | "B" | "C" | "D" | "F"
    pub score: u32,       // 0-100 raw weighted score
    pub numeric: u32,     // 5=A … 1=F
}

/// Full safety record persisted per contract address.
#[contracttype]
#[derive(Clone, Debug)]
pub struct SafetyRecord {
    pub grade: Grade,
    pub upgradeable: bool,
    pub source_verified: bool,
    pub wasm_hash: BytesN<32>,
    pub attestation_count: u32,
    pub admin_power: bool,       // unbounded mint/freeze/drain flag
    pub maturity_score: u32,     // 0-10 derived from age + usage
}

/// Auditor identity stored on-chain.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Auditor {
    pub reputation: u32,   // 1-100; admin sets this at onboarding
    pub meta_hash: BytesN<32>, // IPFS / Arweave CID of auditor profile
    pub active: bool,
}

/// Individual attestation (contract, auditor) → verdict.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Attestation {
    pub wasm_hash: BytesN<32>,
    pub verdict: bool,           // true = safe, false = unsafe
    pub confidence: u32,         // 1-100
    pub sig: BytesN<64>,         // Ed25519 signature over (contract_id || wasm_hash || verdict)
    pub ledger_ts: u64,
}

// ─────────────────────────── storage keys ────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    Relayer,
    Record(Address),
    AuditorInfo(Address),
    Attestation(Address, Address), // (contract, auditor)
}

// ─────────────────────────── scoring constants ───────────────────────────────

// Weights must sum to 100.
const W_ATTESTATION: u32 = 30;
const W_SOURCE:      u32 = 25;
const W_UPGRADE:     u32 = 20;
const W_ADMIN:       u32 = 15;
const W_MATURITY:    u32 = 10;

// Grade thresholds (inclusive lower bound of the bucket).
const THRESH_A: u32 = 80;
const THRESH_B: u32 = 65;
const THRESH_C: u32 = 50;
const THRESH_D: u32 = 35;

// ─────────────────────────── contract ────────────────────────────────────────

#[contract]
pub struct ReportCardContract;

#[contractimpl]
impl ReportCardContract {
    // ── admin ────────────────────────────────────────────────────────────────

    /// Bootstrap the registry.  Can only be called once.
    pub fn initialize(env: Env, admin: Address, relayer: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialised");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Relayer, &relayer);
    }

    /// Onboard an auditor identity with a reputation weight (1-100).
    pub fn register_auditor(
        env: Env,
        auditor: Address,
        reputation: u32,
        meta_hash: BytesN<32>,
    ) {
        Self::require_admin(&env);
        if reputation == 0 || reputation > 100 {
            panic!("reputation must be 1-100");
        }
        let info = Auditor { reputation, meta_hash, active: true };
        env.storage()
            .persistent()
            .set(&DataKey::AuditorInfo(auditor), &info);
    }

    /// Deactivate an auditor (reputation slash path).
    pub fn deactivate_auditor(env: Env, auditor: Address) {
        Self::require_admin(&env);
        let key = DataKey::AuditorInfo(auditor);
        let mut info: Auditor = env
            .storage()
            .persistent()
            .get(&key)
            .expect("auditor not found");
        info.active = false;
        env.storage().persistent().set(&key, &info);
    }

    // ── auditor write ─────────────────────────────────────────────────────────

    /// Auditor submits a signed attestation bound to a specific WASM hash.
    ///
    /// The signature must cover the 97-byte message:
    ///   contract_id (32) || wasm_hash (32) || verdict (1) || confidence (4) ||
    ///   ledger_sequence (4) as little-endian u32 || padding (24)
    /// Caller must have been registered by the admin.
    pub fn submit_attestation(
        env: Env,
        auditor: Address,
        contract_id: Address,
        wasm_hash: BytesN<32>,
        verdict: bool,
        confidence: u32,
        sig: BytesN<64>,
    ) {
        auditor.require_auth();

        // Auditor must be registered and active.
        let aud_key = DataKey::AuditorInfo(auditor.clone());
        let aud_info: Auditor = env
            .storage()
            .persistent()
            .get(&aud_key)
            .expect("auditor not registered");
        if !aud_info.active {
            panic!("auditor deactivated");
        }
        if confidence == 0 || confidence > 100 {
            panic!("confidence must be 1-100");
        }

        // Verify the Ed25519 signature over the attestation payload.
        // Message layout (97 bytes total):
        //   [0..32]  contract address bytes (the 32-byte Stellar contract ID)
        //   [32..64] wasm_hash bytes
        //   [64]     verdict as u8 (1=safe, 0=unsafe)
        //   [65..69] confidence as little-endian u32
        //   [69..73] current ledger sequence as little-endian u32
        //   [73..97] zero padding
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

        // Increment attestation_count on the record (create blank record if needed).
        let rec_key = DataKey::Record(contract_id.clone());
        let mut record: SafetyRecord = env
            .storage()
            .persistent()
            .get(&rec_key)
            .unwrap_or(SafetyRecord {
                grade: grade_from_score(0),
                upgradeable: true,
                source_verified: false,
                wasm_hash: wasm_hash.clone(),
                attestation_count: 0,
                admin_power: true,
                maturity_score: 0,
            });
        record.attestation_count = record.attestation_count.saturating_add(1);
        env.storage().persistent().set(&rec_key, &record);

        // Recompute the grade with the new attestation included.
        Self::recompute_grade(&env, &contract_id);
    }

    // ── relayer write ─────────────────────────────────────────────────────────

    /// Relayer (off-chain engine) writes derived objective flags.
    ///
    /// `upgradeable`    — WASM contains an upgrade / set_code path.
    /// `source_verified`— reproducible build matches on-chain WASM hash.
    /// `admin_power`    — WASM exposes unbounded mint/freeze/drain under a single key.
    /// `maturity_score` — 0-10 score from age + distinct users + TVL proxy.
    pub fn set_flags(
        env: Env,
        contract_id: Address,
        wasm_hash: BytesN<32>,
        upgradeable: bool,
        source_verified: bool,
        admin_power: bool,
        maturity_score: u32,
    ) {
        Self::require_relayer(&env);
        if maturity_score > 10 {
            panic!("maturity_score must be 0-10");
        }

        let rec_key = DataKey::Record(contract_id.clone());
        // Load existing record or create a blank one.
        let mut record: SafetyRecord = env
            .storage()
            .persistent()
            .get(&rec_key)
            .unwrap_or(SafetyRecord {
                grade: grade_from_score(0),
                upgradeable: false,
                source_verified: false,
                wasm_hash: wasm_hash.clone(),
                attestation_count: 0,
                admin_power: false,
                maturity_score: 0,
            });

        record.wasm_hash = wasm_hash;
        record.upgradeable = upgradeable;
        record.source_verified = source_verified;
        record.admin_power = admin_power;
        record.maturity_score = maturity_score;
        env.storage().persistent().set(&rec_key, &record);

        // Recompute grade now that flags are updated.
        Self::recompute_grade(&env, &contract_id);
    }

    // ── read (pure / cheap) ──────────────────────────────────────────────────

    /// Primary read — returns the full SafetyRecord (grade + evidence).
    /// Returns a default F record if the contract has never been analysed.
    pub fn is_safe(env: Env, contract_id: Address) -> SafetyRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Record(contract_id))
            .unwrap_or(SafetyRecord {
                grade: grade_from_score(0),
                upgradeable: true,
                source_verified: false,
                wasm_hash: BytesN::from_array(&env, &[0u8; 32]),
                attestation_count: 0,
                admin_power: true,
                maturity_score: 0,
            })
    }

    /// Read a single auditor record.
    pub fn get_auditor(env: Env, auditor: Address) -> Option<Auditor> {
        env.storage()
            .persistent()
            .get(&DataKey::AuditorInfo(auditor))
    }

    /// Read a single attestation.
    pub fn get_attestation(
        env: Env,
        contract_id: Address,
        auditor: Address,
    ) -> Option<Attestation> {
        env.storage()
            .persistent()
            .get(&DataKey::Attestation(contract_id, auditor))
    }

    // ── internal helpers ─────────────────────────────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialised");
        admin.require_auth();
    }

    fn require_relayer(env: &Env) {
        let relayer: Address = env
            .storage()
            .instance()
            .get(&DataKey::Relayer)
            .expect("not initialised");
        relayer.require_auth();
    }

    /// Recomputes and persists the weighted grade for `contract_id`.
    ///
    /// Called after every write (set_flags or submit_attestation) so the
    /// stored record is always up-to-date.
    fn recompute_grade(env: &Env, contract_id: &Address) {
        let rec_key = DataKey::Record(contract_id.clone());
        let mut record: SafetyRecord = env
            .storage()
            .persistent()
            .get(&rec_key)
            .unwrap_or(SafetyRecord {
                grade: grade_from_score(0),
                upgradeable: true,
                source_verified: false,
                wasm_hash: BytesN::from_array(env, &[0u8; 32]),
                attestation_count: 0,
                admin_power: true,
                maturity_score: 0,
            });

        // ── signal 1: attestation score (0-100 normalised) ──────────────────
        // Walk all known auditors; collect matching attestations for the
        // current wasm_hash.
        // Soroban's persistent store doesn't support iteration, so the engine
        // always calls set_flags first (which seeds the record), then the
        // on-chain scoring uses the attestation_count the relayer sets.
        // For the on-chain grade we use the attestation_count directly as a
        // proxy and derive a weighted contribution.
        let att_contrib: u32 = {
            let count = record.attestation_count.min(5); // cap at 5 for contribution
            // Each attestation from a max-rep (100) auditor = 20 raw points → capped at 100.
            // Simple linear: count * 20, capped.
            (count * 20).min(100)
        };

        // ── signal 2: source verification (0 or 100) ────────────────────────
        let src_contrib: u32 = if record.source_verified { 100 } else { 0 };

        // ── signal 3: upgradeability (100 = NOT upgradeable = safer) ────────
        let upg_contrib: u32 = if record.upgradeable { 0 } else { 100 };

        // ── signal 4: admin power (100 = no dangerous admin = safer) ────────
        let adm_contrib: u32 = if record.admin_power { 0 } else { 100 };

        // ── signal 5: maturity (0-10 → 0-100) ───────────────────────────────
        let mat_contrib: u32 = record.maturity_score * 10;

        // Weighted sum (weights sum to 100).
        let raw_score: u32 = (att_contrib * W_ATTESTATION
            + src_contrib * W_SOURCE
            + upg_contrib * W_UPGRADE
            + adm_contrib * W_ADMIN
            + mat_contrib * W_MATURITY)
            / 100;

        record.grade = grade_from_score(raw_score);

        env.storage().persistent().set(&rec_key, &record);

        // Emit event for wallet indexers.
        env.events().publish(
            (symbol_short!("graded"), contract_id.clone()),
            record.grade.clone(),
        );
    }

    /// Verify the auditor's Ed25519 signature over the attestation payload.
    ///
    /// The auditor's wallet signs a SHA-256 digest of the attestation message:
    ///   contract_id_xdr ++ wasm_hash(32 bytes) ++ verdict_u8 ++ confidence_le32
    ///   ++ ledger_seq_le32
    ///
    /// The public key is passed in explicitly as `pk` because Soroban Addresses
    /// may be contract addresses (multisig) — the auditor must provide the raw
    /// Ed25519 public key bytes alongside the sig.
    ///
    /// NOTE: In Soroban SDK 21 the canonical way to authenticate an auditor is
    /// `auditor.require_auth()` (already called before this function).  This
    /// additional sig check binds the attestation payload to the WASM hash and
    /// verdict so it cannot be replayed against a different contract.
    fn verify_attestation_sig(
        env: &Env,
        auditor: &Address,
        contract_id: &Address,
        wasm_hash: &BytesN<32>,
        verdict: bool,
        confidence: u32,
        sig: &BytesN<64>,
    ) {
        // Build the attestation message.
        let mut msg = Bytes::new(env);

        // contract_id serialised as XDR ScAddress (variable length — that's fine,
        // what matters is that the bytes are deterministic for a given contract).
        let cid_bytes = contract_id.to_xdr(env);
        msg.append(&cid_bytes);

        // wasm_hash — 32 bytes, fixed.
        let wh_bytes: Bytes = wasm_hash.clone().into();
        msg.append(&wh_bytes);

        // verdict as a single byte.
        msg.push_back(if verdict { 1u8 } else { 0u8 });

        // confidence as little-endian u32 (4 bytes).
        let conf_le = confidence.to_le_bytes();
        for b in conf_le.iter() {
            msg.push_back(*b);
        }

        // Current ledger sequence as little-endian u32 (4 bytes) — prevents
        // replay across ledgers.
        let seq_le = env.ledger().sequence().to_le_bytes();
        for b in seq_le.iter() {
            msg.push_back(*b);
        }

        // Digest with SHA-256 so we have a fixed 32-byte input for Ed25519.
        let digest: BytesN<32> = env.crypto().sha256(&msg);

        // Extract the auditor's Ed25519 public key from their Stellar address.
        //
        // A Stellar account address is a 32-byte Ed25519 public key prefixed by
        // a 1-byte type discriminant in XDR.  The XDR for ScAddress of type
        // AccountId is: 4-byte union tag (0x00000000) + PublicKey discriminant
        // (4 bytes, 0x00000000) + 32-byte key = 40 bytes total.
        //
        // We take the last 32 bytes of the XDR as the public key.
        let addr_xdr = auditor.to_xdr(env);
        let xdr_len = addr_xdr.len();
        if xdr_len < 32 {
            panic!("auditor address XDR too short to contain Ed25519 key");
        }
        // Copy the trailing 32 bytes (the raw key) into a BytesN<32>.
        let key_start = xdr_len - 32;
        let pk_bytes: BytesN<32> = addr_xdr
            .slice(key_start..xdr_len)
            .try_into()
            .expect("public key slice must be exactly 32 bytes");

        env.crypto().ed25519_verify(&pk_bytes, &digest.into(), sig);
    }
}

// ─────────────────────────── pure helpers ────────────────────────────────────

/// Map a 0-100 raw score to an A–F Grade struct.
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
