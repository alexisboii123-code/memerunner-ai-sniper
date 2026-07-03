import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import tradingParams from "../config/trading_params.json" with { type: "json" };
import { rugScan, checkMintSafety, checkHolderConcentration, getTokenPrice } from "./sniperEngine.js";
import { executeSwap, getOnChainTokenBalance, sweepToVault, confirmTx } from "./utils/transaction.js";
import { getConnection, SOL_MINT } from "./utils/rpcClient.js";
import { logEvent } from "./utils/logger.js";

const { takeProfitTiers, trailingStop, hardStopLossPct, maxHoldMinutes, moonTpPct, profitSweep } = tradingParams;
const MAX_HOLD_MS = maxHoldMinutes * 60_000;

const SCALP = takeProfitTiers[0];
const TIER1 = takeProfitTiers[1];
const TIER2 = takeProfitTiers[2];

async function doProfitSweep(conn, keypair, pnlSol, exitLog) {
  if (!profitSweep.enabled || pnlSol < profitSweep.minSweepSol) return;
  const sweepLamports = Math.floor(pnlSol * profitSweep.sweepPctOfRealizedGain * 1e9);
  if (sweepLamports <= 0) return;
  const { sig, err } = await sweepToVault(conn, keypair, sweepLamports, profitSweep.vaultAddress);
  exitLog.profitSwept = sweepLamports / 1e9;
  exitLog.sweepTx = sig;
  exitLog.sweepErr = err;
}

/**
 * Checks every currently-open position once. Handles the scalp-first tiered
 * take-profit ladder, trailing stop, hard SL, max hold, rug re-checks, and the
 * stale-price on-chain-balance force-exit fallback. Positions are tracked
 * externally in `positions` (an in-memory/persisted map keyed by token
 * address) since this standalone script has no Base44 entity store — see
 * index.js for how positions get created/persisted across cycles.
 */
