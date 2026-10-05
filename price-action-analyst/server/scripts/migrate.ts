/** Applies the database schema (idempotent). Usage: DATABASE_URL=... npm run db:migrate */
import postgres from "postgres";
import { migrate } from "../db/schema.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
await migrate(sql);
await sql.end();
console.log("Database schema is up to date.");
