/** Minimal structured logger. Never pass secrets, passwords or image data to it. */
type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  if (process.env.APP_ENV === "test" && level !== "error" && process.env.LOG_LEVEL !== "debug") return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => write("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => write("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => write("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => write("error", m, f),
};
