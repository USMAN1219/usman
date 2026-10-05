# Architecture

Price Action Analyst is a web app that analyses chart screenshots with a vision-capable AI model and returns a structured, price-action-only assessment: structure, liquidity, zones, FVGs, order blocks, breakout quality, and either a potential setup with entry, stop and targets, or **NO TRADE — WAIT**. It never places trades.

## Components

```
Browser (React SPA, Netlify CDN)
  │  compress screenshots (≤2000px, WebP/JPEG) · drag & drop · SVG annotations
  │  same-origin fetch, HttpOnly session cookie, X-Requested-With CSRF header
  ▼
/api/*  Netlify Function "api" (sync, ≤60 s)            ──► PostgreSQL (Neon / Netlify DB / any)
  │  Hono router: auth, uploads, history, watchlist,        users, settings, analyses, watchlist,
  │  settings, alerts, usage, rate limits, budget           notifications, rate_events
  │  validates images (magic bytes, size, dimensions)  ──► Netlify Blobs (private screenshot storage)
  │
  │  POST /.netlify/functions/analyze-background  (INTERNAL_JOB_SECRET)
  ▼
Analysis job: inline inside the api function (default, free plan, ≤60 s)
  or Netlify Background Function "analyze-background" (≤15 min, ANALYSIS_EXECUTION=background)
  │  loads screenshots → Claude vision call (streaming, structured output)
  │  → schema validation → deterministic guardrails → save → alerts
  ▼
Google Gemini API (free tier, default)  or  Anthropic Messages API (claude-opus-5-5, paid)
```

The browser polls `GET /api/analyses/:id` every 3 s until the job is `completed` or `failed`.

### Source layout

| Path | Purpose |
|---|---|
| `shared/analysis-schema.ts` | Zod schema of the AI's structured analysis: the contract between AI, server and UI |
| `shared/risk.ts` | Deterministic R:R, level validation and position sizing |
| `shared/annotation.ts` | Price-axis calibration and conversion of the analysis into drawable shapes |
| `server/ai/prompt.ts` | Frozen analyst system prompt (prompt-cached) and the per-request user prompt |
| `server/ai/gemini.ts` | Gemini call (free tier, default): REST generateContent, responseSchema with JSON-mode fallback, free-tier limit messages |
| `server/ai/analyzer.ts` | Claude call: images, adaptive thinking, effort, strict JSON schema, fallbacks, error mapping, cost |
| `server/ai/wire.ts`, `json-schema.ts` | Union-free "wire" schema for structured outputs and its strict JSON Schema |
| `server/analysis/guardrails.ts` | Rules applied to every model answer before the user sees it |
| `server/analysis/job.ts` | The analysis job (background function or local) |
| `server/analysis/alerts.ts` | Optional alerts evaluated after each analysis |
| `server/http/*` | API routes and middleware (auth, CSRF, errors, limits) |
| `server/db/*` | Repository interface, PostgreSQL and in-memory implementations, `schema.sql` |
| `server/storage/index.ts` | Netlify Blobs / filesystem / memory blob stores |
| `netlify/functions/*` | Thin Netlify entry points |
| `src/*` | React frontend |

## How an analysis works

1. **Browser**: each screenshot is decoded, downscaled to at most 2000 px on the long edge and re-encoded only when needed. Exact duplicates within a batch are rejected. Timeframes are guessed from filenames, editable, and sorted from higher to lower timeframe.
2. **API** (`POST /api/analyses`): checks the real file type from magic bytes, the size and the dimensions, then hashes the inputs. If the same user uploaded the same screenshots and inputs within `DUPLICATE_WINDOW_HOURS`, it returns the earlier result for free (the user can force a re-run). It then enforces the hourly/daily limits and the app-wide monthly budget, stores the images privately, creates a `queued` row and dispatches the job.
3. **Job**: atomically claims the row (`queued → processing`), so a duplicate dispatch cannot run it twice, and calls Claude with:
   - all screenshots in one request, so the model builds one multi-timeframe picture;
   - a frozen system prompt with `cache_control` (repeat requests pay about 10% for it);
   - `thinking: adaptive`, `output_config.effort`, and a strict JSON Schema;
   - streaming, so long, high-effort responses don't hit HTTP timeouts;
   - `fallbacks: "default"`, so a request the primary model declines is retried server-side on Anthropic's recommended fallback.
