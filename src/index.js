import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import walletsConfig from "../config/wallets.json" with { type: "json" };
import filters from "../config/filters.json" with { type: "json" };
import tradingParams from "../config/trading_params.json" with { type: "json" };

import { checkPosition, sleep } from "./exitMonitor.js";
import { fetchCandidates, quantumScore, freshSnipeScore, checkMintSafety, checkHolderConcentration, getTokenPrice } from "./sniperEngine.js";
import { executeSwap } from "./utils/transaction.js";
import { getLiveBalanceSol, getConnection, SOL_MINT } from "./utils/rpcClient.js";
import { logEvent } from "./utils/logger.js";
import { runPatternAnalysis } from "./patternAnalyzer.js";
import { startPumpFunListener } from "./pumpfunListener.js";

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
  }
  savePositions(positions);
}

/** W8 (or any wallet with mirrorWalletIndex) copies whatever the mirrored wallet holds that it doesn't already. */
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
        walletIndex: wallet.index, tokenAddress,
        tokenSymbol: pair.baseToken?.symbol || sourcePos.tokenSymbol || "UNK",
        tokenAmount: parseInt(outAmount), amountSol: sizeSol,
        entryPrice: price, peakPrice: price, entryTimestamp: new Date().toISOString(),
        scalpDone: false, tier1Done: false, tier2Done: false,
        strategyUsed: "mirror_w" + wallet.mirrorWalletIndex,
      };
      savePositions(positions);
      logEvent({ type: "entry", wallet: wallet.label, token: pair.baseToken?.symbol, strategy: "mirror_w" + wallet.mirrorWalletIndex, mirroredFrom: sourcePos.tokenSymbol, sizeSol, txHash });
      return true;
    }
    logEvent({ type: "error", wallet: wallet.label, action: "mirror_buy_not_confirmed", token: pair.baseToken?.symbol, txHash, err });
    return false;
  }
  return false;
}

async function runEntryPhase(positions) {
  const busyWalletIndexes = new Set(Object.values(positions).map((p) => p.walletIndex));
  const candidates = await fetchCandidates();

  const vettedAddrs = new Set(Object.keys(positions));
  const scored = candidates
    .map((p) => ({ pair: p, score: quantumScore(p, vettedAddrs.has(p?.baseToken?.address)) }))
    .sort((a, b) => b.score - a.score);

  logEvent({ type: "cycle_scan", candidatesScanned: candidates.length, aboveMinGate: scored.filter((c) => c.score >= filters.minMomentum5mPct).length });

  const usedAddrs = new Set();
  const conn = getConnection();

  for (const wallet of walletsConfig.trading_wallets) {
    if (busyWalletIndexes.has(wallet.index)) { console.log(`${wallet.label} busy — skipping entry scan`); continue; }

    if (wallet.mirrorWalletIndex) {
      const mirrored = await tryMirrorEntry(wallet, positions, usedAddrs);
      if (mirrored) continue;
      console.log(`${wallet.label}: nothing new to mirror from W${wallet.mirrorWalletIndex} — falling back to independent scan`);
    }

    const gate = wallet.minSignalScore;
    const candidatesForWallet = scored.filter((c) => c.score >= gate && !usedAddrs.has(c.pair.baseToken?.address));

    let pick = null;
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
        walletIndex: wallet.index, tokenAddress: pair.baseToken.address,
        tokenSymbol: pair.baseToken?.symbol || "UNK", tokenAmount: parseInt(outAmount), amountSol: sizeSol,
        entryPrice: price, peakPrice: price, entryTimestamp: new Date().toISOString(),
        scalpDone: false, tier1Done: false, tier2Done: false, strategyUsed: "independent",
      };
      savePositions(positions);
      logEvent({ type: "entry", wallet: wallet.label, token: pair.baseToken?.symbol, strategy: "independent", score: pick.score, sizeSol, txHash });
    } else {
      logEvent({ type: "error", wallet: wallet.label, action: "buy_not_confirmed", token: pair.baseToken?.symbol, txHash, err });
    }
  }
}

/**
 * Sniper Mode Priority: real-time pump.fun discovery via the PumpPortal
 * listener. Runs every poll tick (not just once per cycle) so a hot new
 * launch can be caught within seconds of clearing the safety window,
 * instead of waiting for the once-per-cycle DexScreener scan.
 */
