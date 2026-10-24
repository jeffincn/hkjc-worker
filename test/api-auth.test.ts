import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { utf8ByteLength } from "../src/api/byte-page";

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

  it("sets Vary: Accept-Encoding on /v1 JSON success and error", async () => {
    const okCtx = createExecutionContext();
    const okRes = await worker.fetch(
      new Request("http://localhost/v1/meetings", {
        headers: { Authorization: "Bearer test-api-token" },
      }),
      env,
      okCtx,
    );
    await waitOnExecutionContext(okCtx);
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("Vary")).toBe("Accept-Encoding");
    expect(okRes.headers.get("Content-Type")).toMatch(/application\/json/);

    const errCtx = createExecutionContext();
    const errRes = await worker.fetch(
      new Request("http://localhost/v1/meetings"),
      env,
      errCtx,
    );
    await waitOnExecutionContext(errCtx);
    expect(errRes.status).toBe(401);
    expect(errRes.headers.get("Vary")).toBe("Accept-Encoding");
  });
});

describe("max_bytes UTF-8 uncompressed metric", () => {
  it("utf8ByteLength counts UTF-8 bytes not JS string length", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    // CJK ideograph U+99AC is 3 UTF-8 bytes, 1 UTF-16 code unit
    expect("馬".length).toBe(1);
    expect(utf8ByteLength("馬")).toBe(3);
  });
});
