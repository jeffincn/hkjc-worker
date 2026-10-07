import { describe, expect, it } from "vitest";
import { canonicalize, contentHash } from "../src/parse/hash";

describe("content hash", () => {
  it("is stable regardless of key order", async () => {
    const a = await contentHash({ win: { "1": 3.5, "2": 10 }, pla: { "1": 1.5 } });
    const b = await contentHash({ pla: { "1": 1.5 }, win: { "2": 10, "1": 3.5 } });
    expect(a).toBe(b);
  });

  it("changes when odds change", async () => {
    const a = await contentHash({ win: { "1": 3.5 } });
    const b = await contentHash({ win: { "1": 3.6 } });
    expect(a).not.toBe(b);
  });

  it("canonicalize sorts nested keys", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      JSON.stringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});
