// Page logic shared by both builds. The build-specific "adapter" only knows how to ask Claude.
import { RULES, buildContext } from "./prompt.js";

const $ = (id) => document.getElementById(id);
export const TF = ["1W", "1D", "4H", "2H", "1H", "30m", "15m", "5m", "3m", "1m"];

// ---------- storage (per-browser convenience; never required) ----------
export const store = {
  get(key, fallback = null) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

// ---------- sessions / killzones (New York time) ----------
function nyParts(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { wd: p.weekday, h: +p.hour, m: +p.minute };
}
export function sessionInfo(d = new Date()) {
  const { wd, h, m } = nyParts(d);
  const t = h + m / 60;
  const closed = wd === "Sat" || (wd === "Fri" && t >= 17) || (wd === "Sun" && t < 17);
  const active = [];
  if (t >= 20) active.push("Asia Session");
  if (t >= 2 && t < 5) active.push("London Killzone");
  if (t >= 7 && t < 10) active.push("New York Killzone");
  if (t >= 10 && t < 12) active.push("London Close");
  return {
    closed, active: closed ? [] : active, kz: !closed && active.some((s) => s.includes("Killzone")),
    utc: d.toISOString().slice(0, 16).replace("T", " "),
    ny: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, wd,
  };
}

// ---------- timeframe guess from file name ----------
export function guessTf(name) {
  const t = " " + name.toLowerCase().replace(/[_\-.]/g, " ") + " ";
  let m;
  if ((m = t.match(/\b(1|3|5|15|30)\s*(m|min|mins|minute)\b/)) || (m = t.match(/\bm(1|3|5|15|30)\b/))) return m[1] + "m";
  if ((m = t.match(/\b(1|2|4)\s*(h|hr|hour)\b/)) || (m = t.match(/\bh(1|4)\b/))) return m[1] + "H";
  if (/\b1?\s*(d|day|daily)\b/.test(t)) return "1D";
  if (/\b1?\s*(w|week|weekly)\b/.test(t)) return "1W";
  return "";
}

// ---------- risk math (done here, never by the model) ----------
const CONTRACTS = [["XAU", 100], ["GOLD", 100], ["XAG", 5000], ["SILVER", 5000], ["BTC", 1], ["ETH", 1],
  ["US30", 1], ["NAS", 1], ["US100", 1], ["SPX", 1], ["US500", 1], ["GER40", 1], ["DE40", 1], ["UK100", 1], ["WTI", 1000], ["USOIL", 1000]];
export function contractFor(sym) {
  const s = (sym || "").toUpperCase().replace(/[\/_]/g, "");
  if (!s) return null;
  for (const [p, v] of CONTRACTS) if (s.startsWith(p)) return v;
  return /^[A-Z]{6}$/.test(s) ? 100000 : null;
}
const quoteUsd = (sym) => { const s = (sym || "").toUpperCase().replace("/", ""); return /^[A-Z]{6}$/.test(s) ? s.endsWith("USD") : true; };
export const num = (x) => (x === null || x === undefined || x === "" || isNaN(+x) ? null : +x);
export const fmt = (x) => Math.abs(x) < 10 ? (+x.toFixed(5)).toString() : x.toLocaleString("en-US", { maximumFractionDigits: 2 });

export function sizeLeg(leg, bal, riskPct, contract) {
  const entry = num(leg?.entry), sl = num(leg?.stop_loss);
  const tps = (leg?.take_profits || []).map(num).filter((v) => v !== null);
  const dir = leg?.direction;
  if (!["long", "short"].includes(dir) || entry === null || sl === null || !tps.length) return null;
  const errors = [];
  if (dir === "long" && sl >= entry) errors.push("Long mein SL entry se neeche hona chahiye.");
  if (dir === "long" && tps.some((t) => t <= entry)) errors.push("Long mein har TP entry se upar hona chahiye.");
  if (dir === "short" && sl <= entry) errors.push("Short mein SL entry se upar hona chahiye.");
  if (dir === "short" && tps.some((t) => t >= entry)) errors.push("Short mein har TP entry se neeche hona chahiye.");
  const stop = Math.abs(entry - sl);
  const riskAmt = bal * riskPct / 100;
  const rr = stop ? tps.map((t) => Math.abs(t - entry) / stop) : [];
  const lots = stop && contract ? Math.floor((riskAmt / stop / contract) * 100 + 1e-9) / 100 : null;
  return { dir, entry, sl, tps, rr, stop, riskAmt, lots, units: stop ? riskAmt / stop : 0, errors };
}

export function parseTrade(text) {
  const m = text.match(/<trade_json>\s*([\s\S]*?)\s*<\/trade_json>/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/^```(json)?|```$/g, "").trim()); } catch { return null; }
}

