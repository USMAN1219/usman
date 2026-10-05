/**
 * Object storage for uploaded chart screenshots.
 *
 * Production uses Netlify Blobs (private, no public URLs - images are only
 * served through the authenticated API). Local development can use the
 * filesystem; tests use memory.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BlobStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export class MemoryBlobStore implements BlobStore {
  private data = new Map<string, Uint8Array>();
  async put(key: string, data: Uint8Array) {
    this.data.set(key, new Uint8Array(data));
  }
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}

/** Keys are generated server-side (uuid based) but are still validated to keep writes inside the root. */
const SAFE_KEY = /^[a-zA-Z0-9/_.-]+$/;

export class FsBlobStore implements BlobStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  private resolve(key: string) {
    if (!SAFE_KEY.test(key) || key.includes("..")) throw new Error("Invalid storage key");
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, data: Uint8Array) {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.resolve(key)));
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }
  async delete(key: string) {
    await rm(this.resolve(key), { force: true });
  }
}

export class NetlifyBlobStore implements BlobStore {
  private storePromise: Promise<import("@netlify/blobs").Store> | null = null;
  constructor(private readonly name = "chart-uploads") {}
  private store() {
    // Strong consistency: the background worker reads images immediately after upload.
    this.storePromise ??= import("@netlify/blobs").then((m) => m.getStore({ name: this.name, consistency: "strong" }));
    return this.storePromise;
  }
  async put(key: string, data: Uint8Array, contentType: string) {
    const s = await this.store();
    await s.set(key, new Blob([data as BlobPart], { type: contentType }));
  }
  async get(key: string) {
    const s = await this.store();
    const buf = await s.get(key, { type: "arrayBuffer" });
    return buf ? new Uint8Array(buf) : null;
  }
  async delete(key: string) {
    const s = await this.store();
    await s.delete(key);
  }
}
