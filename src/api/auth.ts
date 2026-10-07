import type { Env } from "../env";

export function requireBearer(request: Request, env: Env): Response | null {
  const token = env.API_TOKEN?.trim();
  if (!token) {
    return jsonError(500, "API_TOKEN not configured");
  }
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || match[1] !== token) {
    return jsonError(401, "Unauthorized");
  }
  return null;
}

export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
