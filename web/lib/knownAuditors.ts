/**
 * knownAuditors.ts — Static list of demo auditors for the seed dataset.
 * In production this is populated from the on-chain Auditor map.
 */

export interface KnownAuditor {
  address: string;
  name: string;
  reputation: number;
  url?: string;
}

const knownAuditors: KnownAuditor[] = [
  {
    address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    name: "Stellar Security Labs",
    reputation: 90,
    url: "https://example.com/stellar-security-labs",
  },
  {
    address: "GBCR5OHL3PTFD3FQV7CGKBCBW5LOR3J6E3SUVMTJVRGR4HTXRM4NKQY",
    name: "OtterSec",
    reputation: 95,
    url: "https://osec.io",
  },
  {
    address: "GD6WNTESP5N4RSKGWCMAKZQNHLPOZN4HYR3HV5JKWGLXD3VRWNUF3JX",
    name: "Kudelski Security",
    reputation: 85,
  },
];

export default knownAuditors;
