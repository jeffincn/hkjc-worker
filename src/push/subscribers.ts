import type { Env } from "../env";

/** Agent runner webhook — uses env PUSH_SECRET when the row has no secret. */
export const AGENT_WEBHOOK_URL = "https://hkjc-agent.cf-connect.top/webhook";

/** Public webhook.site receiver — no HMAC. */
export const WEBHOOK_SITE_URL =
  "https://webhook.site/902a6166-6336-452d-97c5-e64018d97919";

export interface PushSubscriber {
  id: number;
  url: string;
  secret: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Public list shape — never expose the secret value. */
export interface PushSubscriberPublic {
  id: number;
  url: string;
  enabled: boolean;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
}

export function toPublicSubscriber(row: PushSubscriber): PushSubscriberPublic {
  return {
    id: row.id,
    url: row.url,
    enabled: row.enabled,
    has_secret: !!(row.secret && row.secret.length > 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * If the agent webhook row has no secret and PUSH_SECRET is set, persist it.
 * Does not overwrite an admin-configured secret.
 */
export async function syncAgentSecretFromEnv(env: Env): Promise<void> {
  const secret = env.PUSH_SECRET?.trim();
  if (!secret) return;
  await env.DB.prepare(
    `UPDATE push_subscribers
     SET secret = ?, updated_at = ?
     WHERE url = ? AND (secret IS NULL OR secret = '')`,
  )
    .bind(secret, nowIso(), AGENT_WEBHOOK_URL)
    .run();
}

export async function listSubscribers(env: Env): Promise<PushSubscriber[]> {
  await syncAgentSecretFromEnv(env);
  const { results } = await env.DB.prepare(
    `SELECT id, url, secret, enabled, created_at, updated_at
     FROM push_subscribers ORDER BY id ASC`,
  ).all<{
    id: number;
    url: string;
    secret: string | null;
    enabled: number;
    created_at: string;
    updated_at: string;
  }>();

  return (results ?? []).map((r) => ({
    id: r.id,
    url: r.url,
    secret: r.secret,
    enabled: r.enabled === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

export async function listEnabledSubscribers(env: Env): Promise<PushSubscriber[]> {
  const all = await listSubscribers(env);
  return all.filter((s) => s.enabled);
}

export async function countSubscribers(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscribers`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

export async function getSubscriber(
  env: Env,
  id: number,
): Promise<PushSubscriber | null> {
  await syncAgentSecretFromEnv(env);
  const r = await env.DB.prepare(
    `SELECT id, url, secret, enabled, created_at, updated_at
     FROM push_subscribers WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: number;
      url: string;
      secret: string | null;
      enabled: number;
      created_at: string;
      updated_at: string;
    }>();
  if (!r) return null;
  return {
    id: r.id,
    url: r.url,
    secret: r.secret,
    enabled: r.enabled === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function createSubscriber(
  env: Env,
  input: { url: string; secret?: string | null; enabled?: boolean },
): Promise<PushSubscriber> {
  const url = input.url.trim();
  if (!url) throw new Error("url is required");
  try {
    new URL(url);
  } catch {
    throw new Error("url must be a valid absolute URL");
  }
  const ts = nowIso();
  const enabled = input.enabled === false ? 0 : 1;
  const secret =
    typeof input.secret === "string" && input.secret.trim() !== ""
      ? input.secret.trim()
      : null;

  const result = await env.DB.prepare(
    `INSERT INTO push_subscribers (url, secret, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(url, secret, enabled, ts, ts)
    .run();

  const id = result.meta.last_row_id;
  if (!id) throw new Error("failed to create subscriber");
  const row = await getSubscriber(env, Number(id));
  if (!row) throw new Error("failed to load created subscriber");
  return row;
}

export async function updateSubscriber(
  env: Env,
  id: number,
  patch: { url?: string; secret?: string | null; enabled?: boolean },
): Promise<PushSubscriber | null> {
  const existing = await getSubscriber(env, id);
  if (!existing) return null;

  let url = existing.url;
  if (typeof patch.url === "string") {
    url = patch.url.trim();
    if (!url) throw new Error("url is required");
    try {
      new URL(url);
    } catch {
      throw new Error("url must be a valid absolute URL");
    }
  }

  let secret = existing.secret;
  if (patch.secret !== undefined) {
    if (patch.secret === null || patch.secret === "") {
      secret = null;
    } else {
      secret = patch.secret.trim();
    }
  }

  const enabled =
    patch.enabled === undefined ? (existing.enabled ? 1 : 0) : patch.enabled ? 1 : 0;
  const ts = nowIso();

  await env.DB.prepare(
    `UPDATE push_subscribers SET url = ?, secret = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(url, secret, enabled, ts, id)
    .run();

  return getSubscriber(env, id);
}

export async function deleteSubscriber(env: Env, id: number): Promise<boolean> {
  const result = await env.DB.prepare(`DELETE FROM push_subscribers WHERE id = ?`)
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
