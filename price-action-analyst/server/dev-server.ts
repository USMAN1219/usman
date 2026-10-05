/**
 * Local development API server (Node). Production uses Netlify Functions;
 * this runs the same Hono app so the frontend can be developed with `npm run dev`.
 * Defaults to in-memory database, filesystem storage and in-process (async) job execution
 * unless the environment says otherwise.
 */
import { serve } from "@hono/node-server";
import { createApp } from "./http/app.ts";
import { log } from "./logger.ts";

process.env.APP_ENV ??= "development";
process.env.ANALYSIS_EXECUTION ??= "async";
process.env.DB_DRIVER ??= process.env.DATABASE_URL ? "postgres" : "memory";
process.env.STORAGE_DRIVER ??= "fs";

const port = Number(process.env.API_PORT ?? 8787);
const app = createApp();
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  log.info("dev-server.listening", {
    url: `http://127.0.0.1:${port}/api`,
    db: process.env.DB_DRIVER,
    storage: process.env.STORAGE_DRIVER,
    ai: process.env.AI_PROVIDER ?? "anthropic",
  });
});