4. **Validation**: the response is parsed, sentinels are converted back to `null`, and the result is validated against the full Zod schema. Refusals, truncation and schema mismatches become clear user-facing errors.
5. **Guardrails** (`guardrails.ts`, deterministic code rather than AI):
   - A directional setup must have an entry, a stop on the correct side, and TP1 on the correct side, with targets ordered away from entry. Otherwise it becomes **NO TRADE — WAIT**.
   - No readable price scale on any image → no trade.
   - The AI's final decision must agree with its own setup.
   - R:R is recomputed by the app. Below the user's minimum R:R or minimum grade, the setup stays visible for reference but the decision becomes **NO TRADE — WAIT**.
   - Position size is calculated only when balance, risk % and the instrument's value per 1.0 move are all known. Nothing is invented.
   - Compliance scan: named institutions, probability or "guaranteed" claims, and indicator-based reasoning are flagged to the user.
   - Watchlist status (Strong / Developing / Watch / No Setup) is derived from the result.
6. **Alerts**: if the user enabled them, the job checks for an A/A+ setup, a sweep, a breakout or retest, price near a major level, or an earlier setup invalidated. The check compares the latest screenshot's price with the previous analysis of the same symbol.
7. **UI**: shows the 13-section report and the screenshots with an SVG overlay. Placement uses the model's price-axis calibration (two axis labels → linear mapping). If the calibration is missing, implausible, or the axis is logarithmic, nothing is drawn, and the user can calibrate manually by clicking two axis labels. Overlays can be toggled by layer and exported as PNG.

## Pre-implementation review: issues found and how they are handled

| Area | Issue | Resolution |
|---|---|---|
| **Serverless limits** | Netlify sync functions stop at 60 s with a 6 MB buffered payload (~4.5 MB of binary after base64). A thorough multi-image vision analysis can take 1–3+ minutes. | Uploads are capped at 4.5 MB in total, with client-side compression. The AI call runs in a **Background Function** (15 min). Fallback: `ANALYSIS_EXECUTION=inline` runs inside the sync function if background functions are unavailable on your plan; use a faster model or lower effort so it finishes in 60 s. |
| **Background function security** | Background functions are reachable at a public URL. | Rejected unless the request carries `INTERNAL_JOB_SECRET` (constant-time compare). The job only takes an id and re-reads everything from the DB. |
| **Structured output limits** | Claude strict schemas allow at most **16 union-typed parameters** and 24 optional ones. The natural schema has about 45 nullable fields, so every request would fail with a 400. | `wire.ts` derives a union-free wire schema (-1 / `""` / `"none"` sentinels) and converts back to `null`. A test asserts zero unions and that all properties are required. If the API still reports the schema is too complex, the analyzer retries with prompt-instructed JSON validated locally. |
| **SDK helper quirk** | The SDK's Zod helper moves `enum` constraints into descriptions, so they are not enforced. | The strict JSON Schema is generated in `json-schema.ts`, which keeps enums. Zod still validates everything locally. |
| **Model API drift** | On current models, `budget_tokens`, sampling parameters, prefill and forced `tool_choice` return 400s. | None of them are used. Adaptive thinking + `effort`, and `output_config.format` instead of forced tools. |
| **Hallucinated prices / misplaced drawings** | A vision model may misread axes or invent levels. | The prompt requires "not available" over guessing. Guardrails reject inconsistent levels. Annotations are drawn only from a validated calibration and otherwise hidden. A manual calibration option is provided. |
| **Prompt injection via notes** | User notes go into the prompt. | Notes are length-limited, fenced in `<user_notes>`, and labelled as context that cannot override the rules. Guardrails run after the model regardless. |
| **API cost abuse** | Anyone who signs up can spend the operator's API credit. | Invite code or closed registration, per-user hourly/daily limits, an app-wide `MONTHLY_BUDGET_USD` hard stop, duplicate-upload detection, image compression, a 6-image cap, and per-analysis token and cost tracking shown in the UI. |
| **Auth security** | Password storage, session theft, brute force, CSRF. | scrypt hashes; HS256 JWT in an `HttpOnly; Secure; SameSite=Lax` cookie; login rate limits per IP and per account with equalised timing; CSRF guard (custom header + Origin check); no CORS. |
| **Data isolation** | Users must never see each other's charts. | Every query is scoped by `user_id`. Images are private blobs served only through the authenticated API, never public URLs. Tested. |
| **Upload attacks** | Disguised files, decompression bombs, path traversal. | Magic-byte sniffing (PNG/JPEG/WebP only), dimension limits, size limits, server-generated storage keys, a filesystem store confined to its root. |
| **Browser hardening** | XSS, clickjacking. | Strict CSP (`script-src 'self'`, `connect-src 'self'`), `frame-ancestors 'none'`, nosniff, HSTS (see `netlify.toml`). React escapes all model text; nothing uses `dangerouslySetInnerHTML`. |
| **Rate limiting in serverless** | In-memory counters reset per instance. | Counters are stored in PostgreSQL (`rate_events`, `analyses`). |
| **Stuck jobs** | A crashed worker would leave a job "processing" forever. | Jobs older than 16 min are reported as failed when read. Retry creates a fresh job. |
| **Blob consistency** | The worker reads images right after upload. | Netlify Blobs store opened with `consistency: "strong"`. |
| **No live prices** | "Price approaching level" or "setup invalidated" alerts would need a market data feed, which is out of scope. | Alerts are evaluated from each new screenshot's price. This is documented in the UI and docs. |
| **Position sizing** | Contract specs vary by broker and instrument. | Sizing needs the user's value-per-1.0-move per watchlist symbol, and is otherwise reported as unavailable. |
| **Win-probability claims** | Misleading. | Confidence is "analytical confidence", labelled as not a probability of profit. Probability and guarantee language is flagged. |