// ---------- rendering ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

function renderReport(text) {
  const visible = text.split("<trade_json>")[0].trim();
  const html = [];
  let inList = false;
  for (const line of visible.split("\n")) {
    const l = line.trim();
    if (/^[-*]\s+/.test(l)) { if (!inList) { html.push("<ul>"); inList = true; } html.push(`<li>${inline(l.replace(/^[-*]\s+/, ""))}</li>`); continue; }
    if (inList) { html.push("</ul>"); inList = false; }
    if (/^#{1,4}\s+/.test(l)) html.push(`<h3>${inline(l.replace(/^#+\s+/, ""))}</h3>`);
    else if (l) html.push(`<p>${inline(l)}</p>`);
  }
  if (inList) html.push("</ul>");
  $("reportBody").innerHTML = html.join("");
  $("report").hidden = !visible;
}

const SETUP = { retest: "Retest entry", breakout: "Breakout entry", liquidity_sweep_reversal: "Liquidity sweep reversal" };
const BREAKOUT = {
  real_breakout: ["Real breakout", "bull"], fake_breakout: ["Fake breakout (liquidity grab)", "bear"],
  retesting: ["Level retest ho raha hai", "warn"], no_breakout_yet: ["Abhi breakout nahi hua", "muted"],
};
const MGMT = [["breakeven", "Breakeven"], ["partial", "Partial profit"], ["trail", "Trailing SL"], ["time_stop", "Time stop"], ["exit_early", "Foran exit"]];

function legCard(title, leg, sized, riskPct, sym) {
  const card = document.createElement("article");
  card.className = "card";
  const dir = sized?.dir || (["long", "short"].includes(leg?.direction) ? leg.direction : "none");
  const pill = dir === "long" ? "LONG" : dir === "short" ? "SHORT" : "—";
  const grade = leg?.grade ? `<span class="grade g-${esc(String(leg.grade).replace("+", "p"))}" title="Setup quality">${esc(leg.grade)}</span>` : "";
  let body = "";
  if (!sized) {
    body = `<p class="muted">Levels parse nahi ho sake — neeche poori analysis dekhein.</p>`;
  } else {
    const rows = [
      `<tr><td>Entry${leg.entry_type ? ` <span class="muted">· ${leg.entry_type === "limit" ? "pending order" : "confirmation ke baad"}</span>` : ""}</td><td>${fmt(sized.entry)}</td><td></td></tr>`,
      `<tr class="sl"><td>Stop loss</td><td>${fmt(sized.sl)}</td><td></td></tr>`,
      ...sized.tps.map((t, i) => `<tr class="tp"><td>TP${i + 1}</td><td>${fmt(t)}</td><td>1:${sized.rr[i] ? sized.rr[i].toFixed(1) : "—"}</td></tr>`),
    ].join("");
    const lotTxt = sized.lots === null ? `${sized.units.toFixed(4)} units` :
      sized.lots < 0.01 ? "0.01 bhi zyada risk" : `${sized.lots.toFixed(2)} lots${quoteUsd(sym) ? "" : " (approx)"}`;
    const conf = Math.max(0, Math.min(100, num(leg.confidence) ?? 0));
    const mg = leg.management || {};
    const mgRows = MGMT.filter(([k]) => mg[k]).map(([k, l]) => `<li><b>${l}:</b> ${esc(mg[k])}</li>`).join("");
    body = `
      ${leg.setup ? `<div class="setup">${esc(SETUP[leg.setup] || leg.setup)}</div>` : ""}
      ${leg.trigger ? `<p class="trigger"><b>Entry kab:</b> ${esc(leg.trigger)}</p>` : ""}
      <table class="lv">${rows}</table>
      <dl class="kv"><dt>Risk</dt><dd>$${sized.riskAmt.toFixed(2)} (${riskPct}%)</dd>
      <dt>Position</dt><dd>${lotTxt}</dd>
      <dt>Kitni der</dt><dd>${esc(leg.hold_time || "—")}</dd>
      <dt>Confidence</dt><dd>${conf}%</dd></dl>
      <div class="conf" aria-hidden="true"><i style="width:${conf}%"></i></div>
      ${mgRows ? `<div class="mgmt"><div class="label">Trade management</div><ul>${mgRows}</ul></div>` : ""}`;
  }
  card.innerHTML = `<div class="card-head"><h3>${title}</h3><span class="tags">${grade}<span class="pill ${dir}">${pill}</span></span></div>${body}`;
  return card;
}

function drawMap(trade, charts, sized) {
  const box = $("map");
  box.replaceChildren();
  const cm = trade?.chart_map;
  const idx = num(cm?.image);
  const a = cm?.axis;
  if (!sized || idx === null || !charts[idx - 1] || !Array.isArray(a) || a.length < 2) return;
  const [p1, y1, p2, y2] = [num(a[0].price), num(a[0].y), num(a[1].price), num(a[1].y)];
  if ([p1, y1, p2, y2].includes(null) || p1 === p2) return;
  const yOf = (price) => y1 + (price - p1) * (y2 - y1) / (p2 - p1);

  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 1400 / img.naturalWidth);
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim();
    const lines = [
      ["ENTRY", sized.entry, "#3b6cf6"], ["SL", sized.sl, "#e5484d"],
      ...sized.tps.map((t, i) => [`TP${i + 1}`, t, "#12a26b"]),
    ];
    const kl = num(trade.key_level?.price);
    if (kl !== null) lines.push(["KEY", kl, "#d4920a", true]);
    const font = Math.max(12, Math.round(w / 70));
    g.font = `600 ${font}px ${col("--f-mono") || "monospace"}`;
    let drawn = 0;
    const placed = []; // label boxes already drawn, so close levels don't overlap
    for (const [label, price, color, dashed] of lines) {
      const y = yOf(price) * h;
      if (!(y > -2 && y < h + 2)) continue;
      drawn++;
      g.strokeStyle = color; g.lineWidth = Math.max(2, w / 600);
      g.setLineDash(dashed ? [10, 6] : []);
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      const txt = `${label} ${fmt(price)}`;
      const tw = g.measureText(txt).width + 12;
      let x = 8;
      for (const p of placed) if (Math.abs(p.y - y) < font + 8) x = Math.max(x, p.x + p.w + 6);
      placed.push({ x, y, w: tw });
      g.fillStyle = color; g.fillRect(x, y - font - 6, tw, font + 8);
      g.fillStyle = "#fff"; g.fillText(txt, x + 6, y - 7);
    }
    if (!drawn) return;
    const fig = document.createElement("figure");
    fig.className = "map";
    fig.append(c);
    const cap = document.createElement("figcaption");
    cap.textContent = `Trade map · ${charts[idx - 1].tf || "chart " + idx} · lines takreeban jagah par hain — price scale se mila kar dekhein.`;
    fig.append(cap);
    box.append(fig);
  };
  img.src = charts[idx - 1].url;
}