async function runFreshSnipePhase(positions, listener) {
  const freshCfg = filters.freshSnipe;
  if (!freshCfg?.enabled || !listener) return;

  const wallets = walletsConfig.trading_wallets.filter((w) => w.freshSnipe);
  if (!wallets.length) return;

  const windowMs = (freshCfg.lowGateWindowSeconds + 120) * 1000; // small buffer past the relaxed window
  const conn = getConnection();

  for (const wallet of wallets) {
    if (Object.values(positions).some((p) => p.walletIndex === wallet.index)) continue; // this wallet busy

    const candidates = listener.getCandidates(15_000, windowMs).sort((a, b) => a.ageMs - b.ageMs);
    if (!candidates.length) continue;

    for (const cand of candidates) {
      const pair = await getTokenPrice(cand.mint);
      if (!pair) continue; // not indexed on DexScreener yet — try again next tick

      const ageSeconds = cand.ageMs / 1000;
      const { score, gateForAge } = freshSnipeScore(pair, ageSeconds, freshCfg);
      const effectiveGate = gateForAge ?? wallet.minSignalScore;
      if (score < effectiveGate) continue;

      const mintSafety = await checkMintSafety(conn, cand.mint);
      if (!mintSafety.safe) continue;
      const holderCheck = await checkHolderConcentration(conn, cand.mint, pair?.pairAddress);
      if (!holderCheck.safe) continue;

      const bal = await getLiveBalanceSol(wallet.address);
      const bigSizeCapSol = wallet.freshSnipeBigSizeCapSol ?? freshCfg.bigSizeCapSol;
      let sizeSol;
      if (ageSeconds >= freshCfg.bigSizeWindowMinSeconds && ageSeconds <= freshCfg.bigSizeWindowMaxSeconds) {
        sizeSol = Math.min(bal * freshCfg.bigSizePct, bigSizeCapSol);
      } else {
        sizeSol = Math.min(Math.max(bal * wallet.tradeSizePct, wallet.minTradeSol), wallet.maxTradeSol ?? Infinity);
      }
      if (sizeSol > bal - 0.005) { console.log(`${wallet.label}: insufficient balance for fresh snipe (${bal} SOL)`); continue; }

      if (DRY_RUN) {
        console.log(`[dry-run] ${wallet.label} fresh-snipe ${pair.baseToken?.symbol} age=${ageSeconds.toFixed(0)}s score=${score.toFixed(2)} size=${sizeSol}`);
        break;
      }

      const raw = process.env[wallet.keyEnv];
      if (!raw) { console.error(`missing key ${wallet.keyEnv}`); break; }
      const keypair = Keypair.fromSecretKey(bs58.decode(raw));
      const amountLamports = Math.floor(sizeSol * 1e9);

      const { txHash, outAmount, err } = await executeSwap(keypair, SOL_MINT, cand.mint, amountLamports, {
        priorityFeeLamports: freshCfg.priorityFeeLamports,
      });
      const confirmed = !!txHash && err === null;
      if (confirmed) {
        listener.markUsed(cand.mint);
        const price = parseFloat(pair.priceUsd || "0");
        positions[cand.mint] = {
          walletIndex: wallet.index, tokenAddress: cand.mint,
          tokenSymbol: pair.baseToken?.symbol || cand.symbol, tokenAmount: parseInt(outAmount), amountSol: sizeSol,
          entryPrice: price, peakPrice: price, entryTimestamp: new Date().toISOString(),
          scalpDone: false, tier1Done: false, tier2Done: false, strategyUsed: "fresh_snipe",
        };
        savePositions(positions);
        logEvent({ type: "entry", wallet: wallet.label, token: pair.baseToken?.symbol, strategy: "fresh_snipe", ageSeconds: Math.round(ageSeconds), score, sizeSol, txHash });
      } else {
        listener.markUsed(cand.mint);
        logEvent({ type: "error", wallet: wallet.label, action: "fresh_snipe_not_confirmed", token: cand.symbol, txHash, err });
      }
      break; // one fresh-snipe attempt per wallet per tick
    }
  }
}

async function main() {
  console.log(`MemeRunner AI ${tradingParams.engineVersion} — starting cycle (dryRun=${DRY_RUN})`);
  const windowMs = internalPollWindowMinutes * 60_000;
  const pollMs = internalExitPollSeconds * 1000;
  const deadline = Date.now() + windowMs;

  const listener = filters.freshSnipe?.enabled ? startPumpFunListener() : null;

  let firstPass = true;
  while (Date.now() < deadline) {
    const positions = loadPositions();
    await runExitPhase(positions);
    await runFreshSnipePhase(loadPositions(), listener);

    // Once-per-cycle DexScreener-wide scan (mirror + independent picks) —
    // no need to hammer that API every poll tick since fresh-snipe already
    // covers the real-time discovery angle.
    if (firstPass) {
      await runEntryPhase(loadPositions());
      firstPass = false;
    }

    if (Date.now() + pollMs < deadline) await sleep(pollMs);
    else break;
  }

  if (listener) listener.stop();
  const summary = runPatternAnalysis();
  console.log("Cycle complete. Rolling performance summary:", summary);
}

main().catch((e) => {
  console.error("Fatal error in cycle:", e);
  process.exit(1);
});
