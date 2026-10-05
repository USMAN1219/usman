# Deployment guide

> **Want it free and browser-only?** Use [FREE_SETUP.md](FREE_SETUP.md). This page is the full reference, including the optional paid Claude model and background-function mode.

**Defaults:**
- `AI_PROVIDER=gemini` (free tier) and `ANALYSIS_EXECUTION=inline` (runs within the 60 s synchronous function, works on Netlify's free plan).
- Database tables are created automatically (`AUTO_MIGRATE=true`).
- `APP_ENV` defaults to `production`, so secrets are required unless you explicitly set `development`.

Target architecture (all managed services, no servers to maintain):

| Layer | Service | Notes |
|---|---|---|
| Frontend | **Netlify** (CDN) | Static React build from `dist/` |
| API | **Netlify Functions** | `api` (sync, `/api/*`) + `analyze-background` (background, ≤15 min) |
| AI | **Google Gemini API** (free tier, default) or **Anthropic API** (paid) | `gemini-flash-latest` or `claude-opus-5-5`; your own key |
| Database | **PostgreSQL**: Neon (recommended; Netlify DB is Neon), Supabase, or any provider | Use the **pooled** connection string |
| Image storage | **Netlify Blobs** | Private, built in, no extra credentials |

## 1. Prerequisites

- A GitHub repository containing this folder (`price-action-analyst/`).
- A Netlify account (the Free plan works with the default `ANALYSIS_EXECUTION=inline`).
- An AI key, one of:
  - **Free:** a Gemini API key from https://aistudio.google.com (no card);
  - **Paid:** an Anthropic API key from https://console.anthropic.com. Set a monthly spend limit there.
- A PostgreSQL database. On Neon: create a project and copy the **pooled** connection string (host contains `-pooler`, ends with `?sslmode=require`).

## 2. Database schema

Nothing to do: with `AUTO_MIGRATE=true` (default) the app creates or upgrades its tables on first use, under an advisory lock. To do it manually instead: `DATABASE_URL=… npm run db:migrate`.

## 3. Create the Netlify site

1. Netlify → **Add new project → Import an existing project** → pick the repository and branch.
2. **Base directory**: `price-action-analyst`. Build command and publish directory come from `netlify.toml` (`npm run build`, `dist`).
3. Before the first deploy, add the environment variables below.

## 4. Environment variables (Site configuration → Environment variables)

Use long random values for secrets (a password generator, or `openssl rand -base64 48`).

| Variable | Required | Value |
|---|---|---|
| `AUTH_SECRET` | yes | 32+ random characters (signs session cookies) |
| `DATABASE_URL` | yes | Pooled PostgreSQL URL |
| `GEMINI_API_KEY` | yes, for the free default | Gemini key from Google AI Studio |
| `REGISTRATION_INVITE_CODE` | recommended | Stops strangers signing up and using your AI quota |
| `GEMINI_MODEL` | no | Default `gemini-flash-latest` |
| `AI_PROVIDER` | no | `gemini` (default) or `anthropic` |
| `ANTHROPIC_API_KEY` | if `anthropic` | Anthropic key (server-side only; never exposed to the browser) |
| `ANTHROPIC_MODEL` / `ANTHROPIC_EFFORT` | no | Default `claude-opus-5-5` / `high`. `claude-sonnet-5-5` or `medium` are faster and cheaper. |
| `ANALYSIS_EXECUTION` | no | `inline` (default, ≤60 s) or `background` (Netlify Background Function, ≤15 min; recommended with Claude at high effort) |
| `INTERNAL_JOB_SECRET` | if `background` | 32+ random characters, different from `AUTH_SECRET` |
| `APP_URL` | no | Your site URL; adds it to the allowed origins (the request's own origin is always allowed) |
| `REGISTRATION_ENABLED` | no | Set `false` once your account(s) exist |
| `MONTHLY_BUDGET_USD` | recommended for paid AI | App-wide hard stop on estimated AI spend per calendar month |
| `RATE_LIMIT_ANALYSES_PER_HOUR` / `_PER_DAY` | no | Per-user limits (defaults 10 / 40) |

`APP_ENV` defaults to `production`, `DB_DRIVER` to `postgres` and `STORAGE_DRIVER` to `netlify`. The app refuses to start in production if a required value is missing or unsafe (for example the mock AI, the in-memory DB, or a short secret), and the error appears in the function logs.

## 5. Deploy and verify

1. Trigger a deploy. Then open `https://<site>/api/health` → `{"ok":true}`.
2. Open the site, create your account (with the invite code if set), and set your balance and risk in **Settings**.
3. Upload 2–3 timeframes of one instrument. With Gemini inline, the result arrives in roughly 20–60 s; with Claude in background mode, a progress screen shows and the result takes about 1–3 minutes.
4. Netlify → **Logs → Functions** shows `analysis.model_response` (tokens, duration) and `analysis.completed` for each job.
5. After creating your account(s), set `REGISTRATION_ENABLED=false` and redeploy.

## 6. Inline vs background execution

`inline` (default) runs the analysis inside the 60-second synchronous function. It is free-plan friendly and fits Gemini Flash. For Claude at high effort, which can take 1–3 minutes, set `ANALYSIS_EXECUTION=background` and `INTERNAL_JOB_SECRET` if your Netlify plan offers Background Functions. Otherwise use `claude-sonnet-5-5` with `ANTHROPIC_EFFORT=medium` and fewer screenshots.

## 7. Costs

- **Gemini (default)**: free within Google's free-tier rate limits. On the free tier Google may use inputs to improve its products.
- **Anthropic (optional)**: per analysis, roughly 1.5k–3k input tokens per screenshot, plus the system prompt (cached after the first call), plus the output and thinking tokens. With `claude-opus-5-5` at high effort, expect very roughly **$0.10–$0.40 per multi-timeframe analysis**. The exact estimated cost of each analysis appears on its page, and the monthly total on the dashboard. Cheaper: `claude-sonnet-5-5`, `ANTHROPIC_EFFORT=medium`, fewer screenshots.
- **Netlify**: function invocations and Blobs storage. A personal deployment usually fits the free or starter tier.
- **Neon**: the free tier is enough for personal use.

Cost controls built in: client-side compression, a 6-image cap, duplicate detection (identical uploads reuse the previous result), per-user hourly/daily limits, `MONTHLY_BUDGET_USD`, prompt caching, and an invite-only sign-up option.

## 8. Operating without Claude Code

Once deployed, the app depends only on Netlify, your database, and your AI key (free Gemini by default). Claude Code (the development tool) is not involved at runtime: you can close it, uninstall it, or let its subscription end, and the site keeps working. To keep analyses working, keep the AI key valid (and, for Claude, the account funded). If it lapses, the app shows a clear message ("API key rejected", "Free AI limit reached", "insufficient credit"), and everything else (history, watchlist, settings) still works.

Updating later: push to the repository and Netlify rebuilds. Any editor works. Run `npm test` before pushing.

## 9. Security checklist

- [ ] `AUTH_SECRET` and `INTERNAL_JOB_SECRET` are long, random and different
- [ ] `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` are only in Netlify environment variables, never in the repo or frontend
- [ ] Invite code set or registration disabled
- [ ] With paid AI: `MONTHLY_BUDGET_USD` set, plus a spend limit in the Anthropic console
- [ ] Database URL uses TLS (`sslmode=require`)
- [ ] Custom domain served over HTTPS (HSTS is enabled in `netlify.toml`)
