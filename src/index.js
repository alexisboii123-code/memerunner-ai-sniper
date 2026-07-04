import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import walletsConfig from "../config/wallets.json" with { type: "json" };
import filters from "../config/filters.json" with { type: "json" };
import tradingParams from "../config/trading_params.json" with { type: "json" };

import { checkPosition, sleep } from "./exitMonitor.js";
import { fetchCandidates, quantumScore, checkMintSafety, checkHolderConcentration, getTokenPrice } from "./sniperEngine.js";
import { executeSwap } from "./utils/transaction.js";
import { getLiveBalanceSol, SOL_MINT } from "./utils/rpcClient.js";
import { logEvent } from "./utils/logger.js";
import { runPatternAnalysis } from "./patternAnalyzer.js";

const DRY_RUN = process.env.DRY_RUN === "true";
const POSITIONS_FILE = path.resolve("logs/open_positions.json");
const { internalExitPollSeconds, internalPollWindowMinutes } = tradingParams.cycle;

function loadPositions() {
  if (!fs.existsSync(POSITIONS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf-8")); } catch { return {}; }
}
function savePositions(positions) {
  fs.mkdirSync(path.dirname(POSITIONS_FILE), { recursive: true });
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

async function runExitPhase(positions) {
  for (const [tokenAddress, position] of Object.entries(positions)) {
    const wallet = walletsConfig.trading_wallets.find((w) => w.index === position.walletIndex);
    if (!wallet) continue;
    if (DRY_RUN) { console.log(`[dry-run] would check exit for ${position.tokenSymbol} on ${wallet.label}`); continue; }

    const result = await checkPosition(position, wallet);
    if (result.action === "closed" || result.action === "closed_zero_balance_stale" || result.action === "already_flat") {
      delete positions[tokenAddress];
    }
    // "hold" / "retry_next_cycle" / "skip_no_price": position object was
    // mutated in place (tier flags, remaining size) — keep it in the map.
  }
  savePositions(positions);
}

/**
 * Tries to have `wallet` (which has a mirrorWalletIndex configured) copy
 * whatever the mirrored wallet is currently holding that this wallet
 * doesn't already hold. Returns true if a mirror buy was placed.
 */
async function tryMirrorEntry(wallet, positions, usedAddrs) {
  const sourcePositions = Object.entries(positions).filter(
    ([, p]) => p.walletIndex === wallet.mirrorWalletIndex
  );
  if (!sourcePositions.length) return false;

  const alreadyHeld = new Set(
    Object.values(positions).filter((p) => p.walletIndex === wallet.index).map((p) => p.tokenAddress)
  );

  for (const [tokenAddress, sourcePos] of sourcePositions) {
    if (alreadyHeld.has(tokenAddress) || usedAddrs.has(tokenAddress)) continue;

    const pair = await getTokenPrice(tokenAddress);
    if (!pair) continue;

    const { getConnection } = await import("./utils/rpcClient.js");
    const conn = getConnection();
    const mintSafety = await checkMintSafety(conn, tokenAddress);
    if (!mintSafety.safe) continue;
    const holderCheck = await checkHolderConcentration(conn, tokenAddress, pair?.pairAddress);
    if (!holderCheck.safe) continue;

    const bal = await getLiveBalanceSol(wallet.address);
    const sizeSol = Math.min(Math.max(bal * wallet.tradeSizePct, wallet.minTradeSol), wallet.maxTradeSol ?? Infinity);
    if (sizeSol > bal - 0.005) { console.log(`${wallet.label}: insufficient balance to mirror (${bal} SOL)`); continue; }

    if (DRY_RUN) {
      console.log(`[dry-run] ${wallet.label} would mirror W${wallet.mirrorWalletIndex}'s ${sourcePos.tokenSymbol} (size ${sizeSol} SOL)`);
      usedAddrs.add(tokenAddress);
      return true;
    }

    const raw = process.env[wallet.keyEnv];
    if (!raw) { console.error(`missing key ${wallet.keyEnv}`); continue; }
    const keypair = Keypair.fromSecretKey(bs58.decode(raw));
    const amountLamports = Math.floor(sizeSol * 1e9);

    const { txHash, outAmount, err } = await executeSwap(keypair, SOL_MINT, tokenAddress, amountLamports);
    const confirmed = !!txHash && err === null;
    usedAddrs.add(tokenAddress);
    if (confirmed) {
      const price = parseFloat(pair.priceUsd || "0");
      positions[tokenAddress] = {
        walletIndex: wallet.index,
        tokenAddress,
        tokenSymbol: pair.baseToken?.symbol || sourcePos.tokenSymbol || "UNK",
        tokenAmount: parseInt(outAmount),
        amountSol: sizeSol,
        entryPrice: price,
        peakPrice: price,
        entryTimestamp: new Date().toISOString(),
        scalpDone: false, tier1Done: false, tier2Done: false,
        strategyUsed: "mirror_w" + wallet.mirrorWalletIndex,
      };
      savePositions(positions);
      logEvent({ type: "entry", wallet: wallet.label, token: pair.baseToken?.symbol, strategy: "mirror_w" + wallet.mirrorWalletIndex, mirroredFrom: sourcePos.tokenSymbol, sizeSol, txHash });
      return true;
    } else {
      logEvent({ type: "error", wallet: wallet.label, action: "mirror_buy_not_confirmed", token: pair.baseToken?.symbol, txHash, err });
      return false;
    }
  }
  return false;
}

async function runEntryPhase(positions) {
  const busyWalletIndexes = new Set(Object.values(positions).map((p) => p.walletIndex));
  const candidates = await fetchCandidates();

  const vettedAddrs = new Set(Object.keys(positions)); // tokens we're already holding count as vetted
  const scored = candidates
    .map((p) => ({ pair: p, score: quantumScore(p, vettedAddrs.has(p?.baseToken?.address)) }))
    .sort((a, b) => b.score - a.score);

  logEvent({ type: "cycle_scan", candidatesScanned: candidates.length, aboveMinGate: scored.filter((c) => c.score >= filters.minMomentum5mPct).length });

  const usedAddrs = new Set();

  for (const wallet of walletsConfig.trading_wallets) {
    if (busyWalletIndexes.has(wallet.index)) { console.log(`${wallet.label} busy — skipping entry scan`); continue; }

    // Mirror-role wallets try to copy the source wallet's open position first
    // (e.g. W8 copying W9, the historically stronger performer) before
    // falling back to their own independent scored scan.
    if (wallet.mirrorWalletIndex) {
      const mirrored = await tryMirrorEntry(wallet, positions, usedAddrs);
      if (mirrored) continue;
      console.log(`${wallet.label}: nothing new to mirror from W${wallet.mirrorWalletIndex} — falling back to independent scan`);
    }

    const gate = wallet.minSignalScore;
    const candidatesForWallet = scored.filter((c) => c.score >= gate && !usedAddrs.has(c.pair.baseToken?.address));

    let pick = null;
    const { getConnection } = await import("./utils/rpcClient.js");
    const conn = getConnection();
    for (const candidate of candidatesForWallet) {
      const mintSafety = await checkMintSafety(conn, candidate.pair.baseToken.address);
      if (!mintSafety.safe) continue;
      const holderCheck = await checkHolderConcentration(conn, candidate.pair.baseToken.address, candidate.pair?.pairAddress);
      if (!holderCheck.safe) continue;
      pick = candidate;
      break;
    }
    if (!pick) { console.log(`${wallet.label}: no signal above gate ${gate}`); continue; }
    usedAddrs.add(pick.pair.baseToken?.address);

    const pair = pick.pair;
    const bal = await getLiveBalanceSol(wallet.address);
    const sizeSol = Math.min(Math.max(bal * wallet.tradeSizePct, wallet.minTradeSol), wallet.maxTradeSol ?? Infinity);
    if (sizeSol > bal - 0.005) { console.log(`${wallet.label}: insufficient balance (${bal} SOL)`); continue; }

    if (DRY_RUN) {
      console.log(`[dry-run] ${wallet.label} would buy ${pair.baseToken?.symbol} (score ${pick.score.toFixed(2)}, size ${sizeSol} SOL)`);
      continue;
    }

    const raw = process.env[wallet.keyEnv];
    if (!raw) { console.error(`missing key ${wallet.keyEnv}`); continue; }
    const keypair = Keypair.fromSecretKey(bs58.decode(raw));
    const amountLamports = Math.floor(sizeSol * 1e9);

    const { txHash, outAmount, err } = await executeSwap(keypair, SOL_MINT, pair.baseToken.address, amountLamports);
    const confirmed = !!txHash && err === null;
    if (confirmed) {
      const price = parseFloat(pair.priceUsd || "0");
      positions[pair.baseToken.address] = {
        walletIndex: wallet.index,
        tokenAddress: pair.baseToken.address,
        tokenSymbol: pair.baseToken?.symbol || "UNK",
        tokenAmount: parseInt(outAmount),
        amountSol: sizeSol,
        entryPrice: price,
        peakPrice: price,
        entryTimestamp: new Date().toISOString(),
        scalpDone: false, tier1Done: false, tier2Done: false,
        strategyUsed: "independent",
      };
      savePositions(positions);
      logEvent({ type: "entry", wallet: wallet.label, token: pair.baseToken?.symbol, strategy: "independent", score: pick.score, sizeSol, txHash });
    } else {
      logEvent({ type: "error", wallet: wallet.label, action: "buy_not_confirmed", token: pair.baseToken?.symbol, txHash, err });
    }
  }
}

async function main() {
  console.log(`MemeRunner AI ${tradingParams.engineVersion} — starting cycle (dryRun=${DRY_RUN})`);
  const windowMs = internalPollWindowMinutes * 60_000;
  const pollMs = internalExitPollSeconds * 1000;
  const deadline = Date.now() + windowMs;

  // High-frequency internal loop: keeps polling open positions every ~1-12s
  // for the rest of this GitHub Actions job, giving near-real-time exit
  // monitoring without needing a permanently-running server.
  let firstPass = true;
  while (Date.now() < deadline) {
    const positions = loadPositions();
    await runExitPhase(positions);

    // Only scan for brand-new entries once per cycle (not every poll tick) —
    // no need to hammer DexScreener every tick for fresh candidates. Mirror
    // checks happen inside runEntryPhase too, but only on this same cadence.
    if (firstPass) {
      await runEntryPhase(loadPositions());
      firstPass = false;
    }

    if (Date.now() + pollMs < deadline) await sleep(pollMs);
    else break;
  }

  const summary = runPatternAnalysis();
  console.log("Cycle complete. Rolling performance summary:", summary);
}

main().catch((e) => {
  console.error("Fatal error in cycle:", e);
  process.exit(1);
});
