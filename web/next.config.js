/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow Next.js to transpile workspace packages that ship raw TypeScript
  // (no separate build step required).
  transpilePackages: ["@reportcard/types"],

  // Prevent Next.js from bundling @stellar/stellar-sdk on the server —
  // it contains native bindings that must run in Node.js directly.
  experimental: {
    serverComponentsExternalPackages: ["@stellar/stellar-sdk"],
  },

  env: {
    NEXT_PUBLIC_NETWORK:
      process.env.NEXT_PUBLIC_NETWORK ?? "testnet",
    NEXT_PUBLIC_REGISTRY_CONTRACT_ID:
      process.env.NEXT_PUBLIC_REGISTRY_CONTRACT_ID ?? "",
    NEXT_PUBLIC_SOROBAN_RPC_URL:
      process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
      "https://soroban-testnet.stellar.org",
    NEXT_PUBLIC_HORIZON_URL:
      process.env.NEXT_PUBLIC_HORIZON_URL ??
      "https://horizon-testnet.stellar.org",
  },
};

module.exports = nextConfig;
