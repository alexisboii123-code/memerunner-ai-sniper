import fs from "node:fs";
import path from "node:path";
import { readTradeLog } from "./utils/logger.js";

const ANALYSIS_FILE = path.resolve("logs/analysis.json");

/**
 * Post-batch analysis over everything logged so far this run (and prior runs,
 * since logs/trades.jsonl is committed back to the repo by the workflow).
 * Writes a rolling summary — win rate, avg PnL, best/worst tokens — that a
 * human (or a future auto-tuner) can use to adjust config/filters.json and
 * config/trading_params.json over time.
 */
export function runPatternAnalysis() {
  const events = readTradeLog().filter((e) => e.type === "exit" && typeof e.pnlSol === "number");
  if (!events.length) {
    return { totalTrades: 0, note: "No closed trades logged yet." };
  }

  const wins = events.filter((e) => e.pnlSol > 0);
  const losses = events.filter((e) => e.pnlSol <= 0);
  const totalPnl = events.reduce((s, e) => s + e.pnlSol, 0);
  const byToken = {};
  for (const e of events) {
    byToken[e.token] = (byToken[e.token] || 0) + e.pnlSol;
  }
  const ranked = Object.entries(byToken).sort((a, b) => b[1] - a[1]);

  const summary = {
    generatedAt: new Date().toISOString(),
    totalTrades: events.length,
    wins: wins.length,
    losses: losses.length,
    winRate: +(wins.length / events.length).toFixed(3),
    totalPnlSol: +totalPnl.toFixed(6),
    avgPnlSol: +(totalPnl / events.length).toFixed(6),
    bestToken: ranked[0] ? { token: ranked[0][0], pnlSol: +ranked[0][1].toFixed(6) } : null,
    worstToken: ranked.at(-1) ? { token: ranked.at(-1)[0], pnlSol: +ranked.at(-1)[1].toFixed(6) } : null,
  };

  fs.mkdirSync(path.dirname(ANALYSIS_FILE), { recursive: true });
  fs.writeFileSync(ANALYSIS_FILE, JSON.stringify(summary, null, 2));
  return summary;
}
