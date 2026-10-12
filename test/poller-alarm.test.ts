import { env, fetchMock, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GRAPHQL_ENDPOINT } from "../src/graphql/queries";
import type { BlockState } from "../src/poll/live";

const u = new URL(GRAPHQL_ENDPOINT);

describe("MeetingPoller alarm: source block backoff + accounting", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  it("on 403 records block state, emits source_blocked, backs off and counts requests", async () => {
    fetchMock.get(u.origin).intercept({ path: u.pathname, method: "POST" }).reply(403, "Forbidden");
    const id = env.MEETING_DO.idFromName("2026-10-11_ST_block");
    const stub = env.MEETING_DO.get(id);
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.put("cfg", {
        meeting_date: "2026-10-11",
        venue: "ST",
        locked_races: [],
        result_races: [],
      });
      await state.storage.put("current_interval_ms", 3000);
      await state.storage.put("last_schedule_ms", 3000);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_inst, state) => {
      const block = await state.storage.get<BlockState>("block_state");
      expect(block?.blocked).toBe(true);
      expect(block?.reason).toBe("http_403");
      expect(await state.storage.get<number>("current_interval_ms")).toBe(6000);
      const alarm = (await state.storage.getAlarm()) ?? 0;
      expect(alarm - before).toBeGreaterThanOrEqual(5000);
      expect(alarm - before).toBeLessThan(8000);
      const usage = await state.storage.get<{ global: number; pending: number }>("gql_usage");
      expect((usage?.global ?? 0) + (usage?.pending ?? 0)).toBe(1); // 403 is not retried
    });

    const ev = await env.DB.prepare(
      `SELECT event_type, payload_json FROM push_events WHERE event_type='source_blocked' AND venue='ST'`,
    ).first<{ event_type: string; payload_json: string }>();
    expect(ev?.event_type).toBe("source_blocked");
    const payload = JSON.parse(ev!.payload_json) as {
      quality: { sample_interval_s: number };
      meta: { reason: string };
    };
    expect(payload.quality.sample_interval_s).toBe(3);
    expect(payload.meta.reason).toBe("http_403");
    const meta = await env.DB.prepare(`SELECT value FROM worker_meta WHERE key='source_block_state'`).first<{
      value: string;
    }>();
    expect(JSON.parse(meta!.value).blocked).toBe(true);
  });
});
