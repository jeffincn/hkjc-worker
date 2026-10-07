import type { HorseProfile, PastRun, VetRecord } from "../html/horse";
import { contentHash } from "../parse/hash";

export interface StoreResult {
  changed: boolean;
  content_hash: string;
}

export async function storeRawDocument(
  db: D1Database,
  docType: string,
  docKey: string,
  raw: unknown,
  sourceUrl: string | null,
): Promise<StoreResult> {
  const hash = await contentHash(raw);
  const last = await db
    .prepare(
      `SELECT content_hash FROM raw_documents WHERE doc_type=? AND doc_key=? ORDER BY id DESC LIMIT 1`,
    )
    .bind(docType, docKey)
    .first<{ content_hash: string }>();

  const changed = last?.content_hash !== hash;
  const now = new Date().toISOString();
  if (changed) {
    await db
      .prepare(
        `INSERT INTO raw_documents (doc_type, doc_key, source_url, content_hash, raw_json, changed, fetched_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(docType, docKey, sourceUrl, hash, JSON.stringify(raw), now)
      .run();
  } else {
    // Unchanged: only bump fetched_at on the latest matching row (no push, no new payload)
    await db
      .prepare(
        `UPDATE raw_documents SET fetched_at=?, changed=0
         WHERE id = (
           SELECT id FROM raw_documents WHERE doc_type=? AND doc_key=? ORDER BY id DESC LIMIT 1
         )`,
      )
      .bind(now, docType, docKey)
      .run();
  }
  return { changed, content_hash: hash };
}

export async function upsertHorseProfile(
  db: D1Database,
  profile: HorseProfile,
  rawHtmlSnippet: unknown,
): Promise<StoreResult> {
  const hash = await contentHash(profile);
  const existing = await db
    .prepare(`SELECT content_hash FROM horses WHERE horse_code=?`)
    .bind(profile.horse_code)
    .first<{ content_hash: string }>();
  const changed = existing?.content_hash !== hash;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO horses (
        horse_code, horse_id, name_en, name_ch, colour, sex, import_type, owner, sire, dam, dams_sire,
        total_stakes, season_stakes, current_rating, data_source, source_url, content_hash, raw_json, fetched_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'html_horse', ?, ?, ?, ?, ?)
      ON CONFLICT(horse_code) DO UPDATE SET
        horse_id=excluded.horse_id,
        name_en=excluded.name_en,
        colour=excluded.colour,
        sex=excluded.sex,
        import_type=excluded.import_type,
        owner=excluded.owner,
        sire=excluded.sire,
        dam=excluded.dam,
        dams_sire=excluded.dams_sire,
        total_stakes=excluded.total_stakes,
        season_stakes=excluded.season_stakes,
        current_rating=excluded.current_rating,
        source_url=excluded.source_url,
        content_hash=excluded.content_hash,
        raw_json=CASE WHEN excluded.content_hash!=horses.content_hash THEN excluded.raw_json ELSE horses.raw_json END,
        fetched_at=excluded.fetched_at,
        updated_at=CASE WHEN excluded.content_hash!=horses.content_hash THEN excluded.updated_at ELSE horses.updated_at END`,
    )
    .bind(
      profile.horse_code,
      profile.horse_id,
      profile.name_en,
      profile.name_ch,
      profile.colour,
      profile.sex,
      profile.import_type,
      profile.owner,
      profile.sire,
      profile.dam,
      profile.dams_sire,
      profile.total_stakes,
      profile.season_stakes,
      profile.current_rating,
      profile.source_url,
      hash,
      changed ? JSON.stringify(rawHtmlSnippet) : null,
      now,
      now,
    )
    .run();
  return { changed, content_hash: hash };
}

export async function replaceHorseRuns(
  db: D1Database,
  horseCode: string,
  runs: PastRun[],
  sourceUrl: string,
): Promise<StoreResult> {
  const hash = await contentHash(runs);
  const state = await db
    .prepare(`SELECT last_runs_hash FROM horse_fetch_state WHERE horse_code=?`)
    .bind(horseCode)
    .first<{ last_runs_hash: string | null }>();
  const changed = state?.last_runs_hash !== hash;
  const now = new Date().toISOString();

  if (changed) {
    await db.prepare(`DELETE FROM horse_past_runs WHERE horse_code=?`).bind(horseCode).run();
    for (const run of runs) {
      const rowHash = await contentHash(run);
      await db
        .prepare(
          `INSERT OR REPLACE INTO horse_past_runs (
            horse_code, race_index, placing, race_date, venue, track, course, distance, going, race_class,
            draw, rating, trainer, jockey, lbw, win_odds, actual_weight, running_position, finish_time,
            declared_weight, gear, data_source, source_url, content_hash, raw_json, fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'html_horse', ?, ?, ?, ?)`,
        )
        .bind(
          horseCode,
          run.race_index,
          run.placing,
          run.race_date,
          run.venue,
          run.track,
          run.course,
          run.distance,
          run.going,
          run.race_class,
          run.draw,
          run.rating,
          run.trainer,
          run.jockey,
          run.lbw,
          run.win_odds,
          run.actual_weight,
          run.running_position,
          run.finish_time,
          run.declared_weight,
          run.gear,
          sourceUrl,
          rowHash,
          JSON.stringify(run),
          now,
        )
        .run();
    }
  }

  await db
    .prepare(
      `INSERT INTO horse_fetch_state (horse_code, last_runs_hash, last_fetched_at, first_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(horse_code) DO UPDATE SET last_runs_hash=excluded.last_runs_hash, last_fetched_at=excluded.last_fetched_at`,
    )
    .bind(horseCode, hash, now, now)
    .run();

  return { changed, content_hash: hash };
}

export async function upsertInjuries(
  db: D1Database,
  records: Array<VetRecord & { horse_code: string | null; meeting_date?: string; venue?: string }>,
  sourceUrl: string,
): Promise<StoreResult> {
  const hash = await contentHash(records);
  const key = `injuries:${records[0]?.meeting_date ?? "latest"}:${records[0]?.venue ?? ""}`;
  const raw = await storeRawDocument(db, "html_vet", key, records, sourceUrl);
  const now = new Date().toISOString();

  if (raw.changed) {
    for (const rec of records) {
      const rowHash = await contentHash(rec);
      await db
        .prepare(
          `INSERT INTO horse_injuries (
            horse_code, horse_name, meeting_date, venue, record_date, details, passed_on,
            data_source, source_url, content_hash, raw_json, fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'html_vet', ?, ?, ?, ?)
          ON CONFLICT(horse_code, record_date, details) DO UPDATE SET
            horse_name=excluded.horse_name,
            passed_on=excluded.passed_on,
            content_hash=excluded.content_hash,
            raw_json=excluded.raw_json,
            fetched_at=excluded.fetched_at`,
        )
        .bind(
          rec.horse_code,
          rec.horse_name,
          rec.meeting_date ?? null,
          rec.venue ?? null,
          rec.record_date,
          rec.details,
          rec.passed_on,
          sourceUrl,
          rowHash,
          JSON.stringify(rec),
          now,
        )
        .run();
    }
  }
  return { changed: raw.changed, content_hash: hash };
}
