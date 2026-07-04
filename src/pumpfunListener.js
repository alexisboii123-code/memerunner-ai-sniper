import WebSocket from "ws";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";

/**
 * Maintains a rolling in-memory queue of newly created pump.fun tokens via
 * PumpPortal's public real-time WebSocket feed (free, no key required).
 * This gives sub-second discovery of new launches — much faster than
 * polling DexScreener, which typically lags 30s-2min+ behind actual
 * on-chain creation.
 *
 * IMPORTANT: this feed is for DISCOVERY ONLY (which mints exist + how old
 * they are). Actual scoring/safety checks still require DexScreener's
 * indexed liquidity/volume data, which usually isn't available in the
 * first few seconds of a token's life. That's why entries execute once a
 * candidate is in the 1-5min window (once real data exists) rather than
 * the instant it's first seen.
 */
export function startPumpFunListener({ maxAgeMs = 10 * 60_000 } = {}) {
  const seen = new Map(); // mint -> { mint, symbol, name, firstSeenAt }
  let ws = null;
  let closedByUs = false;

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
          if (!mint || seen.has(mint)) return;
          seen.set(mint, {
            mint,
            symbol: msg?.symbol || msg?.tokenSymbol || "UNK",
            name: msg?.name || "",
            firstSeenAt: Date.now(),
          });
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
        if (age > maxAgeMs) { seen.delete(mint); continue; } // prune stale, never traded
        if (age >= minAgeMs && age <= maxAgeMsWindow) out.push({ ...info, ageMs: age });
      }
      return out;
    },
    markUsed(mint) { seen.delete(mint); },
    stop() { closedByUs = true; if (ws) ws.close(); },
  };
}