export async function checkPosition(position, wallet) {
  const conn = getConnection();
  const raw = process.env[wallet.keyEnv];
  if (!raw) return { action: "error", error: `missing_key_${wallet.keyEnv}` };
  const keypair = Keypair.fromSecretKey(bs58.decode(raw));

  const pair = await getTokenPrice(position.tokenAddress);

  // ── Stale price + past max hold → force-exit via real on-chain balance ──
  if (!pair) {
    const staleMs = Date.now() - new Date(position.entryTimestamp).getTime();
    if (staleMs < MAX_HOLD_MS) return { action: "skip_no_price" };

    const onChainAmt = await getOnChainTokenBalance(conn, keypair.publicKey, position.tokenAddress);
    if (onChainAmt <= 0) {
      logEvent({ type: "exit", wallet: wallet.label, token: position.tokenSymbol, pnlSol: -(position.amountSol || 0), reason: "STALE_PRICE_ZERO_BALANCE" });
      return { action: "closed_zero_balance_stale" };
    }
    const { txHash, outAmount, err } = await executeSwap(keypair, position.tokenAddress, SOL_MINT, onChainAmt);
    const confirmed = !!txHash && err === null;
    const outSol = confirmed ? parseInt(outAmount) / 1e9 : 0;
    const pnlSol = confirmed ? outSol - (position.amountSol || 0) : 0;
    if (confirmed) {
      const exitLog = { type: "exit", wallet: wallet.label, token: position.tokenSymbol, pnlSol, reason: "STALE_PRICE_FORCE_EXIT", txHash };
      await doProfitSweep(conn, keypair, pnlSol, exitLog);
      logEvent(exitLog);
      return { action: "closed", pnlSol };
    }
    return { action: "retry_next_cycle", err };
  }

  const currentPrice = parseFloat(pair.priceUsd || "0");
  const entryPrice = position.entryPrice || currentPrice;
  const pnlPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
  const holdMs = Date.now() - new Date(position.entryTimestamp).getTime();

  const rug = rugScan(pair, { skipAgeCheck: true });
  const mintSafety = await checkMintSafety(conn, position.tokenAddress);
  if (!mintSafety.safe) { rug.safe = false; rug.flags.push(...mintSafety.flags); }
  const holderCheck = await checkHolderConcentration(conn, position.tokenAddress, pair?.pairAddress);
  if (!holderCheck.safe) { rug.safe = false; rug.flags.push(...holderCheck.flags); }

  position.peakPrice = Math.max(position.peakPrice || entryPrice, currentPrice);
  const trailDrawdown = position.peakPrice > 0 ? ((position.peakPrice - currentPrice) / position.peakPrice) * 100 : 0;

  // ── v7.5 scalp-first tiered take-profit: fractions are of whatever
  // remains at trigger time, so SCALP+TIER1+TIER2 can never exceed 100%. ──
  let tier = null;
  if (rug.safe && !position.scalpDone && pnlPct >= SCALP.triggerPct) tier = { ...SCALP, tag: "SCALP_TP" };
  else if (rug.safe && position.scalpDone && !position.tier1Done && pnlPct >= TIER1.triggerPct) tier = { ...TIER1, tag: "TIER1_TP" };
  else if (rug.safe && position.tier1Done && !position.tier2Done && pnlPct >= TIER2.triggerPct) tier = { ...TIER2, tag: "TIER2_TP" };

  if (tier) {
    const fullTokenAmount = Math.floor(position.tokenAmount || 0);
    const tierTokens = Math.min(Math.floor(fullTokenAmount * tier.sellFracOfRemaining), fullTokenAmount);
    if (tierTokens > 0) {
      const { txHash, outAmount, err } = await executeSwap(keypair, position.tokenAddress, SOL_MINT, tierTokens);
      if (txHash) {
        const tierOutSol = parseInt(outAmount) / 1e9;
        const costBasis = (position.amountSol || 0) * tier.sellFracOfRemaining;
        const tierPnlSol = tierOutSol - costBasis;

        const tierLog = { type: "exit", wallet: wallet.label, token: position.tokenSymbol, pnlSol: tierPnlSol, reason: tier.tag, txHash };
        await doProfitSweep(conn, keypair, tierPnlSol, tierLog);
        logEvent(tierLog);

        if (tier.tag === "SCALP_TP") position.scalpDone = true;
        else if (tier.tag === "TIER1_TP") position.tier1Done = true;
        else position.tier2Done = true;

        position.tokenAmount = fullTokenAmount - tierTokens;
        position.amountSol = (position.amountSol || 0) - costBasis;
      } else {
        logEvent({ type: "error", wallet: wallet.label, token: position.tokenSymbol, action: "tier_exit_failed", tier: tier.tag, err });
      }
    }
  }

  let exitReason = null;
  if (!rug.safe) exitReason = "RUG_ALERT_" + rug.flags.join(",");
  else if (pnlPct >= moonTpPct) exitReason = "MOON_TP";
  else if (pnlPct >= trailingStop.armAtPct && trailDrawdown >= trailingStop.pullbackPct) exitReason = "TRAILING_STOP";
  else if (pnlPct <= hardStopLossPct) exitReason = "HARD_SL";
  else if (holdMs >= MAX_HOLD_MS) exitReason = "MAX_HOLD_TIME";

  if (!exitReason) return { action: "hold", pnlPct, position };

  const tokenAmount = Math.floor(position.tokenAmount || 0);
  if (tokenAmount <= 0) return { action: "already_flat", position };

  const { txHash, outAmount, err } = await executeSwap(keypair, position.tokenAddress, SOL_MINT, tokenAmount);
  const confirmed = !!txHash && err === null;
  const outSol = confirmed ? parseInt(outAmount) / 1e9 : 0;
  const pnlSol = confirmed ? outSol - position.amountSol : 0;

  if (!confirmed) {
    logEvent({ type: "error", wallet: wallet.label, token: position.tokenSymbol, action: "exit_not_confirmed", reason: exitReason, txHash, err });
    return { action: "retry_next_cycle", position };
  }

  const exitLog = { type: "exit", wallet: wallet.label, token: position.tokenSymbol, pnlSol, pnlPct, reason: exitReason, txHash };
  await doProfitSweep(conn, keypair, pnlSol, exitLog);
  logEvent(exitLog);
  return { action: "closed", pnlSol, position: null };
}

/** Sleep helper used by the internal high-frequency polling loop in index.js. */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