## Independence from Claude Code

Claude Code was only the development tool. The deployed app is ordinary static files plus Netlify Functions that call the AI with the operator's own key: **Google Gemini** (`GEMINI_API_KEY`, free tier) by default, or the **Anthropic API** (`ANTHROPIC_API_KEY`) if `AI_PROVIDER=anthropic`. Nothing in the runtime imports, calls or checks Claude Code, and the bundle contains no developer credentials. You can close or uninstall Claude Code, or let its subscription lapse, and the app keeps running.

What the app *does* need: the Netlify site, the PostgreSQL database (Neon free tier works), Netlify Blobs, and a valid AI key. If the key is invalid or a quota is exhausted, analyses fail with a clear message, while history, the watchlist and settings keep working.

## Testing

| Command | What it covers |
|---|---|
| `npm test` | Unit + integration tests: risk maths, guardrails, wire schema limits, the Claude analyzer against a fake streaming Messages API and the Gemini analyzer against a fake generateContent API (request shape, refusals, truncation, schema fallback, key/quota errors, cost), and API routes (auth, CSRF, brute-force limits, invite codes, upload validation, duplicate detection, rate limits, monthly budget, user isolation, retry, deletion, watchlist, alerts, daily risk) |
| `TEST_DATABASE_URL=… npm test` | Also runs the repository contract tests and auto-migration against a real PostgreSQL (53 tests in total) |
| `npm run build && npm run test:e2e` | Chromium end-to-end on the built app with synthetic 4H/1H/15M charts: register → watchlist → settings → upload → analysis → annotation placement (SL line within 1 px of the true axis position) → layer toggle → trade journal → duplicate detection → history → watchlist status → mobile layout (no horizontal overflow) → no browser errors |
| `E2E_REAL_AI=1 npm run test:e2e` | Same flow against the real model (costs money) |
| `npm run analyze:file -- --symbol EURUSD 4h=a.png 15m=b.png` | Runs the real AI pipeline on your own screenshots from the command line |
