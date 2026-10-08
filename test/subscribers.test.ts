import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { buildEnvelope } from "../src/push/envelope";
import { hmacSha256Hex, sendPush } from "../src/push/pusher";
import {
  createSubscriber,
  listSubscribers,
  toPublicSubscriber,
} from "../src/push/subscribers";

async function clearSubscribers(): Promise<void> {
  await env.DB.prepare(`DELETE FROM push_subscribers`).run();
  await env.DB.prepare(`DELETE FROM pending_pushes`).run();
  await env.DB.prepare(`DELETE FROM push_log`).run();
}

describe("multi-subscriber push", () => {
  beforeEach(async () => {
    await clearSubscribers();
  });

  it("delivers independently to two subscribers when one fails", async () => {
    const a = await createSubscriber(env, {
      url: "https://receiver-a.example/hook",
      secret: null,
    });
    const b = await createSubscriber(env, {
      url: "https://receiver-b.example/hook",
      secret: "only-b-secret",
    });

    const calls: { url: string; headers: Headers; body: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? "");
      calls.push({ url, headers, body });
      if (url.includes("receiver-a")) {
        return new Response("fail", { status: 500 });
      }
      return new Response("{}", { status: 202 });
    };

    const result = await sendPush(
      env,
      buildEnvelope({ event: "test", races: [] }),
      { fetchImpl, force: true },
    );

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://receiver-a.example/hook",
      "https://receiver-b.example/hook",
    ]);
    expect(result.success).toBe(true);
    expect(result.deliveries).toHaveLength(2);

    const fail = result.deliveries!.find((d) => d.subscriber_id === a.id)!;
    const ok = result.deliveries!.find((d) => d.subscriber_id === b.id)!;
    expect(fail.success).toBe(false);
    expect(fail.http_status).toBe(500);
    expect(ok.success).toBe(true);
    expect(ok.http_status).toBe(202);

    // Failed subscriber gets its own retry row; success does not.
    const pending = await env.DB.prepare(
      `SELECT subscriber_id, last_error FROM pending_pushes`,
    ).all<{ subscriber_id: number; last_error: string }>();
    expect(pending.results).toHaveLength(1);
    expect(pending.results![0].subscriber_id).toBe(a.id);
  });

  it("signs with HMAC only for the subscriber that has a secret", async () => {
    await createSubscriber(env, {
      url: "https://unsigned.example/hook",
    });
    await createSubscriber(env, {
      url: "https://signed.example/hook",
      secret: "shared-hmac",
    });

    const calls: { url: string; sig: string | null; body: string; ua: string | null }[] =
      [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const raw = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(input),
        sig: raw["X-Signature"] ?? null,
        body: String(init?.body ?? ""),
        ua: raw["User-Agent"] ?? null,
      });
      return new Response("{}", { status: 202 });
    };

    await sendPush(env, buildEnvelope({ event: "test", races: [] }), {
      fetchImpl,
      force: true,
    });

    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.ua).toBe("hkjc-data-worker/1.0");
    }

    const unsigned = calls.find((c) => c.url === "https://unsigned.example/hook")!;
    const signedCall = calls.find((c) => c.url === "https://signed.example/hook")!;
    expect(unsigned.sig).toBeNull();
    expect(signedCall.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(signedCall.sig).not.toMatch(/^sha256=/);

    const expected = await hmacSha256Hex("shared-hmac", signedCall.body);
    expect(signedCall.sig).toBe(expected);
    // Both receive the same raw JSON body (envelope schema unchanged).
    expect(JSON.parse(unsigned.body).schema).toBe("hkjc-push/1.0");
    expect(unsigned.body).toBe(signedCall.body);
  });

  it("falls back to PUSH_TARGET_URL only when no subscriber rows exist", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(String(input));
      const headers = new Headers(init?.headers);
      expect(headers.get("User-Agent")).toBe("hkjc-data-worker/1.0");
      return new Response("{}", { status: 202 });
    };

    // No rows + no env URL → skip
    const skip = await sendPush(env, buildEnvelope({ event: "test", races: [] }), {
      fetchImpl,
      force: true,
    });
    expect(skip.skipped).toBe(true);
    expect(calls).toHaveLength(0);

    // Temporary fallback binding (fresh deploy with no rows yet).
    const mutable = env as typeof env & { PUSH_TARGET_URL?: string; PUSH_SECRET?: string };
    mutable.PUSH_TARGET_URL = "https://fallback.example/hook";
    mutable.PUSH_SECRET = "fallback-secret";
    try {
      const fb = await sendPush(env, buildEnvelope({ event: "test", races: [] }), {
        fetchImpl,
        force: true,
      });
      expect(fb.skipped).toBe(false);
      expect(fb.success).toBe(true);
      expect(calls).toEqual(["https://fallback.example/hook"]);
    } finally {
      delete mutable.PUSH_TARGET_URL;
      delete mutable.PUSH_SECRET;
    }

    // Rows exist (even if all disabled) → do not fall back.
    calls.length = 0;
    await createSubscriber(env, {
      url: "https://disabled.example/hook",
      enabled: false,
    });
    mutable.PUSH_TARGET_URL = "https://fallback.example/hook";
    try {
      const gated = await sendPush(env, buildEnvelope({ event: "test", races: [] }), {
        fetchImpl,
        force: true,
      });
      expect(gated.skipped).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      delete mutable.PUSH_TARGET_URL;
    }
  });
});

