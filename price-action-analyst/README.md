# Price Action Analyst

An AI chart-analysis web app for discretionary traders. Upload screenshots of the same instrument on several timeframes (1m–1D). A vision-capable AI model analyses them like a disciplined price-action trader, using **structure, liquidity, support/resistance, supply/demand, FVGs, BOS/CHOCH, order blocks, sweeps, displacement, and breakout/retest quality**, with **no indicators**. The result is either a potential setup or **NO TRADE — WAIT**.

> ⚠️ AI analysis is probabilistic and may be wrong. Always independently verify the chart before taking any trade.
> This app is an analysis assistant. It never connects to a broker and never places trades. You make every decision.

## Features

- **Upload**: drag & drop, file picker or paste; up to 6 screenshots; automatic compression; timeframe detection from filenames; duplicate detection.
- **Structured multi-timeframe analysis** in a fixed 13-section report: HTF structure → levels → liquidity and sweeps → BOS/CHOCH → supply/demand (graded A+/A/B/weak) → FVG status → order blocks → real vs fake breakout → setup (entry type, entry zone, SL, TP1–TP3, R:R, grade A+/A/B/C) → confluence checklist → invalidation → what to wait for → final decision 🟢 / 🔴 / ⚪.
- **Deterministic safety checks** on every AI answer:
  - stops and targets must sit on the correct side of entry;
  - R:R is recomputed by the app;
  - your minimum R:R and minimum grade are enforced;
  - setups are refused when prices are unreadable;
  - institution names, probability claims and indicator-based reasoning are flagged.
- **Chart annotation**: support/resistance, zones, FVGs, order blocks, liquidity, sweeps, BOS/CHOCH, entry, SL and TPs drawn on your screenshot, with per-layer toggles and PNG export. Nothing is drawn unless the price axis is reliably calibrated; you can also calibrate manually with two clicks.
- **Money management**: risk-% based position sizing (only when balance, risk and the instrument's value per point are known), daily trade-count and daily-loss limits, and an optional trade journal.
- **History** with filters, a **watchlist** with automatic Strong / Developing / Watch / No Setup status, and **optional alerts** (A/A+ setup, approaching level, sweep, breakout/retest, setup invalidated).
- **Cost control**: usage and estimated cost per analysis and per month, rate limits, and a monthly budget cap.

## Quick start (local, no API key needed)

```bash
cd price-action-analyst
npm install
cp .env.example .env        # defaults: mock AI, in-memory DB, local file storage
npm run dev                 # web on http://localhost:5173, API on :8787
```

The mock AI returns clearly labelled fake results, so you can explore the UI for free. Run `npm run charts:generate` to create test chart screenshots in `e2e/output/charts/`.

To use the real model locally, set in `.env`:

```
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

To persist data, set `DB_DRIVER=postgres` and `DATABASE_URL`, then run `npm run db:migrate`.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Local API + Vite dev server |
| `npm run build` | Type-check everything and build the frontend |
| `npm test` | Unit + integration tests (set `TEST_DATABASE_URL` to include PostgreSQL) |
| `npm run test:e2e` | Browser end-to-end test on the built app (run `npm run build` first) |
| `npm run db:migrate` | Create or upgrade the database schema |
| `npm run analyze:file -- --symbol EURUSD 4h=a.png 15m=b.png` | Analyse local screenshots with the real model from the CLI |
| `npm run charts:generate` | Generate synthetic chart screenshots for testing |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, data flow, guardrails, the pre-implementation review (limits, security risks, API constraints and how each is handled), testing.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Netlify + PostgreSQL + Anthropic deployment, environment variables, costs, security checklist.
- [.env.example](.env.example): every configuration variable.

## Independence from Claude Code

Claude Code was used only to build this project. The deployed app runs on Netlify and calls the Anthropic API with **your** API key. It keeps working with Claude Code closed or uninstalled, or with no Claude Code subscription. Analyses do need a funded Anthropic API account.
