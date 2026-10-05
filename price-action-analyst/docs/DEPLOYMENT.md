# Deployment guide

Target architecture (all managed services, no servers to maintain):

| Layer | Service | Notes |
|---|---|---|
| Frontend | **Netlify** (CDN) | Static React build from `dist/` |
| API | **Netlify Functions** | `api` (sync, `/api/*`) + `analyze-background` (background, ≤15 min) |
| AI | **Anthropic API** | Vision model `claude-opus-5-5` by default; your own API key |
| Database | **PostgreSQL**: Neon (recommended; Netlify DB is Neon), Supabase, or any provider | Use the **pooled** connection string |
| Image storage | **Netlify Blobs** | Private, built in, no extra credentials |

## 1. Prerequisites

- A GitHub repository containing this folder (`price-action-analyst/`).
- A Netlify account. The app uses a Background Function for the AI job. If your plan lacks background functions, see step 6.
- An Anthropic API account with billing enabled: https://console.anthropic.com → **API keys** → create a key. Set a monthly spend limit there as well.
- A PostgreSQL database. On Neon: create a project and copy the **pooled** connection string (host contains `-pooler`, ends with `?sslmode=require`).

## 2. Create the database schema

From your machine (Node 20+):

```bash
cd price-action-analyst
npm ci
DATABASE_URL='postgres://…-pooler…/neondb?sslmode=require' npm run db:migrate
```

The migration is idempotent; re-run it after upgrades.

## 3. Create the Netlify site

1. Netlify → **Add new site → Import an existing project** → pick the repository.
2. **Base directory**: `price-action-analyst`. Build command and publish directory come from `netlify.toml` (`npm run build`, `dist`).
3. Before the first deploy, add the environment variables below.

## 4. Environment variables (Site configuration → Environment variables)

Generate secrets with `openssl rand -base64 48`. Mark secrets as **secret** values, scoped to **Functions** (and Builds only where noted).

| Variable | Required | Value |
|---|---|---|
| `APP_ENV` | yes | `production` |
| `APP_URL` | yes | Your site URL, e.g. `https://your-site.netlify.app` (or custom domain) |
| `AUTH_SECRET` | yes | 32+ random characters (signs session cookies) |
| `INTERNAL_JOB_SECRET` | yes | 32+ random characters, different from `AUTH_SECRET` (authorises the background job) |
| `DB_DRIVER` | yes | `postgres` |
| `DATABASE_URL` | yes | Pooled PostgreSQL URL |
| `STORAGE_DRIVER` | yes | `netlify` |
| `AI_PROVIDER` | yes | `anthropic` |
| `ANTHROPIC_API_KEY` | yes | Your Anthropic key (server-side only; never exposed to the browser) |
| `ANALYSIS_EXECUTION` | yes | `background` |
| `ANTHROPIC_MODEL` | no | Default `claude-opus-5-5`. `claude-sonnet-5-5` is cheaper and faster. |
| `ANTHROPIC_EFFORT` | no | Default `high`. `medium` is faster and cheaper; `xhigh`/`max` go deeper. |
| `REGISTRATION_INVITE_CODE` | recommended | Set this so strangers cannot sign up and spend your API credit |
| `REGISTRATION_ENABLED` | no | Set `false` once your account(s) exist |
| `MONTHLY_BUDGET_USD` | recommended | App-wide hard stop on estimated AI spend per calendar month |
| `RATE_LIMIT_ANALYSES_PER_HOUR` / `_PER_DAY` | no | Per-user limits (defaults 10 / 40) |

All other variables in `.env.example` have sensible defaults. The app refuses to start in production if a required value is missing or unsafe (for example the mock AI, the in-memory DB, or a short secret), and the error appears in the function logs.

## 5. Deploy and verify

1. Trigger a deploy. Then open `https://<site>/api/health` → `{"ok":true}`.
2. Open the site, create your account (with the invite code if set), and set your balance and risk in **Settings**.
3. Upload 2–3 timeframes of one instrument. The progress screen appears, and the result arrives in about 1–3 minutes.
4. Netlify → **Logs → Functions** shows `analysis.model_response` (tokens, duration) and `analysis.completed` for each job.
5. After creating your account(s), set `REGISTRATION_ENABLED=false` and redeploy.

## 6. If background functions are not available on your plan

Set `ANALYSIS_EXECUTION=inline`. The analysis then runs inside the 60-second synchronous function. To fit, use `ANTHROPIC_MODEL=claude-sonnet-5-5` and `ANTHROPIC_EFFORT=medium`, and upload fewer screenshots. If a request still exceeds 60 s, the job is marked failed after 16 minutes and can be retried. Background mode is strongly preferred.

## 7. Costs

- **Anthropic**: per analysis, roughly 1.5k–3k input tokens per screenshot, plus the system prompt (cached after the first call), plus the output and thinking tokens. With `claude-opus-5-5` at high effort, expect very roughly **$0.10–$0.40 per multi-timeframe analysis**. The exact estimated cost of each analysis appears on its page, and the monthly total on the dashboard. Cheaper: `claude-sonnet-5-5`, `ANTHROPIC_EFFORT=medium`, fewer screenshots.
- **Netlify**: function invocations and Blobs storage. A personal deployment usually fits the free or starter tier.
- **Neon**: the free tier is enough for personal use.

Cost controls built in: client-side compression, a 6-image cap, duplicate detection (identical uploads reuse the previous result), per-user hourly/daily limits, `MONTHLY_BUDGET_USD`, prompt caching, and an invite-only sign-up option.

## 8. Operating without Claude Code

Once deployed, the app depends only on Netlify, your database, and your Anthropic API key. Claude Code (the development tool) is not involved at runtime: you can close it, uninstall it, or let its subscription end, and the site keeps working. To keep analyses working, keep the Anthropic API account funded and the key valid. If either lapses, the app shows "insufficient credit" or "API key rejected", and everything else (history, watchlist, settings) still works.

Updating later: push to the repository and Netlify rebuilds. Any editor works. Run `npm test` before pushing.

## 9. Security checklist

- [ ] `AUTH_SECRET` and `INTERNAL_JOB_SECRET` are long, random and different
- [ ] `ANTHROPIC_API_KEY` is only in Netlify environment variables, never in the repo or frontend
- [ ] Invite code set or registration disabled
- [ ] `MONTHLY_BUDGET_USD` set, plus a spend limit in the Anthropic console
- [ ] Database URL uses TLS (`sslmode=require`)
- [ ] Custom domain served over HTTPS (HSTS is enabled in `netlify.toml`)
