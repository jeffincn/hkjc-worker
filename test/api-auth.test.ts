import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("API auth + health", () => {
  it("health is public", async () => {
    const req = new Request("http://localhost/health");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; gaps: unknown };
    expect(body.ok).toBe(true);
    expect(body.gaps).toBeTruthy();
  });

  it("rejects missing bearer on /v1/meetings", async () => {
    const req = new Request("http://localhost/v1/meetings");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("accepts valid bearer", async () => {
    const req = new Request("http://localhost/v1/meetings", {
      headers: { Authorization: "Bearer test-api-token" },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meetings: unknown[] };
    expect(Array.isArray(body.meetings)).toBe(true);
  });
});
