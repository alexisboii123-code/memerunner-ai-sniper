import { PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import filters from "../config/filters.json" with { type: "json" };

const REENTRY_MOMENTUM_PCT = filters.reentryMomentumWaiverPct;

/**
 * Core rug/freshness gate. skipAgeCheck=true is used for OPEN POSITION
 * monitoring (freshness only makes sense as an entry gate — applying it
 * continuously force-sells perfectly healthy winners the moment they age
 * past the window). vetted=true allows a momentum-based re-entry waiver
 * for tokens we've bought before.
 */
export function rugScan(pair, opts = {}) {
  const flags = [];
  const sym = (pair?.baseToken?.symbol || "").toUpperCase();
  const liq = pair?.liquidity?.usd || 0;
  const mc = pair?.marketCap || 0;
  const vol1h = pair?.volume?.h1 || 0;

  if (filters.blocklist.includes(sym)) flags.push("BLOCKLISTED");
  if (liq < (opts.liqMinOverride ?? filters.liquidityUsd.min)) flags.push("LOW_LIQ");
  if (mc > 10000 && liq / mc < 0.012) flags.push("LOW_LIQ_RATIO");
  if (parseFloat(pair?.priceUsd || "0") === 0) flags.push("ZERO_PRICE");
  if (liq > 0 && vol1h / liq > filters.rugChecks.maxVolumeToLiquidityRatio) flags.push("WASH_TRADING");
  if (liq > filters.liquidityUsd.max) flags.push("LIQ_TOO_HIGH");

  if (!opts.skipAgeCheck) {
    const ageMin = (Date.now() - (pair?.pairCreatedAt || Date.now())) / 60000;
    if (ageMin < 1.0) flags.push("TOO_NEW");
    if (ageMin > filters.maxTokenAgeMinutes) {
      const ch5m = parseFloat(pair?.priceChange?.m5 || "0");
      const waived = !!opts.vetted && ch5m >= REENTRY_MOMENTUM_PCT;
      if (!waived) flags.push("TOO_OLD");
    }
  }
  return { safe: flags.length === 0, flags };
}

/** Mint/freeze authority check, classic SPL first then Token-2022 fallback (pump.fun tokens are usually 2022). */
export async function checkMintSafety(conn, mintAddress) {
  const flags = [];
  const pubkey = new PublicKey(mintAddress);
  let mintInfo = null;
  try {
    mintInfo = await getMint(conn, pubkey);
  } catch {
    try {
      mintInfo = await getMint(conn, pubkey, "confirmed", TOKEN_2022_PROGRAM_ID);
    } catch (e2) {
      flags.push("MINT_CHECK_FAILED:" + (e2?.message || String(e2)).slice(0, 80));
    }
  }
  if (mintInfo) {
    if (mintInfo.mintAuthority !== null) flags.push("MINT_AUTHORITY_ACTIVE");
    if (mintInfo.freezeAuthority !== null) flags.push("FREEZE_AUTHORITY_ACTIVE");
  }
  return { safe: flags.length === 0, flags };
}

/** Real on-chain proxy for dev-wallet concentration risk. Fails open on RPC error. */
export async function checkHolderConcentration(conn, mintAddress, poolAddress) {
  const flags = [];
  try {
    const largest = await conn.getTokenLargestAccounts(new PublicKey(mintAddress));
    const accounts = largest?.value || [];
    if (!accounts.length) return { safe: true, flags };
    const top = accounts[0];
    const totalUi = accounts.reduce((s, a) => s + (a.uiAmount || 0), 0);
    if (totalUi <= 0) return { safe: true, flags };
    const topRatio = (top.uiAmount || 0) / totalUi;
    const isPool = !!poolAddress && top.address.toBase58() === poolAddress;
    const maxPct = filters.maxHolderConcentrationPct / 100;
    if (!isPool && topRatio > maxPct) flags.push("CONCENTRATED_HOLDER_" + Math.round(topRatio * 100) + "pct");
  } catch {
    // fail-open: a flaky RPC call should never block an otherwise-good trade
  }
  return { safe: flags.length === 0, flags };
}

/** Quantum score: momentum + volume/liquidity ratio + volume pattern + real buy/sell tx pressure. */
export function quantumScore(pair, vetted = false) {
  const rug = rugScan(pair, { vetted });
  if (!rug.safe) return 0;
  const liq = pair?.liquidity?.usd || 0;
  const vol5m = pair?.volume?.m5 || 0;
  const ch5m = parseFloat(pair?.priceChange?.m5 || "0");
  if (liq < filters.liquidityUsd.min || vol5m < filters.minVolume5mUsd || ch5m < filters.minMomentum5mPct) return 0;

  const ch1h = parseFloat(pair?.priceChange?.h1 || "0");
  const vol1h = pair?.volume?.h1 || 1;
  const w = filters.quantumScoreWeights;
  const momScore = Math.min((ch5m / 15 + Math.max(ch1h, 0) / 40) / 2, 1);
  const vtlScore = Math.min(vol5m / liq, 1);
  const patScore = vol5m > (vol1h / 12) * 1.3 ? 0.9 : 0.5;
  const buys5m = pair?.txns?.m5?.buys || 0;
  const sells5m = pair?.txns?.m5?.sells || 0;
  const totalTxns5m = buys5m + sells5m;
  const buyRatio = totalTxns5m > 0 ? buys5m / totalTxns5m : 0.5;
  const pressureScore = Math.max(0, Math.min((buyRatio - 0.5) * 2, 1));

  return Math.min(momScore * w.momentum + vtlScore * w.volumeToLiquidity + patScore * w.volumePattern + pressureScore * w.buySellPressure, 1);
}

/**
 * Fresh-snipe scoring for pump.fun launches surfaced by the real-time
 * PumpPortal listener. Uses the SAME core safety gates as quantumScore
 * (blocklist, wash-trading, zero-price, liq-too-high — those never relax),
 * but with a relaxed liquidity floor during the configured early window
 * (since a 90s-old token won't have built up volume history yet) and a
 * simpler momentum/pressure-based score since 1h stats don't exist yet.
 * Returns { score, gateForAge, liqMinUsed, flags }. Caller compares score
 * against gateForAge (falls back to the wallet's normal gate once past the
 * relaxed window).
 */
export function freshSnipeScore(pair, ageSeconds, freshCfg) {
  const liqMinOverride = ageSeconds <= freshCfg.lowLiqWindowSeconds ? freshCfg.lowLiqUsd : filters.liquidityUsd.min;
  const gateForAge = ageSeconds <= freshCfg.lowGateWindowSeconds ? freshCfg.lowGate : null;

  // Hard market-cap band: only buy while the token is still genuinely early
  // (post-pump movers with big 5m momentum but a high mcap get rejected here,
  // even if their momentum/volume numbers would otherwise score well).
  const mcMin = freshCfg.entryMarketCapMinUsd ?? 0;
  const mcMax = freshCfg.entryMarketCapMaxUsd ?? Infinity;
  const mc = pair?.marketCap || 0;
  if (mc < mcMin || mc > mcMax) {
    return { score: 0, gateForAge, liqMinUsed: liqMinOverride, flags: ["MC_OUT_OF_RANGE"] };
  }
  // Tokens in the early mcap band are usually still on the pump.fun bonding
  // curve (pre-Raydium migration) and report $0 "liquidity" on DexScreener —
  // that's normal, not a rug signal. Bypass the liquidity floor here and lean
  // on mint-safety + holder-concentration checks (below) as the real gate.
  const inEarlyBand = mc >= mcMin && mc <= mcMax;
  const effectiveLiqMinOverride = inEarlyBand ? 0 : liqMinOverride;

  const rug = rugScan(pair, { skipAgeCheck: true, liqMinOverride: effectiveLiqMinOverride });
  if (!rug.safe) return { score: 0, gateForAge, liqMinUsed: effectiveLiqMinOverride, flags: rug.flags };

  const vol5m = pair?.volume?.m5 || 0;
  const ch5m = parseFloat(pair?.priceChange?.m5 || "0");
  const liq = pair?.liquidity?.usd || 0;
  const buys5m = pair?.txns?.m5?.buys || 0;
  const sells5m = pair?.txns?.m5?.sells || 0;
  const totalTxns5m = buys5m + sells5m;
  const buyRatio = totalTxns5m > 0 ? buys5m / totalTxns5m : 0.5;

  const momScore = Math.min(Math.max(ch5m, 0) / 20, 1);
  const vtlScore = liq > 0 ? Math.min(vol5m / liq, 1) : 0;
  const pressureScore = Math.max(0, Math.min((buyRatio - 0.5) * 2, 1));
  const score = Math.min(momScore * 0.4 + vtlScore * 0.3 + pressureScore * 0.3, 1);

  return { score, gateForAge, liqMinUsed: liqMinOverride, flags: [] };
}

/** Pulls fresh-listing candidates from DexScreener's profile/boost feeds (not keyword search). */
export async function fetchCandidates() {
  const feeds = [
    "https://api.dexscreener.com/token-profiles/latest/v1",
    "https://api.dexscreener.com/token-boosts/latest/v1",
  ];
  const addrs = [];
  const seenAddr = new Set();
  await Promise.all(feeds.map(async (url) => {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) return;
      const d = await r.json();
      if (!Array.isArray(d)) return;
      for (const item of d) {
        if (item?.chainId !== "solana") continue;
        const addr = item?.tokenAddress;
        if (!addr || seenAddr.has(addr)) continue;
        seenAddr.add(addr);
        addrs.push(addr);
      }
    } catch (_) {}
  }));

  const all = [];
  const seenPair = new Set();
  const CONCURRENCY = 8;
  for (let i = 0; i < addrs.length; i += CONCURRENCY) {
    const batch = addrs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (addr) => {
      try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
        if (!r.ok) return null;
        const d = await r.json();
        const pairs = Array.isArray(d?.pairs) ? d.pairs : [];
        const solPairs = pairs.filter((p) => p.chainId === "solana");
        if (!solPairs.length) return null;
        solPairs.sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0));
        return solPairs[0];
      } catch (_) { return null; }
    }));
    for (const p of results) {
      if (!p) continue;
      const addr = p?.baseToken?.address;
      if (!addr || seenPair.has(addr)) continue;
      seenPair.add(addr);
      all.push(p);
    }
  }
  return all;
}

export async function getTokenPrice(mint) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d?.pairs?.[0] || null;
  } catch {
    return null;
  }
}
