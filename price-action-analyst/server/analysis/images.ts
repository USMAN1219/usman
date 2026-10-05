/**
 * Upload validation. The browser compresses images before upload, but the
 * server never trusts the client: type is detected from magic bytes (not the
 * filename or declared MIME), dimensions are read from the header, and size
 * limits are enforced per image and in total.
 */
import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import type { AppConfig } from "../config.ts";
import { badRequest, tooLarge } from "../errors.ts";

export type SupportedMime = "image/png" | "image/jpeg" | "image/webp";

export interface ValidatedImage {
  data: Uint8Array;
  mime: SupportedMime;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  label: string | null;
}

export function sniffMime(b: Uint8Array): SupportedMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP")
    return "image/webp";
  return null;
}

/** Normalises user timeframe labels such as "4 hour", "H4", "15min", "daily" -> "4h", "15m", "1D". */
export function normaliseTimeframe(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  const table: Record<string, string> = {
    "1m": "1m", "1min": "1m", "m1": "1m", "1minute": "1m",
    "5m": "5m", "5min": "5m", "m5": "5m", "5minute": "5m",
    "15m": "15m", "15min": "15m", "m15": "15m", "15minute": "15m",
    "30m": "30m", "30min": "30m", "m30": "30m", "30minute": "30m",
    "1h": "1h", "h1": "1h", "60m": "1h", "1hour": "1h", "1hr": "1h", "hourly": "1h",
    "4h": "4h", "h4": "4h", "240m": "4h", "4hour": "4h", "4hr": "4h",
    "1d": "1D", "d1": "1D", "d": "1D", "daily": "1D", "1day": "1D", "day": "1D",
  };
  return table[s] ?? raw.trim().slice(0, 16);
}

export function validateImages(
  files: { data: Uint8Array; label: string | null }[],
  cfg: Pick<AppConfig, "MAX_IMAGES" | "MAX_IMAGE_BYTES" | "MAX_TOTAL_UPLOAD_BYTES" | "MIN_IMAGE_DIMENSION">,
): ValidatedImage[] {
  if (files.length === 0) throw badRequest("Upload at least one chart screenshot.");
  if (files.length > cfg.MAX_IMAGES) throw badRequest(`Upload at most ${cfg.MAX_IMAGES} screenshots per analysis.`);
  const total = files.reduce((s, f) => s + f.data.byteLength, 0);
  if (total > cfg.MAX_TOTAL_UPLOAD_BYTES)
    throw tooLarge(`Screenshots total ${(total / 1e6).toFixed(1)} MB; the limit is ${(cfg.MAX_TOTAL_UPLOAD_BYTES / 1e6).toFixed(1)} MB.`);

  return files.map((f, i) => {
    const n = i + 1;
    if (f.data.byteLength > cfg.MAX_IMAGE_BYTES)
      throw tooLarge(`Screenshot ${n} is ${(f.data.byteLength / 1e6).toFixed(1)} MB; the limit is ${(cfg.MAX_IMAGE_BYTES / 1e6).toFixed(1)} MB.`);
    const mime = sniffMime(f.data);
    if (!mime) throw badRequest(`Screenshot ${n} is not a PNG, JPEG or WebP image.`);
    let dims: { width?: number; height?: number };
    try {
      dims = imageSize(f.data);
    } catch {
      throw badRequest(`Screenshot ${n} could not be read (corrupted image?).`);
    }
    const width = dims.width ?? 0;
    const height = dims.height ?? 0;
    if (Math.min(width, height) < cfg.MIN_IMAGE_DIMENSION)
      throw badRequest(`Screenshot ${n} is too small (${width}x${height}). Chart resolution is insufficient for reliable analysis.`);
    if (Math.max(width, height) > 8000) throw badRequest(`Screenshot ${n} dimensions are too large (${width}x${height}).`);
    return {
      data: f.data,
      mime,
      width,
      height,
      bytes: f.data.byteLength,
      sha256: createHash("sha256").update(f.data).digest("hex"),
      label: normaliseTimeframe(f.label),
    };
  });
}

/** Identifies an identical request (same images in the same order, same labels and hints) for duplicate detection. */
export function inputHash(images: ValidatedImage[], symbolHint: string | null, notes: string | null): string {
  const h = createHash("sha256");
  for (const img of images) h.update(`${img.sha256}:${img.label ?? ""}|`);
  h.update(`symbol:${(symbolHint ?? "").toUpperCase()}|notes:${notes ?? ""}`);
  return h.digest("hex");
}
