// claude.ai build: asks Claude through the artifact's `sample` capability (viewer's own Claude account).
import { startApp } from "./core.js";

const ERR = {
  not_granted: "Is page ko Claude use karne ki ijazat nahi mili. Page ke Permissions menu se allow karein.",
  sampling_disabled: "Aap ke account par yeh feature available nahi.",
  images_unavailable: "Is view mein images nahi bheji ja saktein. Page ko claude.ai par browser mein kholein.",
  image_rejected: "Koi image qabool nahi hui (type ya size). PNG/JPG screenshot dobara daalein.",
  rate_limited: "Abhi bohat zyada requests ho gayi hain ya usage limit poori. Thori der baad try karein.",
  session_expired: "Dobara sign in karein.",
  refused: "Claude ne yeh request decline kar di. Notes badal kar dobara try karein.",
  empty_completion: "Jawab khali aaya. Kam pics ke saath dobara try karein.",
  prompt_too_large: "Request bohat bari hai. Notes chhote karein.",
};

let sample = null;
const app = startApp({
  async analyze({ rules, context, charts, signal, onText }) {
    try {
      return await sample(`${rules}\n\n---\n${context}`, {
        images: charts.map((c) => c.file),
        modelTier: "complex",
        cache: false,
        signal,
        onText: ({ text }) => onText(text),
      });
    } catch (e) {
      throw { cancelled: e?.code === "cancelled", keepText: e?.code !== "refused", userMessage: ERR[e?.code] };
    }
  },
});

(async () => {
  sample = await window.claude?.use?.("sample").catch(() => null);
  if (!sample) return app.setReady(false, { note: "Yeh page sirf claude.ai par (signed in) chalta hai. Apni API key wala version Netlify par chalayein." });
  const lim = await sample.limits().catch(() => null);
  if (!lim?.images) return app.setReady(false, { note: "Is view mein images bhejna supported nahi. claude.ai ko web browser mein kholein." });
  app.setReady(true, { maxImages: lim.images.maxCount || 10, accept: lim.images.mediaTypes.join(",") });
})();
