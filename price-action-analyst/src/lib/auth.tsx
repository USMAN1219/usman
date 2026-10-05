import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { PublicUser } from "../../shared/types.ts";
import { api, ApiError } from "./api.ts";

export interface PublicConfig {
  registrationEnabled: boolean;
  inviteRequired: boolean;
  maxImages: number;
  maxImageBytes: number;
  maxTotalBytes: number;
  aiProvider: string;
  model: string;
  pricing: { input: number; output: number };
  disclaimer: string;
}

interface AuthState {
  user: PublicUser | null;
  config: PublicConfig | null;
  /** Set when the server reports a setup problem (e.g. a missing environment variable). */
  setupError: string | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string, inviteCode?: string): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    Promise.allSettled([api.get<{ user: PublicUser }>("/auth/me"), api.get<PublicConfig>("/config")]).then(([me, cfg]) => {
      if (me.status === "fulfilled") setUser(me.value.user);
      if (cfg.status === "fulfilled") setConfig(cfg.value);
      else if (cfg.reason instanceof ApiError && cfg.reason.status === 503) setSetupError(cfg.reason.message);
      setLoading(false);
    });
    const onExpired = () => setUser(null);
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setUser((await api.post<{ user: PublicUser }>("/auth/login", { email, password })).user);
  }, []);
  const register = useCallback(async (email: string, password: string, inviteCode?: string) => {
    setUser((await api.post<{ user: PublicUser }>("/auth/register", { email, password, inviteCode })).user);
  }, []);
  const logout = useCallback(async () => {
    await api.post("/auth/logout").catch(() => undefined);
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, config, setupError, loading, login, register, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
