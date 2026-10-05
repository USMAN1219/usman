// Netlify / self-hosted build: calls the Claude API straight from the browser with the trader's own API key.
// The key stays in this browser (localStorage) and is sent only to api.anthropic.com.
import Anthropic from "@anthropic-ai/sdk";
import { startApp, store } from "./core.js";

const $ = (id) => document.getElementById(id);
const MAX_IMAGES = 12;
const MAX_SIDE = 1800;
// Models that accept server-side refusal fallbacks ("default" mode)
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"]);

async function toImageBlock(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const data = c.toDataURL("image/jpeg", 0.9).split(",")[1];
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
}

function userMessage(e) {
  if (e instanceof Anthropic.AuthenticationError) return "API key galat hai. Settings mein sahi key daalein.";
  if (e instanceof Anthropic.PermissionDeniedError) return "Is API key ko is model ki ijazat nahi.";
  if (e instanceof Anthropic.RateLimitError) return "Rate limit — thori der baad try karein.";
  if (e instanceof Anthropic.NotFoundError) return "Model ID ghalat hai ya band ho chuka hai. Settings mein model badlein.";
  if (e instanceof Anthropic.BadRequestError) {
    const m = String(e.message || "");
    if (/credit|balance/i.test(m)) return "Anthropic account mein credit khatam. console.anthropic.com par billing check karein.";
    return "Request reject hui: " + m.slice(0, 200);
  }
  if (e instanceof Anthropic.InternalServerError) return "Anthropic server busy hai (overloaded). Ek minute baad try karein.";
  if (e instanceof Anthropic.APIConnectionError) return "Internet / connection ka masla. Dobara try karein.";
  return null;
}

const app = startApp({
  async analyze({ rules, context, charts, signal, onText }) {
    const apiKey = $("apiKey").value.trim();
    const model = $("model").value.trim() || "claude-opus-5-5";
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 10 * 60 * 1000 });
    const images = await Promise.all(charts.map((c) => toImageBlock(c.file)));
    const content = [];
    charts.forEach((c, i) => {
      content.push({ type: "text", text: `Image ${i + 1} — timeframe: ${c.tf || "unknown"}` });
      content.push(images[i]);
    });
    content.push({ type: "text", text: context + "\n\nAb in charts ka analysis aur trade plan do." });

    const params = {
      model,
      max_tokens: 32000,
      system: [{ type: "text", text: rules, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    };
    if (FALLBACK_MODELS.has(model)) Object.assign(params, { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });

    let text = "";
    try {
      const stream = client.beta.messages.stream(params, { signal });
      stream.on("text", (_delta, snapshot) => { text = snapshot; onText(snapshot); });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === "refusal") throw { userMessage: "Claude ne yeh request decline kar di. Notes badal kar dobara try karein.", keepText: false };
      text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      return { text, truncated: msg.stop_reason === "max_tokens" };
    } catch (e) {
      if (e?.userMessage) throw e;
      if (signal.aborted || e instanceof Anthropic.APIUserAbortError) throw { cancelled: true, keepText: true };
      throw { keepText: true, userMessage: userMessage(e) };
    }
  },
});

// ---------- settings: API key + model ----------
function refresh() {
  const hasKey = $("apiKey").value.trim().startsWith("sk-ant-");
  $("keyState").textContent = hasKey ? "Key set hai" : "Key nahi";
  $("keyState").className = "chip " + (hasKey ? "on" : "off");
  app.setReady(hasKey, {
    maxImages: MAX_IMAGES, accept: "image/png,image/jpeg,image/webp,image/gif",
    note: hasKey ? "" : "Shuru karne ke liye neeche Settings mein apni Anthropic API key daalein.",
  });
  $("settings").open ||= !hasKey;
}
$("apiKey").value = store.get("smc-api-key", "") || "";
$("model").value = store.get("smc-model", "claude-opus-5-5") || "claude-opus-5-5";
$("rememberKey").checked = store.get("smc-remember", true) !== false;
$("apiKey").addEventListener("input", () => {
  if ($("rememberKey").checked) store.set("smc-api-key", $("apiKey").value.trim());
  refresh();
});
$("rememberKey").addEventListener("change", () => {
  store.set("smc-remember", $("rememberKey").checked);
  if ($("rememberKey").checked) store.set("smc-api-key", $("apiKey").value.trim()); else store.del("smc-api-key");
});
$("model").addEventListener("change", () => store.set("smc-model", $("model").value.trim()));
refresh();
