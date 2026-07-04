import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.resolve("logs");
const TRADES_LOG = path.join(LOG_DIR, "trades.jsonl");

// Base44 dashboard sync — mirrors real entry/exit events so they show up
// live on the dashboard instead of waiting for the whole ~340min job to
// finish and commit logs back to the repo.
const SYNC_URL = "https://base44.app/api/apps/6a41fbc6255e656d3c2b8cbe/functions/logTrade";
const SYNC_SECRET = process.env.GH_SYNC_SECRET;

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

/** Fire-and-forget POST to Base44 so a bad network call never blocks/crashes the trading loop. */
function syncToBase44(event) {
  if (!SYNC_SECRET) return; // not configured, skip silently
  if (event.type !== "entry" && event.type !== "exit") return; // skip cycle_scan/error noise

  const payload = {
    type: event.type,
    wallet: event.wallet,
    token: event.token,
    tokenAddress: event.tokenAddress || null,
    sizeSol: event.sizeSol ?? null,
    pnlSol: event.pnlSol ?? null,
    pnlPercent: event.pnlPercent ?? null,
    strategy: event.strategy || null,
    reason: event.reason || null,
    txHash: event.txHash || null,
  };

  fetch(SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sync-secret": SYNC_SECRET },
    body: JSON.stringify(payload),
  }).catch((e) => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), type: "sync_error", err: String(e) }));
  });
}

/** Append one structured trade/cycle event as a JSON line (easy to grep/tail/parse). */
export function logEvent(event) {
  ensureLogDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  fs.appendFileSync(TRADES_LOG, line + "\n");
  console.log(line);
  syncToBase44(event);
}

/** Read all logged trade events back (used by patternAnalyzer). */
export function readTradeLog() {
  ensureLogDir();
  if (!fs.existsSync(TRADES_LOG)) return [];
  return fs
    .readFileSync(TRADES_LOG, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}
