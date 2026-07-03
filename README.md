# MemeRunner AI

A high-conviction, fresh-listing Solana sniper bot running in **Insider Mode v4.1**.
Consolidated 2-wallet architecture (W8 secondary / W9 main sniper) with tiered
scalp-first profit taking, strict risk controls, and automatic profit-locking
to a cold vault wallet. Designed to run entirely on **GitHub Actions** — free,
independent of any chat platform, and immune to message-credit limits.

## How it works

Every 5 minutes (GitHub Actions' minimum cron granularity) the workflow spins
up a fresh runner and executes `src/index.js`, which internally loops for
~4.5 minutes polling every 12s — giving near-real-time exit monitoring without
needing a permanently-running server.

Each cycle:

1. **Exit Monitor** (`src/exitMonitor.js`) — checks every open position against:
   - Scalp tier: **+15% → sell 45%** of the remaining position
   - Tier 1: **+20% → sell 40%** of what's left
   - Tier 2: **+60% → sell 30%** of what's left (remainder trails)
   - Trailing stop: arms at +10%, exits on an 8% pullback from peak
   - Hard stop-loss: **-8%**
   - Max hold: **15 minutes** (force-exits via real on-chain balance if the
     price feed goes stale)
   - Rug checks: mint/freeze authority, holder concentration (>35%), wash
     trading, liquidity sweet-spot ($15k–$120k)
   - Any realized profit ≥0.01 SOL sweeps 50% to the vault wallet automatically

2. **Sniper Engine** (`src/sniperEngine.js`) — scans DexScreener's fresh-listing
   feeds, scores every candidate with the quantum-score model (momentum,
   volume/liquidity ratio, buy/sell tx pressure), and buys the top-scoring
   token on any free wallet that clears its entry gate (W9: 0.55, W8: 0.70).

3. **Pattern Analyzer** (`src/patternAnalyzer.js`) — after each cycle, appends
   to `logs/trades.jsonl` and recomputes rolling win-rate / avg PnL into
   `logs/analysis.json` for later strategy tuning.

## Setup

1. Clone this repo.
2. Copy `.env.example` to `.env` and fill in real values **locally only** —
   never commit it (it's already in `.gitignore`).
3. In your GitHub repo settings → **Secrets and variables → Actions**, add:
   - `HELIUS_API_KEY`
   - `SOLANA_PRIVATE_KEY_08` (W9 — main sniper)
   - `SOLANA_PRIVATE_KEY_07` (W8 — secondary sniper)
4. Enable Actions on the repo (Settings → Actions → General → Allow all actions).
5. The workflow in `.github/workflows/sniper.yml` runs automatically every 5
   minutes. You can also trigger it manually from the Actions tab
   ("Run workflow").

## Config

All tunables live in `config/`, not hardcoded in source:

- `config/wallets.json` — wallet public addresses, roles, per-wallet entry
  gates and position sizing
- `config/filters.json` — quantum score weights, liquidity/volume/momentum
  gates, permanent blocklist
- `config/trading_params.json` — TP tiers, stop-loss, max hold, vault sweep
  rules

## Safety notes

- **Never commit real private keys.** `config/wallets.json` only ever holds
  public addresses. Keys live exclusively in GitHub encrypted Secrets and are
  injected as env vars at runtime.
- All exits require genuine on-chain confirmation (`txHash` + confirmed status)
  before any PnL or profit-sweep accounting happens — no unconfirmed tx is
  ever counted as a completed trade.
- `logs/` is committed back to the repo by the workflow so you have a
  permanent, versioned trade history — but it's gitignored from your local
  clone edits to avoid merge conflicts (the Action commits it, not you).

## Disclaimer

This trades real money on real, extremely volatile meme tokens. Position
sizing, stop-losses, and the profit vault exist to manage risk — they do not
eliminate it. Only fund wallets with capital you can afford to lose entirely.
