# Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     GitHub Actions (every 5 min)                 │
│  .github/workflows/sniper.yml                                    │
└───────────────────────────┬───────────────────────────────────────┘
                             │ runs
                             ▼
                    ┌─────────────────┐
                    │   src/index.js   │  ← orchestrator
                    │ (loops ~4.5 min, │
                    │  polls every 12s)│
                    └───┬─────────┬────┘
                        │         │
              Phase 1   │         │  Phase 2 (once per job)
              EXITS     ▼         ▼  ENTRIES
        ┌───────────────────┐  ┌──────────────────┐
        │ src/exitMonitor.js │  │ src/sniperEngine.js│
        │  - scalp/tier1/2   │  │  - fetchCandidates │
        │  - trailing stop   │  │  - quantumScore    │
        │  - hard SL         │  │  - rugScan         │
        │  - max hold        │  │  - mint/holder     │
        │  - stale-price     │  │    safety checks   │
        │    force-exit      │  │                    │
        └─────────┬──────────┘  └─────────┬──────────┘
                  │                        │
                  ▼                        ▼
          ┌──────────────────────────────────────┐
          │      src/utils/transaction.js         │
          │  Jupiter quote → swap → confirm       │
          │  (real on-chain execution, Helius RPC)│
          └──────────────────┬─────────────────────┘
                              │
                              ▼
                     logs/trades.jsonl
                     logs/open_positions.json
                              │
                              ▼
                  src/patternAnalyzer.js
                  → logs/analysis.json (rolling win rate, PnL)
```

## Why GitHub Actions instead of a persistent server

- **Free** for public repos (and generous minutes for private repos).
- **No infrastructure to maintain** — no VPS, no uptime monitoring, no SSH keys
  beyond what GitHub already manages.
- **Secrets are encrypted at rest** and only exposed as env vars during a job
  run — private keys never touch the repo itself.
- Trade-off: true real-time (sub-second) reaction isn't possible — the
  ~12-second internal poll loop is the practical floor given the 5-minute
  cron granularity. For a meme-coin sniper this is an acceptable trade-off
  against the alternative (a server you have to pay for and operate).

## State across cycles

Since each GitHub Actions job is a fresh, ephemeral VM, `logs/open_positions.json`
is the source of truth for what's currently held — it's read at the start of
every job, mutated in memory during the run, and written back + committed to
the repo before the job ends. This makes position state durable and
versioned (you can literally see position history in `git log`).