function renderTrade(trade, charts = []) {
  const sym = $("pair").value.trim() || trade?.symbol || "";
  const bal = +$("balance").value || 0, riskPct = +$("risk").value || 0;
  const contract = num($("contract").value) || contractFor(sym);

  const nm = trade?.next_move || {};
  const cls = nm.direction === "up" ? "up" : nm.direction === "down" ? "down" : "side";
  const word = nm.direction === "up" ? "Upar (Bullish)" : nm.direction === "down" ? "Neeche (Bearish)" : "Sideways";
  const trend = trade?.htf_trend ? `HTF trend: ${esc(trade.htf_trend)}` : "";
  $("move").innerHTML = trade ? `<div class="move ${cls}">
      <span class="label">Agla probable move${sym ? " · " + esc(sym) : ""}${num(trade.current_price) !== null ? " · abhi " + fmt(+trade.current_price) : ""}${trend ? " · " + trend : ""}</span>
      <div class="dir">${word}${num(nm.target) !== null ? ` → ${fmt(+nm.target)}` : ""}</div>${nm.summary ? `<p>${esc(nm.summary)}</p>` : ""}</div>` : "";

  const kl = trade?.key_level;
  const bo = BREAKOUT[kl?.breakout_status];
  $("keylevel").innerHTML = kl && num(kl.price) !== null ? `<div class="keylevel">
      <div><span class="label">Key level${kl.type ? " · " + esc(kl.type) : ""}</span><div class="kl-price">${fmt(+kl.price)}</div></div>
      <div class="kl-body">${bo ? `<span class="chip st-${bo[1]}">${bo[0]}</span>` : ""}${kl.why ? `<p>${esc(kl.why)}</p>` : ""}</div></div>` : "";

  const warns = [];
  const cards = [];
  let scalpSized = null;
  for (const [key, title] of [["scalp", "Choti trade · 1M entry"], ["swing", "Bari trade · Swing"]]) {
    const leg = trade?.[key];
    const sized = leg ? sizeLeg(leg, bal, riskPct, contract) : null;
    if (key === "scalp") scalpSized = sized;
    if (leg) cards.push(legCard(title, leg, sized, riskPct, sym));
    if (!sized) continue;
    sized.errors.forEach((e) => warns.push(["bad", `${title}: ${e}`]));
    if (sized.rr.length && Math.max(...sized.rr) < 3) warns.push(["", `${title}: final target ka RR 1:${Math.max(...sized.rr).toFixed(1)} hai (1:3 se kam) — position chhoti rakhein ya TP2 tak hold karein.`]);
    const t = (trade.htf_trend || "").toLowerCase();
    if ((t === "bullish" && sized.dir === "short") || (t === "bearish" && sized.dir === "long")) warns.push(["bad", `${title}: HTF trend ke khilaf hai (counter-trend). Trend is your friend — size aadha rakhein ya skip karein.`]);
    if (sized.lots === null) warns.push(["", `${title}: lot size ke liye "Units per lot" bharein (forex 100000, gold 100).`]);
  }
  $("cards").replaceChildren(...cards);

  const alt = trade?.alternate;
  $("alt").innerHTML = alt?.if ? `<div class="alt"><span class="label">Agar plan fail ho</span><p><b>Agar:</b> ${esc(alt.if)}</p>${alt.then ? `<p><b>To:</b> ${esc(alt.then)}</p>` : ""}</div>` : "";

  const s = sessionInfo();
  if (riskPct > 2) warns.push(["", `${riskPct}% risk zyada hai — pro traders 1–2% se upar nahi jaate.`]);
  if (s.closed) warns.push(["", "Market abhi band hai (weekend)."]);
  else if (!s.kz) warns.push(["", "Abhi London/NY killzone nahi — breakouts zyada fake hote hain. Entry killzone mein lein."]);
  if (trade) warns.push(["", "Levels screenshot se parhe gaye hain — live chart par confirm karein, aur Forex Factory par news dekh lein."]);
  $("warns").replaceChildren(...warns.map(([c, t]) => { const li = document.createElement("li"); if (c) li.className = c; li.textContent = t; return li; }));

  drawMap(trade, charts, scalpSized);
}

