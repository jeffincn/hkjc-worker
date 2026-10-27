import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { parseBarrierTrialPage } from "../src/html/barrier-trial";
import { parseHorseProfile, parsePastRuns } from "../src/html/horse";
import {
  replaceBarrierTrialDay,
  upsertFundamentalsFromHorseRuns,
  upsertQuinellaPoolStats,
} from "../src/store/fundamentals";
import { contentHash } from "../src/parse/hash";
import { BTRESULT_CRAZY_TREASURE_HTML } from "./fixtures/btresult-crazy-treasure";
import { SWORD_POINT_HORSE_HTML } from "./fixtures/sword-point-horse";

async function seedSwordPoint(): Promise<void> {
  const profile = parseHorseProfile(
    SWORD_POINT_HORSE_HTML,
    "G448",
    "https://example/horse",
  );
  const runs = parsePastRuns(SWORD_POINT_HORSE_HTML);
  await upsertFundamentalsFromHorseRuns(env.DB, {
    horse_code: "G448",
    profile,
    runs,
    source_url: "https://example/horse",
  });
}

async function seedCrazyTrial(): Promise<void> {
  const page = parseBarrierTrialPage(BTRESULT_CRAZY_TREASURE_HTML, {
    trial_date: "2024-08-22",
  });
  const content_hash = await contentHash(page);
  await replaceBarrierTrialDay(env.DB, {
    trial_date: "2024-08-22",
    batches: page.batches,
    source_url: "https://example/bt",
    content_hash,
  });
}

describe("fundamentals GET APIs auth + data (issue #50)", () => {
  it("rejects missing bearer on /v1/gear-changes", async () => {
    const req = new Request("http://localhost/v1/gear-changes?horse_code=G448");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("accepts READ_API_TOKEN on gear / ratings / weights / rail / trials / quinella", async () => {
    await seedSwordPoint();
    await seedCrazyTrial();
    await upsertQuinellaPoolStats(env.DB, {
      meeting_date: "2026-03-11",
      venue: "HV",
      pools: [
        {
          race_no: 2,
          pool_type: "QIN",
          investment: 7309153,
          status: "Payout",
          sell_status: null,
          last_update_time: null,
        },
        {
          race_no: 2,
          pool_type: "QPL",
          investment: 6719344,
          status: "Payout",
          sell_status: null,
          last_update_time: null,
        },
      ],
    });

    const headers = { Authorization: "Bearer test-read-token" };
    const paths = [
      "/v1/gear-changes?horse_code=G448",
      "/v1/official-ratings?horse_code=G448",
      "/v1/declared-weights?horse_code=G448",
      "/v1/rail-positions?date=2026-07-08&venue=HV",
      "/v1/barrier-trials?date=2024-08-22&horse_code=J063",
      "/v1/quinella-pools?date=2026-03-11&venue=HV&race_no=2",
    ];

    for (const path of paths) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`http://localhost${path}`, { headers }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBeUndefined();
    }

    const gearCtx = createExecutionContext();
    const gearRes = await worker.fetch(
      new Request("http://localhost/v1/gear-changes?horse_code=G448", {
        headers,
      }),
      env,
      gearCtx,
    );
    await waitOnExecutionContext(gearCtx);
    const gearBody = (await gearRes.json()) as {
      gear_changes: Array<{ race_date: string; gear_raw: string }>;
    };
    expect(
      gearBody.gear_changes.some(
        (g) => g.race_date === "2026-06-27" && g.gear_raw === "CP-/B1",
      ),
    ).toBe(true);

    const trialCtx = createExecutionContext();
    const trialRes = await worker.fetch(
      new Request(
        "http://localhost/v1/barrier-trials?date=2024-08-22&horse_code=J063",
        { headers },
      ),
      env,
      trialCtx,
    );
    await waitOnExecutionContext(trialCtx);
    const trialBody = (await trialRes.json()) as {
      trials: Array<{ finish_time: string; running_position: string }>;
    };
    expect(trialBody.trials[0]?.finish_time).toBe("1.10.60");
    expect(trialBody.trials[0]?.running_position.replace(/\s+/g, " ").trim()).toBe(
      "4 4 1",
    );

    const qCtx = createExecutionContext();
    const qRes = await worker.fetch(
      new Request(
        "http://localhost/v1/quinella-pools?date=2026-03-11&venue=HV&race_no=2",
        { headers },
      ),
      env,
      qCtx,
    );
    await waitOnExecutionContext(qCtx);
    const qBody = (await qRes.json()) as {
      note: string;
      pools: Array<{ pool_type: string; investment: number }>;
    };
    expect(qBody.note).toMatch(/JS/i);
    expect(qBody.pools.find((p) => p.pool_type === "QIN")?.investment).toBe(
      7309153,
    );
  });

  it("admin barrier-trials ingest requires write token", async () => {
    const readCtx = createExecutionContext();
    const readRes = await worker.fetch(
      new Request("http://localhost/v1/admin/ingest-barrier-trials", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-read-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ date: "2024-08-22" }),
      }),
      env,
      readCtx,
    );
    await waitOnExecutionContext(readCtx);
    expect(readRes.status).toBe(401);

    // Write token reaches handler; missing date → 400 (no outbound fetch).
    const writeCtx = createExecutionContext();
    const writeRes = await worker.fetch(
      new Request("http://localhost/v1/admin/ingest-barrier-trials", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-api-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
      writeCtx,
    );
    await waitOnExecutionContext(writeCtx);
    expect(writeRes.status).toBe(400);
  });
});
