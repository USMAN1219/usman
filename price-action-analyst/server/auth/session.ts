/**
 * Stateless sessions: a signed JWT (HS256) in an HttpOnly, Secure, SameSite=Lax
 * cookie. The token never reaches JavaScript, so XSS cannot exfiltrate it.
 */
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "paa_session";

const key = (secret: string) => new TextEncoder().encode(secret);

export async function createSessionToken(userId: string, secret: string, ttlHours: number): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ttlHours}h`)
    .setIssuer("price-action-analyst")
    .sign(key(secret));
}

export async function verifySessionToken(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"], issuer: "price-action-analyst" });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
