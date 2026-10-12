import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getMeta } from "../src/store/db";
import { readStageErrors, runStage, stageErrorKey } from "../src/util/stage";

describe("stage error isolation", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM worker_meta`).run();
  });

  it("records failure without throwing to caller", async () => {
    const result = await runStage(env, "odds", async () => {
      throw new Error("boom-odds");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("boom-odds");
    expect(await getMeta(env.DB, stageErrorKey("odds"))).toContain("boom-odds");
  });

  it("clears error on success and isolates sibling stages", async () => {
    await runStage(env, "dividends", async () => {
      throw new Error("div-fail");
    });
    const ok = await runStage(env, "odds", async () => 42);
    expect(ok).toEqual({ ok: true, value: 42 });

    const errors = await readStageErrors(env, ["odds", "dividends", "horses"]);
    expect(errors.odds).toBeNull();
    expect(errors.dividends).toContain("div-fail");
    expect(errors.horses).toBeNull();
  });
});
