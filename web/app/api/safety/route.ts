/**
 * GET /api/safety?id=<contractId>
 *
 * Thin API route that calls the on-chain is_safe() and returns JSON.
 * Used by the SDK and external wallets that prefer HTTP over direct RPC.
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchSafetyRecord } from "@/lib/registry";

export async function GET(request: NextRequest) {
  const contractId = request.nextUrl.searchParams.get("id");

  if (!contractId) {
    return NextResponse.json(
      { error: "Missing query parameter: id" },
      { status: 400 }
    );
  }

  // Validate Stellar contract ID: starts with C, exactly 56 characters,
  // alphanumeric (we accept the full base32 charset plus digits for demo IDs).
  if (!contractId.startsWith("C") || contractId.length !== 56 || !/^[A-Z2-9]{56}$/.test(contractId)) {
    return NextResponse.json(
      { error: "Invalid contract ID — must be a 56-character Stellar contract StrKey starting with C." },
      { status: 400 }
    );
  }

  try {
    const record = await fetchSafetyRecord(contractId);
    return NextResponse.json(
      { contractId, record },
      {
        status: 200,
        headers: {
          // Allow wallets and dApps to call this from any origin.
          "Access-Control-Allow-Origin": "*",
          // Cache for 30 s on CDN edges — fast enough for pre-sign checks.
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
        },
      }
    );
  } catch (err) {
    console.error("[api/safety] Error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch safety record.",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