function showError(msg) { $("errBox").textContent = msg || ""; $("errBox").hidden = !msg; }

// ---------- example shown on first load ----------
const EXAMPLE = {
  symbol: "XAUUSD", current_price: 2351.4, htf_trend: "bearish",
  next_move: { direction: "down", target: 2338.0, summary: "1H par buyside liquidity (EQH 2356) sweep ho chuki, 15m CHoCH neeche — price 1H FVG 2338 ki taraf ja sakti hai." },
  key_level: { price: 2354.0, type: "supply", breakout_status: "fake_breakout", why: "2356 ke upar sirf wick gayi, 15m candle wapas andar close hui aur koi FVG nahi bana." },
  scalp: { direction: "short", grade: "A", setup: "liquidity_sweep_reversal", entry: 2353.0, stop_loss: 2356.8, take_profits: [2345.0, 2338.0], entry_type: "confirmation",
    trigger: "15m FVG 2352–2354 tap ke baad 1m CHoCH 2350.5 ke neeche", hold_time: "30 min – 2 ghante",
    management: { breakeven: "TP1 (2345) hit hote hi SL entry par", partial: "TP1 par 50% close", trail: "baqi ka SL 5m swing high ke upar", time_stop: "2 ghante mein TP1 na aaye to close", exit_early: "5m bullish CHoCH 2355 ke upar" }, confidence: 65 },
  swing: { direction: "short", grade: "B", setup: "retest", entry: 2356.0, stop_loss: 2366.0, take_profits: [2330.0, 2312.0], entry_type: "limit",
    trigger: "4H supply 2354–2360 ka retest", hold_time: "1–3 din",
    management: { breakeven: "1:1.5 par SL entry par", partial: "TP1 par 50%", trail: "1H swing highs ke upar", time_stop: "3 din mein TP1 na aaye to band", exit_early: "4H body close 2366 ke upar" }, confidence: 55 },
  alternate: { if: "15m body close 2357 ke upar aur retest hold kare (real breakout)", then: "short cancel; 2357 retest par long, SL 2351, TP 2370" },
};

