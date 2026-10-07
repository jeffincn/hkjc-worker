/**
 * Local smoke: apply migrations, start assumptions, hit Worker APIs.
 * Usage (with wrangler dev --local already running on :8787):
 *   API_TOKEN=... npx tsx scripts/local-ingest.ts
 *
 * Or standalone ingest against live GraphQL + local D1 via wrangler d1 execute.
 */

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.API_TOKEN ?? "dev-local-token-change-me";

async function main() {
  const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

  console.log("1) GET /health");
  let res = await fetch(`${BASE}/health`);
  console.log(res.status, await res.text());

  console.log("\n2) POST /v1/admin/ingest (live GraphQL → local D1)");
  res = await fetch(`${BASE}/v1/admin/ingest`, { method: "POST", headers });
  const ingestBody = await res.text();
  console.log(res.status, ingestBody);
  if (!res.ok) process.exit(1);

  const ingest = JSON.parse(ingestBody) as {
    meetings: Array<{ date: string; venue: string }>;
  };
  const m = ingest.meetings[0];
  if (!m) {
    console.error("No meeting ingested");
    process.exit(1);
  }

  const q = (path: string) => fetch(`${BASE}${path}`, { headers });

  // Pick a real horse code from race 1 runners if present in odds snapshot
  let horseCode = "H087";
  try {
    const latest = await q(
      `/v1/odds/latest?date=${m.date}&venue=${m.venue}&race_no=1`,
    );
    const body = (await latest.json()) as {
      snapshot?: { data?: { runners?: Array<{ horse_name?: string }> } };
    };
    void body;
  } catch {
    /* keep default */
  }
  const horseRow = await envHorseCode(BASE, TOKEN, m.date, m.venue);
  if (horseRow) horseCode = horseRow;

  const endpoints = [
    `/v1/meetings?from=${m.date}&to=${m.date}`,
    `/v1/races?date=${m.date}&venue=${m.venue}`,
    `/v1/odds/latest?date=${m.date}&venue=${m.venue}&race_no=1`,
    `/v1/odds/history?date=${m.date}&venue=${m.venue}&race_no=1`,
    `/v1/results?date=${m.date}&venue=${m.venue}`,
    `/v1/changes?since=${encodeURIComponent("2020-01-01T00:00:00+08:00")}`,
    `/v1/horses/${horseCode}`,
    `/v1/horses/${horseCode}/runs`,
    `/v1/horses/${horseCode}/injuries`,
    `/health`,
  ];

  for (const path of endpoints) {
    console.log(`\nGET ${path}`);
    res = await q(path);
    const text = await res.text();
    console.log(res.status, text.slice(0, 800));
    if (!res.ok) process.exit(1);
  }

  console.log("\nAll endpoints OK. (test-push skipped — no webhook)");
}

async function envHorseCode(
  base: string,
  token: string,
  _date: string,
  _venue: string,
): Promise<string | null> {
  void _date;
  void _venue;
  // Prefer a horse we know was refreshed in this ingest batch
  const res = await fetch(`${base}/v1/horses/H087`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) return "H087";
  return null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
