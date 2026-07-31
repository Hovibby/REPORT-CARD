"use client";

/**
 * useWallet.ts
 *
 * React hook that manages the stellar-wallets-kit instance and the connected
 * wallet address. Compatible with @creit.tech/stellar-wallets-kit v2.x.
 *
 * Returns a typed WalletKit so callers (e.g. the auditor portal) can pass it
 * directly to submitAttestation() without a cast.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { WalletKit } from "@reportcard/types";

// Re-export so consumers can import the type from here too.
export type { WalletKit };

export interface UseWalletResult {
  /** Connected wallet address, null when not connected. */
  address: string | null;
  /** The wallet kit instance, null until the browser module has loaded. */
  kit: WalletKit | null;
  /** Open the wallet-selection modal. */
  connect: () => Promise<void>;
  /** Disconnect and clear the stored address. */
  disconnect: () => void;
}

export function useWallet(): UseWalletResult {
  const [address, setAddress] = useState<string | null>(null);
  const [kit, setKit] = useState<WalletKit | null>(null);

  // Keep a stable ref so connect() always sees the latest instance without
  // being listed as a dependency.
  const kitRef = useRef<WalletKit | null>(null);

  // Lazily load stellar-wallets-kit on the client only (it uses window APIs
  // that are not available in SSR / Edge runtime).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mod = await import("@creit.tech/stellar-wallets-kit");
        if (cancelled) return;

        const { StellarWalletsKit, FREIGHTER_ID } = mod;
        const network = (
          process.env.NEXT_PUBLIC_NETWORK?.toUpperCase() === "PUBLIC"
            ? "PUBLIC"
            : "TESTNET"
        ) as "TESTNET" | "PUBLIC";

        // allowAllModules is available in v2; fall back to empty array if absent.
        const modules =
          typeof mod.allowAllModules === "function"
            ? mod.allowAllModules()
            : [];

        const instance = new StellarWalletsKit({
          network: network as never, // cast: kit's WalletNetwork enum varies by version
          selectedWalletId: FREIGHTER_ID,
          modules,
        });

        // Cast to our structural WalletKit interface — we only need signTransaction.
        kitRef.current = instance as unknown as WalletKit;
        setKit(kitRef.current);

        // Restore previously connected address from sessionStorage.
        const saved = sessionStorage.getItem("rc_wallet_address");
        if (saved) setAddress(saved);
      } catch (e) {
        console.warn("[useWallet] stellar-wallets-kit failed to initialise:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    if (!kitRef.current) return;

    // Access openModal via the raw instance (not the WalletKit interface, which
    // only exposes signTransaction). Cast through unknown to avoid importing the
    // full kit type.
    const raw = kitRef.current as unknown as {
      openModal(opts: {
        onWalletSelected: (opt: { id: string }) => void;
      }): Promise<void>;
      setWallet(id: string): void;
      getAddress(): Promise<{ address: string }>;
    };

    await raw.openModal({
      onWalletSelected: async (option) => {
        raw.setWallet(option.id);
        const { address: addr } = await raw.getAddress();
        setAddress(addr);
        sessionStorage.setItem("rc_wallet_address", addr);
      },
    });
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    sessionStorage.removeItem("rc_wallet_address");
  }, []);

  return { address, kit, connect, disconnect };
}
