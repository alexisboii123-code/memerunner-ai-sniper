import { VersionedTransaction, Transaction, SystemProgram, PublicKey } from "@solana/web3.js";
import tradingParams from "../../config/trading_params.json" with { type: "json" };
import { getConnection, HELIUS_RPC } from "./rpcClient.js";

const { slippageBps, priorityFeeLamports, confirmTimeoutMs, skipPreflight } = tradingParams.execution;

async function getQuote(inputMint, outputMint, amount) {
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`quote_${resp.status}: ${await resp.text()}`);
  return resp.json();
}

/** Poll getSignatureStatus until confirmed/finalized, a hard error, or timeout. */
export async function confirmTx(conn, sig, maxMs = confirmTimeoutMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const status = await conn.getSignatureStatus(sig);
      const conf = status?.value?.confirmationStatus;
      if (conf === "confirmed" || conf === "finalized") return true;
      if (status?.value?.err) return false;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Executes a real on-chain swap via Jupiter, waits for genuine confirmation
 * (not just an accepted tx_hash — skipPreflight lets doomed txs through the
 * RPC, so err===null AND confirmed status are both required before a caller
 * should ever treat this as a completed trade).
 *
 * opts.priorityFeeLamports: override the default config priority fee for
 * time-sensitive entries (e.g. fresh-snipe buys racing to land fast). Note:
 * this is Jupiter's own prioritization-fee param routed through Helius RPC —
 * it is NOT a hand-built Jito bundle. A true custom Jito bundle (tip tx +
 * swap tx submitted together to the Jito Block Engine) would be a further
 * upgrade if landing speed is still a bottleneck after this.
 */
export async function executeSwap(keypair, inputMint, outputMint, amountLamports, opts = {}) {
  try {
    const conn = getConnection();
    const quote = await getQuote(inputMint, outputMint, amountLamports);
    if (!quote?.outAmount) return { txHash: null, outAmount: "0", err: quote?.error || "no_quote" };

    const swapResp = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: opts.priorityFeeLamports ?? priorityFeeLamports,
      }),
    });
    if (!swapResp.ok) return { txHash: null, outAmount: "0", err: `swap_${swapResp.status}: ${await swapResp.text()}` };
    const { swapTransaction } = await swapResp.json();
    if (!swapTransaction) return { txHash: null, outAmount: "0", err: "no_swap_tx" };

    const vtx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    vtx.sign([keypair]);
    const encoded = Buffer.from(vtx.serialize()).toString("base64");

    const res = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "sendTransaction",
        params: [encoded, { encoding: "base64", skipPreflight, maxRetries: 3 }],
      }),
    });
    const j = await res.json();
    if (j.error) return { txHash: null, outAmount: "0", err: j.error };
    const txHash = j.result;
    const confirmed = await confirmTx(conn, txHash);
    return { txHash, outAmount: quote.outAmount, err: confirmed ? null : "unconfirmed_but_sent" };
  } catch (e) {
    return { txHash: null, outAmount: "0", err: e?.message || "exception" };
  }
}

/** Real SOL transfer used for the automatic profit-vault sweep. */
export async function sweepToVault(conn, keypair, lamports, vaultAddress) {
  try {
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new Transaction({ feePayer: keypair.publicKey, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(vaultAddress), lamports })
    );
    tx.sign(keypair);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight, maxRetries: 3 });
    const confirmed = await confirmTx(conn, sig, 30_000);
    return { sig, err: confirmed ? null : "unconfirmed_but_sent" };
  } catch (e) {
    return { sig: null, err: e?.message || "exception" };
  }
}

/** Program-agnostic on-chain balance lookup (classic SPL + Token-2022) for stale-price force-exits. */
export async function getOnChainTokenBalance(conn, owner, mint) {
  try {
    const resp = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
    if (!resp.value.length) return 0;
    const amt = resp.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
    return amt ? parseInt(amt) : 0;
  } catch {
    return 0;
  }
}
