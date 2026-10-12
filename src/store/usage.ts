/** Per-HKT-day HKJC GraphQL request counter (table graphql_usage). */
export async function addGraphqlUsage(db: D1Database, day: string, delta: number): Promise<number> {
  if (delta > 0) {
    await db
      .prepare(
        `INSERT INTO graphql_usage (day, count, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET count = graphql_usage.count + excluded.count,
           updated_at = excluded.updated_at`,
      )
      .bind(day, delta, new Date().toISOString())
      .run();
  }
  return getGraphqlUsage(db, day);
}

export async function getGraphqlUsage(db: D1Database, day: string): Promise<number> {
  const row = await db
    .prepare(`SELECT count FROM graphql_usage WHERE day=?`)
    .bind(day)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
