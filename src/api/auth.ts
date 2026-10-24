import type { Env } from "../env";

/** Split a secret that may list multiple tokens (comma-separated). */
export function parseTokenList(raw: string | null | undefined): string[] {
  if (raw == null || String(raw).trim() === "") return [];
  return String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ? match[1].trim() : null;
}

function writeTokens(env: Env): string[] {
  return parseTokenList(env.API_TOKEN);
}

function readTokens(env: Env): string[] {
  // Write tokens are also valid for GET queries.
  return [...writeTokens(env), ...parseTokenList(env.READ_API_TOKEN)];
}

/**
 * Admin / subscriber / test-push (write) paths: API_TOKEN only.
 */
export function requireWriteBearer(
  request: Request,
  env: Env,
): Response | null {
  const allowed = writeTokens(env);
  if (allowed.length === 0) {
    return jsonError(500, "API_TOKEN not configured");
  }
  const presented = extractBearerToken(request);
  if (!presented || !allowed.includes(presented)) {
    return jsonError(401, "Unauthorized");
  }
  return null;
}

/**
 * GET query paths: API_TOKEN or READ_API_TOKEN (comma-separated lists).
 */
export function requireReadBearer(
  request: Request,
  env: Env,
): Response | null {
  const allowed = readTokens(env);
  if (allowed.length === 0) {
    return jsonError(500, "API_TOKEN not configured");
  }
  const presented = extractBearerToken(request);
  if (!presented || !allowed.includes(presented)) {
    return jsonError(401, "Unauthorized");
  }
  return null;
}

/** @deprecated Prefer requireWriteBearer / requireReadBearer. */
export function requireBearer(request: Request, env: Env): Response | null {
  return requireWriteBearer(request, env);
}

/** Shared headers for all /v1/* (and /health) JSON responses. */
export const JSON_RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  /**
   * Advertise that representation may vary by Accept-Encoding so caches
   * do not mix gzip/br/identity bodies (hkjc-model #41).
   */
  Vary: "Accept-Encoding",
} as const;

export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...JSON_RESPONSE_HEADERS },
  });
}

export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_RESPONSE_HEADERS },
  });
}