// ---------- app ----------
export function startApp(adapter) {
  const state = { charts: [], maxImages: 10, ready: false, ctl: null, raw: "" };

  const SETTINGS = ["pair", "balance", "risk", "contract"];
  const saved = store.get("smc-settings", {});
  for (const k of SETTINGS) if (saved?.[k] != null && saved[k] !== "") $(k).value = saved[k];
  const save = () => store.set("smc-settings", Object.fromEntries(SETTINGS.map((k) => [k, $(k).value])));
  SETTINGS.forEach((k) => $(k).addEventListener("change", save));

  const renderClock = () => {
    const s = sessionInfo();
    $("clockTxt").textContent = `${s.utc} UTC · NY ${s.ny}`;
    const chip = $("kzChip");
    chip.className = "chip " + (s.kz ? "on" : "off");
    chip.textContent = s.closed ? "Market band (weekend)" : s.kz ? s.active.find((x) => x.includes("Killzone")) : (s.active[0] || "Off-session");
  };
  renderClock();
  setInterval(renderClock, 30000);

  const updateGo = () => { $("go").disabled = !state.ready || !state.charts.length || !!state.ctl; };

  function addFiles(files) {
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      if (state.charts.length >= state.maxImages) { showError(`Ek dafa mein ${state.maxImages} pics tak. Sab se zaroori timeframes rakhein.`); break; }
      state.charts.push({ file: f, url: URL.createObjectURL(f), tf: guessTf(f.name || "") });
    }
    renderThumbs();
  }
  function renderThumbs() {
    $("thumbs").replaceChildren(...state.charts.map((c, i) => {
      const el = document.createElement("div");
      el.className = "thumb";
      const opts = ['<option value="">Timeframe?</option>', ...TF.map((t) => `<option${t === c.tf ? " selected" : ""}>${t}</option>`)].join("");
      el.innerHTML = `<div class="img"><img alt="Chart ${i + 1}"><button class="x" aria-label="Hatayein">×</button></div><select id="tf-${i}" aria-label="Chart ${i + 1} timeframe">${opts}</select>`;
      el.querySelector("img").src = c.url;
      el.querySelector("select").onchange = (e) => { c.tf = e.target.value; };
      el.querySelector(".x").onclick = () => { URL.revokeObjectURL(c.url); state.charts.splice(i, 1); renderThumbs(); };
      return el;
    }));
    updateGo();
  }

  const drop = $("drop");
  drop.onclick = () => $("file").click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } };
  $("file").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("drag"); };
  drop.ondragleave = () => drop.classList.remove("drag");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("drag"); addFiles(e.dataTransfer.files); };
  document.addEventListener("paste", (e) => {
    if (e.target.closest?.("input, textarea")) return;
    const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) addFiles(files);
  });
  $("clear").onclick = () => { state.charts.forEach((c) => URL.revokeObjectURL(c.url)); state.charts = []; renderThumbs(); };

  renderTrade(EXAMPLE);

  $("go").onclick = async () => {
    if (!state.ready || !state.charts.length) return;
    const charts = [...state.charts].sort((a, b) => (a.tf ? TF.indexOf(a.tf) : 99) - (b.tf ? TF.indexOf(b.tf) : 99));
    const ctl = new AbortController();
    state.ctl = ctl;
    updateGo();
    $("stop").hidden = false;
    showError("");
    $("exampleTag").hidden = true;
    for (const id of ["move", "keylevel", "alt", "map"]) $(id).replaceChildren();
    $("cards").replaceChildren(); $("warns").replaceChildren();
    $("report").hidden = true; $("reportBody").innerHTML = "";
    $("status").hidden = false;
    $("statusTxt").textContent = `${charts.length} charts parhe ja rahe hain… pehla jawab aane mein 30–90 second lag sakte hain.`;
    state.raw = "";
    const context = buildContext({
      pair: $("pair").value.trim(), balance: $("balance").value, risk: $("risk").value,
      notes: $("notes").value.trim(), session: sessionInfo(), charts,
    });
    try {
      const { text, truncated } = await adapter.analyze({
        rules: RULES, context, charts, signal: ctl.signal,
        onText: (t) => { state.raw = t; $("statusTxt").textContent = "Analysis likhi ja rahi hai…"; renderReport(t); },
      });
      state.raw = text;
      renderReport(text);
      const trade = parseTrade(text);
      renderTrade(trade, charts);
      if (!trade) showError("Trade levels parse nahi ho sake — neeche poori analysis parhein aur lot size khud nikaalein.");
      if (truncated) showError("Jawab lamba ho kar kat gaya — kam pics ke saath dobara try karein.");
    } catch (e) {
      if (e?.keepText && state.raw) renderReport(state.raw); else if (!e?.keepText) $("reportBody").innerHTML = "";
      if (!e?.cancelled) showError(e?.userMessage || "Connection ya service ka masla aaya. Dobara 'Analyse karein' dabayein.");
    } finally {
      state.ctl = null;
      $("status").hidden = true;
      $("stop").hidden = true;
      updateGo();
    }
  };
  $("stop").onclick = () => state.ctl?.abort();
  $("copy").onclick = async () => {
    const txt = state.raw.split("<trade_json>")[0].trim();
    try { await navigator.clipboard.writeText(txt); $("copy").textContent = "Copied"; }
    catch { const r = document.createRange(); r.selectNodeContents($("reportBody")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $("copy").textContent = "Select ho gaya"; }
    setTimeout(() => ($("copy").textContent = "Copy"), 1500);
  };

  return {
    setReady(ready, { maxImages, accept, note } = {}) {
      state.ready = ready;
      if (maxImages) state.maxImages = maxImages;
      if (accept) $("file").accept = accept;
      $("limitTxt").textContent = `Ek analysis mein ${state.maxImages} pics tak`;
      if (note !== undefined) showError(note);
      updateGo();
    },
    showError,
  };
}
