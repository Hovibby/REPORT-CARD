"use client";

import { useWallet } from "@/lib/useWallet";

export default function WalletButton() {
  const { address, connect, disconnect } = useWallet();

  if (address) {
    return (
      <button
        onClick={disconnect}
        className="text-sm font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg px-4 py-2 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500"
        aria-label={`Disconnect wallet (${address.slice(0, 8)}…)`}
      >
        Disconnect
      </button>
    );
  }

  return (
    <button
      onClick={connect}
      className="text-sm font-medium bg-brand-600 hover:bg-brand-500 text-white rounded-lg px-4 py-2 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500"
      aria-label="Connect wallet"
    >
      Connect wallet
    </button>
  );
}
