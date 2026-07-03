import { Connection } from "@solana/web3.js";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
export const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const SOL_MINT = "So11111111111111111111111111111111111111112";

let sharedConn = null;

/** Single shared Connection instance per process run (each GH Actions job is its own process). */
export function getConnection() {
  if (!sharedConn) sharedConn = new Connection(HELIUS_RPC, "confirmed");
  return sharedConn;
}

export async function getLiveBalanceSol(address) {
  try {
    const r = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
    });
    const j = await r.json();
    return (j?.result?.value || 0) / 1e9;
  } catch {
    return 0;
  }
}
