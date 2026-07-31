/**
 * seedAttestations.ts — Static attestation data for the demo.
 * License: CC-BY-4.0
 */

const seedAttestations: Record<
  string,
  Array<{
    auditorAddress: string;
    verdict: boolean;
    confidence: number;
    wasmHash: string;
  }>
> = {
  // grade A — audited, source-verified
  CDEMOSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA: [
    {
      auditorAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      verdict: true,
      confidence: 95,
      wasmHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    {
      auditorAddress: "GBCR5OHL3PTFD3FQV7CGKBCBW5LOR3J6E3SUVMTJVRGR4HTXRM4NKQY",
      verdict: true,
      confidence: 90,
      wasmHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  ],

  // grade D — upgradeable, no attestations
  CDEMODAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA: [],

  // grade B — one attestation, source verified
  CDEMOBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA: [
    {
      auditorAddress: "GD6WNTESP5N4RSKGWCMAKZQNHLPOZN4HYR3HV5JKWGLXD3VRWNUF3JX",
      verdict: true,
      confidence: 80,
      wasmHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  ],
};

export default seedAttestations;
