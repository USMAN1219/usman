# Free setup: web only, no payment, no terminal

This puts the app online for **free**, using only your web browser.

| Part | Free service | Card needed? |
|---|---|---|
| Website + API | Netlify (Free plan) | No |
| AI that reads charts | Google Gemini API, free tier (key from Google AI Studio) | No |
| Database | Neon (Free plan) | No |
| Screenshot storage | Netlify Blobs (included with Netlify) | No |

**Free-tier limits and trade-offs (please read):**
- Gemini's free tier allows only a limited number of requests per minute and per day. If you hit the limit, the app says "Free AI limit reached". Wait a minute, or try again tomorrow.
- On the free tier, **Google may use your uploaded screenshots to improve its products.** Do not upload screenshots that show account numbers, balances or personal information.
- Each analysis must finish within about 60 seconds (Netlify free limit). Upload 1–3 screenshots at a time for best results.
- Free AI models are good but not perfect. Always check the chart yourself.

---

## Step 1: Get a free Gemini API key (about 2 minutes)

1. Open **https://aistudio.google.com** and sign in with a Google account.
2. Click **Get API key** → **Create API key**.
3. Copy the key (it looks like `AIza...`). Keep it private.

## Step 2: Create a free database (about 3 minutes)

1. Open **https://neon.tech** → **Sign up** (you can use GitHub or Google).
2. Create a project with any name and the region closest to you.
3. On the project dashboard click **Connect**, turn **Connection pooling ON**, and copy the connection string. It looks like:
   `postgresql://user:password@ep-xxxx-pooler.region.aws.neon.tech/neondb?sslmode=require`

You don't need to create any tables: the app creates them automatically the first time it runs.

## Step 3: Put the app on Netlify (about 5 minutes)

1. Open **https://app.netlify.com** → **Sign up with GitHub**.
2. Click **Add new project → Import an existing project → GitHub** and choose the repository **USMAN1219/usman**.
3. Settings:
   - **Branch to deploy**: the branch that contains the app (for example `claude/adoring-pasteur-3qokqu`, or `main` after you merge it).
   - **Base directory**: `price-action-analyst`
   - Leave the build command and publish directory as Netlify fills them in (they come from `netlify.toml`).
4. Before clicking Deploy, open **Add environment variables** and add these four:

| Key | Value |
|---|---|
| `GEMINI_API_KEY` | the key from Step 1 |
| `DATABASE_URL` | the connection string from Step 2 |
| `AUTH_SECRET` | a long random password, **at least 40 characters** (use any password generator) |
| `REGISTRATION_INVITE_CODE` | a secret word only you know (stops strangers creating accounts) |

5. Click **Deploy**. After a minute or two you'll get a link like `https://your-name.netlify.app`.

## Step 4: Use it

1. Open your link → **No account? Create one** → enter your email, a password and your invite code.
2. Go to **Settings** and enter your account balance and risk % (0.5%–1% is recommended).
3. On the **Dashboard**, drop your chart screenshots (for example 4H, 1H, 15M of the same pair) → **Analyse charts**.
4. The result appears in about 20–60 seconds: setup or **NO TRADE — WAIT**, entry, SL, TP, R:R, grade and drawings on the chart.

Open the same link on your phone; the app works in mobile browsers too.

---

## If something goes wrong

| Message | What to do |
|---|---|
| "Free AI limit reached" | Wait 1 minute (per-minute limit) or until tomorrow (daily limit). |
| "Gemini API key rejected" | Check `GEMINI_API_KEY` in Netlify → Site configuration → Environment variables, then **Deploys → Trigger deploy**. |
| "The database is not reachable" | Check `DATABASE_URL` (must be the pooled string ending in `sslmode=require`). |
| "model … was not found" | Add `GEMINI_MODEL` with a current free Flash model name from AI Studio, then redeploy. |
| "The AI took too long" | Upload fewer screenshots (1–2) and try again. |
| The site shows an error right after deploy | Netlify → **Logs → Functions** shows the reason, e.g. a missing variable or an `AUTH_SECRET` that is too short. |

## Does it depend on Claude Code?

No. After deployment the app runs on Netlify, Neon and Google's free Gemini API. Claude Code is not needed at all, and nothing you pay for is required.

## Optional: switch to a paid AI later

If you want deeper analysis and are willing to pay per use, add `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` (from console.anthropic.com). See [DEPLOYMENT.md](DEPLOYMENT.md).
