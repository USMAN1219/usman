import { deflateSync } from "node:zlib";
import { loadConfig } from "../server/config.ts";
import { MemoryRepository } from "../server/db/memory.ts";
import { createApp } from "../server/http/app.ts";
import { MockChartAnalyzer } from "../server/ai/mock.ts";
import type { ChartAnalyzer } from "../server/ai/analyzer.ts";
import { MemoryBlobStore } from "../server/storage/index.ts";
import type { Services } from "../server/services.ts";

/** Builds a valid solid-colour RGB PNG of the given size. */
export function makePng(width: number, height: number, shade = 200): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3, shade);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

export function testServices(overrides: Record<string, string> = {}, analyzer?: ChartAnalyzer): Services {
  const config = loadConfig({
    APP_ENV: "test",
    APP_URL: "http://localhost",
    DB_DRIVER: "memory",
    STORAGE_DRIVER: "memory",
    AI_PROVIDER: "mock",
    ANALYSIS_EXECUTION: "inline",
    ...overrides,
  });
  return { config, repo: new MemoryRepository(), storage: new MemoryBlobStore(), analyzer: analyzer ?? new MockChartAnalyzer(), ready: async () => {} };
}

export function testClient(services: Services) {
  const app = createApp(() => services);
  let cookie = "";
  async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { "x-requested-with": "fetch", ...headers };
    if (cookie) h.cookie = cookie;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await app.request(`http://localhost/api${path}`, { method, headers: h, body: payload });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }
  return { request, app, setCookie: (c: string) => (cookie = c) };
}

export async function registeredClient(services: Services, email = "trader@example.com") {
  const client = testClient(services);
  const res = await client.request("POST", "/auth/register", { email, password: "correct horse battery" });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.json)}`);
  return client;
}

export function chartForm(count = 1, labels: (string | null)[] = ["4h", "15m", "5m"], extra: Record<string, string> = {}) {
  const fd = new FormData();
  for (let i = 0; i < count; i++) {
    fd.append("images", new File([makePng(640, 400, 100 + i) as BlobPart], `chart${i}.png`, { type: "image/png" }));
  }
  fd.append("labels", JSON.stringify(labels.slice(0, count)));
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}
