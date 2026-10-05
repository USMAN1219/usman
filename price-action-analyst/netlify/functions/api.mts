/**
 * Netlify Function (synchronous, 60 s limit) serving the whole JSON API under /api/*.
 * Long-running AI work is handed to the analyze-background function.
 */
import type { Config } from "@netlify/functions";
import { createApp } from "../../server/http/app.ts";

const app = createApp();

export default (req: Request) => app.fetch(req);

export const config: Config = { path: "/api/*" };
