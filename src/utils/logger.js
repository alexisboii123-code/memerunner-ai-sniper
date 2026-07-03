import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.resolve("logs");
const TRADES_LOG = path.join(LOG_DIR, "trades.jsonl");

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

/** Append one structured trade/cycle event as a JSON line (easy to grep/tail/parse). */
export function logEvent(event) {
  ensureLogDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  fs.appendFileSync(TRADES_LOG, line + "\n");
  console.log(line);
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