describe("admin subscribers API", () => {
  beforeEach(async () => {
    await clearSubscribers();
  });

  it("requires bearer auth for list/create", async () => {
    const ctx = createExecutionContext();
    const unauth = await worker.fetch(
      new Request("http://localhost/v1/admin/subscribers"),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(unauth.status).toBe(401);

    const ctx2 = createExecutionContext();
    const unauthPost = await worker.fetch(
      new Request("http://localhost/v1/admin/subscribers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://x.example/h" }),
      }),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    expect(unauthPost.status).toBe(401);
  });

  it("lists/adds/updates/deletes without exposing secrets", async () => {
    const auth = { Authorization: "Bearer test-api-token" };

    const createCtx = createExecutionContext();
    const created = await worker.fetch(
      new Request("http://localhost/v1/admin/subscribers", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://admin-hook.example/push",
          secret: "super-secret-value",
          enabled: true,
        }),
      }),
      env,
      createCtx,
    );
    await waitOnExecutionContext(createCtx);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      subscriber: {
        id: number;
        url: string;
        enabled: boolean;
        has_secret: boolean;
        secret?: string;
      };
    };
    expect(createdBody.subscriber.url).toBe("https://admin-hook.example/push");
    expect(createdBody.subscriber.has_secret).toBe(true);
    expect(createdBody.subscriber.secret).toBeUndefined();
    expect(JSON.stringify(createdBody)).not.toContain("super-secret-value");

    const listCtx = createExecutionContext();
    const listed = await worker.fetch(
      new Request("http://localhost/v1/admin/subscribers", { headers: auth }),
      env,
      listCtx,
    );
    await waitOnExecutionContext(listCtx);
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { subscribers: unknown[] };
    expect(listBody.subscribers).toHaveLength(1);
    expect(JSON.stringify(listBody)).not.toContain("super-secret-value");

    const id = createdBody.subscriber.id;
    const patchCtx = createExecutionContext();
    const patched = await worker.fetch(
      new Request(`http://localhost/v1/admin/subscribers/${id}`, {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      env,
      patchCtx,
    );
    await waitOnExecutionContext(patchCtx);
    expect(patched.status).toBe(200);
    const patchBody = (await patched.json()) as {
      subscriber: { enabled: boolean; has_secret: boolean };
    };
    expect(patchBody.subscriber.enabled).toBe(false);
    expect(patchBody.subscriber.has_secret).toBe(true);

    const delCtx = createExecutionContext();
    const deleted = await worker.fetch(
      new Request(`http://localhost/v1/admin/subscribers/${id}`, {
        method: "DELETE",
        headers: auth,
      }),
      env,
      delCtx,
    );
    await waitOnExecutionContext(delCtx);
    expect(deleted.status).toBe(200);

    const rows = await listSubscribers(env);
    expect(rows).toHaveLength(0);
    expect(toPublicSubscriber({
      id: 1,
      url: "https://x",
      secret: "hidden",
      enabled: true,
      created_at: "",
      updated_at: "",
    }).has_secret).toBe(true);
  });
});
