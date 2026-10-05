/**
 * Database schema (PostgreSQL 14+). Idempotent: applied automatically on first
 * use (AUTO_MIGRATE=true, the default) and by `npm run db:migrate`.
 */
import type postgres from "postgres";

export const SCHEMA_SQL = `
-- Price Action Analyst database schema (PostgreSQL 14+).

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings   jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analyses (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status             text NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  symbol             text,
  symbol_hint        text,
  timeframes         text[] NOT NULL DEFAULT '{}',
  images             jsonb NOT NULL,
  notes              text,
  input_hash         text NOT NULL,
  result             jsonb,
  derived            jsonb,
  error              text,
  final_decision     text,
  direction          text,
  grade              text,
  confidence         text,
  entry_low          double precision,
  entry_high         double precision,
  stop_loss          double precision,
  tp1                double precision,
  tp2                double precision,
  rr                 double precision,
  model              text,
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  cost_usd           double precision NOT NULL DEFAULT 0,
  duration_ms        integer,
  taken              boolean NOT NULL DEFAULT false,
  taken_at           timestamptz,
  outcome_pnl        double precision,
  outcome_note       text
);
CREATE INDEX IF NOT EXISTS analyses_user_created_idx ON analyses (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS analyses_user_symbol_idx ON analyses (user_id, upper(symbol), created_at DESC);
CREATE INDEX IF NOT EXISTS analyses_user_hash_idx ON analyses (user_id, input_hash);
CREATE INDEX IF NOT EXISTS analyses_created_idx ON analyses (created_at);

CREATE TABLE IF NOT EXISTS watchlist (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol          text NOT NULL,
  notes           text,
  point_value     double precision,
  status_override text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS watchlist_user_symbol_idx ON watchlist (user_id, upper(symbol));

CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  analysis_id uuid REFERENCES analyses(id) ON DELETE SET NULL,
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

-- Sliding-window counters for rate limiting (login attempts, analyses).
CREATE TABLE IF NOT EXISTS rate_events (
  id         bigserial PRIMARY KEY,
  key        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_events_key_idx ON rate_events (key, created_at);
`;

/** Applies the schema under an advisory lock so concurrent cold starts don't race. */
export async function migrate(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(724117)`;
    await tx.unsafe(SCHEMA_SQL);
  });
}
