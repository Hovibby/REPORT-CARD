/**
 * seedContracts.ts — Static contract list for the dashboard homepage.
 *
 * In production the engine maintains this via a database.
 * For the demo the data lives here.
 *
 * License: CC-BY-4.0
 */

import type { GradeLetter } from "@reportcard/types";

export interface SeedContract {
  contractId: string;        // 56-char Stellar contract ID (C + 55 base32 chars)
  name: string;
  grade: GradeLetter;
  upgradeable: boolean;
  sourceVerified: boolean;
  attestationCount: number;
  description: string;
}

const seedContracts: SeedContract[] = [
  {
    contractId: "CDEMOSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    name: "Demo Safe Token",
    grade: "A",
    upgradeable: false,
    sourceVerified: true,
    attestationCount: 2,
    description: "Audited, source-verified token contract with no upgrade path.",
  },
  {
    contractId: "CDEMODAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    name: "Demo Upgradeable DEX",
    grade: "D",
    upgradeable: true,
    sourceVerified: false,
    attestationCount: 0,
    description: "Unaudited DEX with an admin-controlled upgrade path. High risk.",
  },
  {
    contractId: "CDEMOBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    name: "Demo Lending Protocol",
    grade: "B",
    upgradeable: false,
    sourceVerified: true,
    attestationCount: 1,
    description: "Single auditor attestation, source verified, no upgrade path.",
  },
];

export default seedContracts;
