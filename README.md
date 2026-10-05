# SMC / ICT Chart Analysis Bot (Telegram + Claude)

Aap Telegram par ek hi pair ke different timeframes (1m se 1D tak) ki chart screenshots bhejte hain,
bot Claude (vision) se unhein **bina kisi indicator ke** pure price action par analyse karwata hai aur
professional SMC/ICT confluence checklist ke hisaab se trade plan deta hai:

1. **Market Structure** (D/4H/1H) — trend, BOS, CHoCH
2. **Liquidity** — EQH/EQL, trendline, Asia high/low sweeps, Inducement (IDM)
3. **POIs** — Order Block, FVG, Supply/Demand, Breaker/Mitigation block
4. **Key Levels + Premium/Discount** — 0.5 Fib of the dealing range
5. **LTF Confirmation** (15m/5m/1m) — CHoCH/BOS, rejection, engulfing, displacement
6. **Session & News** — London/NY killzone (bot khud time se calculate karta hai) + Forex Factory red-folder news
7. **Trades** — 🎯 Choti trade (1M entry) aur 🏔️ Bari trade (swing): entry, SL, TP1/2/3, trigger, reason
8. **Money Management** — RR aur lot size **code mein** calculate hota hai (AI par nahi chhora), 1:3 se kam RR par warning

Agar confluence poora nahi, to bot "no trade / wait" bolta hai — force trade nahi deta.

## Setup

```bash
git clone <repo> && cd usman
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # phir .env mein keys dalein
python -m smc_bot.bot
```

`.env` mein:
- `ANTHROPIC_API_KEY` — https://console.anthropic.com se
- `TELEGRAM_BOT_TOKEN` — Telegram par **@BotFather** → `/newbot`
- `ALLOWED_USER_IDS` — apni Telegram ID (@userinfobot se). Zaroor set karein, warna koi bhi aap ke API kharche par bot use kar sakta hai.

## Use kaise karein

```
/pair XAUUSD
/balance 1000
/risk 1
```
Phir screenshots bhejein, har pic ke caption mein timeframe: `1D`, `4H`, `1H`, `15m`, `5m`, `1m`.
Sab bhejne ke baad: `/analyze` (ya `/analyze sirf sell setups dekho` notes ke saath).

Tips:
- Pic ko **File** ke taur par bhejein taa ke price axis saaf parha jaye (Telegram photo compress kar deta hai).
- Price scale (right side) screenshot mein nazar aana chahiye.
- Lot size forex (100,000/lot) aur gold (100 oz/lot) ke liye auto hai; indices/crypto broker par depend karte hain — `/contract <units per lot>` set karein.
  USD-quote pairs (EURUSD, XAUUSD, US indices) par lot math exact hai; baqi par approx (bot batata hai).

## Bina Telegram ke (local test)

```bash
python -m smc_bot.cli d.png:1D h4.png:4H h1.png:1H m5.png:5m m1.png:1m --symbol XAUUSD --balance 1000 --risk 1
```

## Tests

```bash
pip install pytest && python -m pytest -q
```

## Zaroori baat

Screenshots se levels parhne mein AI galti kar sakta hai, aur koi bhi analysis 100% sahi nahi hota.
Har entry se pehle live chart par levels confirm karein aur risk 1–2% se zyada na rakhein.
Yeh tool analysis mein madad ke liye hai — financial advice nahi.
