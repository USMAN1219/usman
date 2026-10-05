/**
 * Client-side image preparation, to cut upload size and AI token cost.
 *
 * Screenshots are downscaled so the long edge is at most MAX_EDGE pixels and
 * re-encoded (WebP when the browser supports it, otherwise high-quality JPEG).
 * Chart text must stay readable, so quality stays high and small images are
 * left untouched. The server re-validates everything.
 */
export const MAX_EDGE = 2000;
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.7];

export interface PreparedImage {
  file: File;
  previewUrl: string;
  width: number;
  height: number;
  originalBytes: number;
  sha256: string;
}

/** Content fingerprint for duplicate detection. SHA-256 where available, FNV-1a otherwise (non-secure contexts). */
async function sha256(buf: ArrayBuffer) {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 0x811c9dc5;
  for (const b of new Uint8Array(buf)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return `fnv-${h.toString(16)}-${buf.byteLength}`;
}

export const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function prepareImage(file: File, maxBytes: number): Promise<PreparedImage> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error(`${file.name}: only PNG, JPEG or WebP screenshots are supported.`);
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`${file.name}: the image could not be decoded.`);
  });
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));

  let out: File = file;
  let outW = width;
  let outH = height;
  if (scale < 1 || file.size > maxBytes) {
    outW = Math.round(width * scale);
    outH = Math.round(height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    const probe = await canvasToBlob(canvas, "image/webp", 0.9);
    const type = probe?.type === "image/webp" ? "image/webp" : "image/jpeg";
    let blob: Blob | null = null;
    for (const q of QUALITY_STEPS) {
      blob = await canvasToBlob(canvas, type, q);
      if (blob && blob.size <= maxBytes) break;
    }
    if (!blob || blob.size > maxBytes) throw new Error(`${file.name}: still larger than the upload limit after compression.`);
    out = new File([blob], file.name.replace(/\.\w+$/, type === "image/webp" ? ".webp" : ".jpg"), { type });
  }
  bitmap.close();
  return {
    file: out,
    previewUrl: URL.createObjectURL(out),
    width: outW,
    height: outH,
    originalBytes: file.size,
    sha256: await sha256(await out.arrayBuffer()),
  };
}

/** Best-effort timeframe guess from a filename such as "EURUSD_4H.png" or "btc-15m.png". */
export function guessTimeframe(name: string): string | null {
  const m = name.toLowerCase().match(/(?:^|[^a-z0-9])(1m|5m|15m|30m|1h|4h|1d|d1|h1|h4|m1|m5|m15|m30|daily)(?:[^a-z0-9]|$)/);
  if (!m) return null;
  const map: Record<string, string> = { d1: "1D", "1d": "1D", daily: "1D", h1: "1h", h4: "4h", m1: "1m", m5: "5m", m15: "15m", m30: "30m" };
  return map[m[1]!] ?? m[1]!;
}
