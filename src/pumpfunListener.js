import WebSocket from "ws";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";

let cachedSolPriceUsd = 150; // fallback default, refreshed below
async function refreshSolPrice() {
  try {
    const res = await fetch("https://lite-api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112");
    const json = await res.json();
    const p = parseFloat(json?.data?.So11111111111111111111111111111111111111112?.price);
    if (p > 0) cachedSolPriceUsd = p;
  } catch (_) { /* keep last known price */ }
}
refreshSolPrice();
setInterval(refreshSolPrice, 120_000);

/**
 * Maintains a rolling in-memory queue of newly created pump.fun tokens via
 * PumpPortal's public real-time WebSocket feed (free, no key required).
 * This gives sub-second discovery of new launches — much faster than
 * polling DexScreener, which typically lags 30s-2min+ behind actual
 * on-chain creation.
 *
 * v8.2: also subscribes to live per-token trade events (subscribeTokenTrade)
 * for every newly discovered mint, so we get a real-time marketCapSol +
 * buy/sell trade count WITHOUT waiting on DexScreener indexing. This lets
 * the fresh-snipe fast-path score/enter a token the instant it enters the
 * 10k-20k mcap band, even in its first few seconds of life when DexScreener
 * has no data at all yet (previously we'd just skip and often miss the
 * entire window before DexScreener caught up).
 */
export function startPumpFunListener({ maxAgeMs = 10 * 60_000 } = {}) {
  const seen = new Map(); // mint -> { mint, symbol, name, firstSeenAt }
  const live = new Map(); // mint -> { marketCapSol, buys, sells, lastTradeAt }
  let ws = null;
  let closedByUs = false;

  function subscribeTrades(mint) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] })); } catch (_) {}
    }
  }

  function connect() {
    try {
      ws = new WebSocket(PUMPPORTAL_WS);
      ws.on("open", () => {
        console.log("[pumpfun] listener connected");
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      });
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const mint = msg?.mint || msg?.mintAddress;
          if (!mint) return;

          // New token creation event
          if (msg?.txType === "create" || (!seen.has(mint) && msg?.name !== undefined)) {
            if (!seen.has(mint)) {
              seen.set(mint, {
                mint,
                symbol: msg?.symbol || msg?.tokenSymbol || "UNK",
                name: msg?.name || "",
                firstSeenAt: Date.now(),
              });
              subscribeTrades(mint);
            }
          }

          // Live trade event (buy/sell) — carries marketCapSol in real time
          if (msg?.marketCapSol !== undefined) {
            const prev = live.get(mint) || { buys: 0, sells: 0 };
            if (msg.txType === "sell") prev.sells += 1; else prev.buys += 1;
            prev.marketCapSol = msg.marketCapSol;
            prev.lastTradeAt = Date.now();
            live.set(mint, prev);
          }
        } catch (_) {}
      });
      ws.on("close", () => {
        if (!closedByUs) {
          console.log("[pumpfun] listener disconnected, reconnecting in 3s");
          setTimeout(connect, 3000);
        }
      });
      ws.on("error", (e) => console.log("[pumpfun] listener error:", e?.message || e));
    } catch (e) {
      console.log("[pumpfun] failed to connect, retrying in 3s:", e?.message || e);
      setTimeout(connect, 3000);
    }
  }
  connect();

  return {
    /** Candidates whose discovery-age (ms) falls within [minAgeMs, maxAgeMsWindow]. */
    getCandidates(minAgeMs = 0, maxAgeMsWindow = maxAgeMs) {
      const now = Date.now();
      const out = [];
      for (const [mint, info] of seen) {
        const age = now - info.firstSeenAt;
        if (age > maxAgeMs) { seen.delete(mint); live.delete(mint); continue; } // prune stale, never traded
        if (age >= minAgeMs && age <= maxAgeMsWindow) out.push({ ...info, ageMs: age });
      }
      return out;
    },
    /** Real-time PumpPortal-derived market cap in USD, or null if no trades seen yet. */
    getLiveMarketCapUsd(mint) {
      const l = live.get(mint);
      if (!l || l.marketCapSol === undefined) return null;
      return { marketCapUsd: l.marketCapSol * cachedSolPriceUsd, buys: l.buys, sells: l.sells, lastTradeAt: l.lastTradeAt };
    },
    markUsed(mint) { seen.delete(mint); live.delete(mint); },
    stop() { closedByUs = true; if (ws) ws.close(); },
  };
}
