# HKJC Data Worker

Cloudflare Worker：从马会官方 GraphQL + 官网马匹页拉取赛马数据 → 存 D1（原始 JSON + content hash）→ **仅在内容 hash 变化时**推送 → Bearer API 查询。

**不做任何计算、估算、推介或改写**；官方给什么存什么，取不到的字段一律 `null`。

---

## 目录

1. [与规格的偏差](#1-与规格的偏差已确认)
2. [基础 URL 与鉴权](#2-基础-url-与鉴权)
3. [查询 API（接收方）](#3-查询-api接收方)
4. [Webhook 推送契约](#4-webhook-推送契约)
5. [数据表与可空字段](#5-数据表与可空字段)
6. [配置 / 环境变量](#6-配置--环境变量)
7. [本地开发](#7-本地开发)
8. [D1 与部署](#8-d1-与部署)
9. [回填 / 测试推送 / 实时开关](#9-回填--测试推送--实时开关)
10. [GraphQL 与马匹页说明](#10-graphql-与马匹页说明)
11. [Polling & write budget](#11-polling--write-budget)

---

## 1. 与规格的偏差（已确认）

| 原规格 | 实际情况 | 本仓库处理 |
|---|---|---|
| `raceMeetings(date)` 回填 5 年 | GraphQL **白名单**；`raceMeetings` **忽略过去日期**，只返回当前/下一档 | 实时用 query 01+02(+03/04)。回填用 **`rbcList` + `rbcMeeting`（约 2 个月）** |
| `BACKFILL_YEARS=5` | 改为 **`BACKFILL_DAYS=60`** | `/health` 报告缺口 |
| 派彩取不到 | 当前会议 query 04 有 dividends；rbc 窗口内也有 | 有则存，无则 `null` |
| 伤患 / 往绩走 GraphQL | **白名单无此类 query**；runner 仅有 `horse.code` / `horse.id` | 爬 `racing.hkjc.com` 马匹页 + 伤患页（礼貌限速） |
| 推送 URL 写在规格 | **禁止写死密钥** | 订阅者表 + Admin API；`PUSH_TARGET_URL` 仅在无订阅者行时兜底；默认 `LIVE_PUSH_ENABLED=false` |
| — | 境外转播 `S1–S5` | **跳过**，只保留 `ST` / `HV` |
| — | 自定义域名 | **`hkjc.cf-connect.top`**（`workers.dev` fallback） |

回填（`graphql_rbc`）缺口：马名、名次、独赢/位置赔率为 `null`；有 status 与 dividends。

---

## 2. 基础 URL 与鉴权

| 环境 | Base URL |
|---|---|
| 生产（推荐） | `https://hkjc.cf-connect.top` |
| Fallback | `https://hkjc-data-worker.<account>.workers.dev`（部署后由 Cloudflare 分配） |
| 本地 | `http://127.0.0.1:8787` |

除 **`GET /health`** 外，所有接口需要：

```http
Authorization: Bearer <API_TOKEN>
```

`API_TOKEN` 通过 `wrangler secret put API_TOKEN` 配置，**不要写进代码或提交到 git**。

### 错误码

| HTTP | 含义 |
|---|---|
| `200` | 成功 |
| `400` | 缺参数 / 参数非法 |
| `401` | 缺少或错误的 Bearer token |
| `404` | 路径或资源不存在（如未知马号） |
| `405` | 方法不允许 |
| `500` | 未配置 `API_TOKEN` 或内部错误 |

错误体示例：

```json
{ "error": "Unauthorized" }
```

---

## 3. 查询 API（接收方）

以下示例默认：

```bash
export BASE=https://hkjc.cf-connect.top
export TOKEN='your-api-token'
```

### 3.1 `GET /health`（无需鉴权）

存活、回填范围、缺口、白名单告警、最后拉取/推送。

```bash
curl -s "$BASE/health" | jq .
```

示例响应：

```json
{
  "ok": true,
  "service": "hkjc-data-worker",
  "timezone": "Asia/Hong_Kong",
  "live_push_enabled": "false",
  "backfill_days": "60",
  "backfill_source": "graphql",
  "last_fetch_at": "2026-10-08T12:00:00.000Z",
  "last_push_at": null,
  "meetings_stored": 1,
  "odds_snapshots": 9,
  "backfill": { "completed_meetings": 0, "from": null, "to": null },
  "gaps": {
    "note": "GraphQL raceMeetings ignores past dates (live only). Backfill uses rbcMeeting (~2 months): has race/runner status + dividends; horse names, finalPosition, win/place odds are null.",
    "place_odds_in_backfill": null,
    "final_position_in_backfill": null,
    "horse_names_in_backfill": null,
    "history_beyond_rbc_window": "unavailable via GraphQL"
  },
  "alerts": { "whitelist_error": "" }
}
```

若 HKJC 更换白名单 query，`alerts.whitelist_error` 会出现 `WHITELIST_ERROR` 文案。

---

### 3.2 `GET /v1/meetings`

| 参数 | 必填 | 说明 |
|---|---|---|
| `from` | 否 | `YYYY-MM-DD` |
| `to` | 否 | `YYYY-MM-DD` |

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/meetings?from=2026-10-01&to=2026-10-08" | jq .
```

```json
{
  "meetings": [
    {
      "meeting_date": "2026-10-07",
      "venue": "HV",
      "total_races": 9,
      "status": "CLOSED",
      "data_source": "graphql",
      "updated_at": "2026-10-08T04:00:00.000Z"
    }
  ]
}
```

---

### 3.3 `GET /v1/races`

| 参数 | 必填 |
|---|---|
| `date` | 是 |
| `venue` | 是（`ST` / `HV`） |

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/races?date=2026-10-07&venue=HV" | jq .
```

```json
{
  "date": "2026-10-07",
  "venue": "HV",
  "races": [
    {
      "race_no": 1,
      "post_time": "2026-10-07T18:35:00+08:00",
      "status": "RESULT",
      "distance": 1800,
      "going": "GOOD TO FIRM",
      "course_code": "C+3",
      "race_class": "Class 5",
      "data_source": "graphql"
    }
  ]
}
```

---

### 3.4 `GET /v1/odds/latest`

| 参数 | 必填 |
|---|---|
| `date` / `venue` / `race_no` | 是 |

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/odds/latest?date=2026-10-07&venue=HV&race_no=1" | jq .
```

```json
{
  "date": "2026-10-07",
  "venue": "HV",
  "race_no": 1,
  "snapshot": {
    "snapshot_time": "2026-10-07T18:43:31.223+08:00",
    "content_hash": "abc…",
    "pool_status": "STOP_SELL",
    "data_source": "graphql",
    "data": {
      "race_no": 1,
      "pool_status": "STOP_SELL",
      "runners": [
        {
          "horse_no": 1,
          "horse_name": "CAN'T GO WONG",
          "win_odds": 4.0,
          "place_odds": 1.8,
          "status": "Ran",
          "final_position": 8
        }
      ]
    }
  }
}
```

无快照时 `snapshot` 为 `null`。

---

### 3.5 `GET /v1/odds/history`

参数同 latest；返回该场全部快照时间序列（仅 **内容变化** 时写入新行）。

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/odds/history?date=2026-10-07&venue=HV&race_no=1" | jq .
```

---

### 3.6 `GET /v1/results`

| 参数 | 必填 |
|---|---|
| `date` / `venue` | 是 |

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/results?date=2026-10-07&venue=HV" | jq .
```

```json
{
  "date": "2026-10-07",
  "venue": "HV",
  "results": [
    {
      "race_no": 1,
      "horse_no": 1,
      "final_position": 8,
      "dead_heat": 0,
      "win_odds": 4.0,
      "place_odds": 1.8,
      "dividends": [{ "oddsType": "WIN", "dividends": [{ "winComb": "9", "div": "47.5" }] }],
      "data_source": "graphql"
    }
  ]
}
```

回填来源行可能 `final_position` / `win_odds` / `place_odds` 为 `null`，但 `dividends` 可能有值。

---

### 3.7 `GET /v1/changes`

| 参数 | 必填 | 说明 |
|---|---|---|
| `since` | 是 | ISO 时间，返回该时刻之后的变动与新赔率快照 |

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  --get "$BASE/v1/changes" --data-urlencode "since=2026-10-07T00:00:00+08:00" | jq .
```

---

### 3.8 马匹资料

GraphQL **无**伤患/往绩；来自官网 HTML，`data_source` 为 `html_horse` / `html_vet`。

#### `GET /v1/horses/:code`

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/horses/H087" | jq .
```

```json
{
  "horse": {
    "horse_code": "H087",
    "horse_id": "HK_2022_H087",
    "name_en": "CAN'T GO WONG",
    "colour": "Chestnut",
    "sex": "Gelding",
    "owner": "Or Wing Chi",
    "sire": "...",
    "dam": "...",
    "source_url": "https://racing.hkjc.com/en-us/local/information/horse?HorseNo=H087&Option=1",
    "content_hash": "...",
    "fetched_at": "..."
  }
}
```

#### `GET /v1/horses/:code/runs`

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/horses/H087/runs" | jq .
```

```json
{
  "horse_code": "H087",
  "runs": [
    {
      "race_index": "079",
      "placing": "08",
      "race_date": "2026-10-07",
      "venue": "HV",
      "track": "Turf",
      "course": "C+3",
      "distance": 1800,
      "going": "GF",
      "race_class": "5",
      "draw": 2,
      "rating": "40",
      "trainer": "F C Lor",
      "jockey": "Z Purton",
      "lbw": "4-3/4",
      "win_odds": 4,
      "actual_weight": 135,
      "running_position": "9 8 8 10 8",
      "finish_time": "1.50.42",
      "declared_weight": 1170,
      "gear": "B/TT"
    }
  ]
}
```

#### `GET /v1/horses/:code/injuries`

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/horses/H087/injuries" | jq .
```

```json
{
  "horse_code": "H087",
  "injuries": [
    {
      "record_date": "2025-05-07",
      "details": "…",
      "passed_on": "2025-05-20",
      "source_url": "https://racing.hkjc.com/en-us/local/information/veterinaryrecord?RaceDate=2026/10/07&Racecourse=HV"
    }
  ]
}
```

马匹刷新策略：当前/下一档出赛马，**首次见到排位时拉一次**，**赛日再拉一次**；不在 30 秒赔率轮询里刷。

---

### 3.9 管理接口（同样 Bearer）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/admin/ingest` | 拉取当前 GraphQL 赛事入库（并触发马匹页按策略刷新） |
| `POST` | `/v1/admin/backfill` | 回填一步；body 可选 `{"limit":5}` |
| `POST` | `/v1/admin/test-push` | 推送 `event:"test"`（需有启用中的订阅者，或兜底 `PUSH_TARGET_URL`） |
| `GET` | `/v1/admin/subscribers` | 列出订阅者（**不返回 secret**，仅 `has_secret`） |
| `POST` | `/v1/admin/subscribers` | 新增订阅者：`{"url","secret?","enabled?"}` |
| `PATCH` | `/v1/admin/subscribers/:id` | 更新 `url` / `secret` / `enabled`（`secret: null` 或 `""` 清除） |
| `DELETE` | `/v1/admin/subscribers/:id` | 删除订阅者 |

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/admin/ingest" | jq .
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"limit":5}' "$BASE/v1/admin/backfill" | jq .
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/admin/test-push" | jq .

# 订阅者管理
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/admin/subscribers" | jq .
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/hook","secret":"optional-hmac","enabled":true}' \
  "$BASE/v1/admin/subscribers" | jq .
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled":false}' "$BASE/v1/admin/subscribers/1" | jq .
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/v1/admin/subscribers/1" | jq .
```

列表项示例（密钥永不回显）：

```json
{
  "subscribers": [
    {
      "id": 1,
      "url": "https://webhook.site/…",
      "enabled": true,
      "has_secret": false,
      "created_at": "2026-10-08T00:00:00.000Z",
      "updated_at": "2026-10-08T00:00:00.000Z"
    }
  ]
}
```

---

## 4. Webhook 推送契约

### 4.1 传输

- 向**每个启用中的订阅者**独立 `POST` 同一份信封（互不影响：一方失败/重试不阻塞另一方）
- `Content-Type: application/json`
- `User-Agent: hkjc-data-worker/1.0`（Cloudflare 对空 UA 会报 1010，必须带）
- 若该订阅者配置了 secret：`X-Signature` = 对**原始 JSON body** 的 HMAC-SHA256 **小写 hex**（无 `sha256=` 前缀）
- 期望响应：`202`（或 2xx），body 建议 `{"received":true}`
- 迁移会 seed 两个接收方（仅 URL，密钥不进 git）：
  - `https://webhook.site/902a6166-6336-452d-97c5-e64018d97919`（无 HMAC）
  - `https://hkjc-agent.cf-connect.top/webhook`（若设置了 `PUSH_SECRET`，运行时写入该行 secret）
- **兜底**：仅当 `push_subscribers` **没有任何行**时，才使用 `PUSH_TARGET_URL`（+ 可选全局 `PUSH_SECRET`），避免全新部署静默丢事件

### 4.2 信封 schema：`hkjc-push/1.0`

```json
{
  "schema": "hkjc-push/1.0",
  "event": "odds_update",
  "sent_at": "2026-10-08T19:04:30+08:00",
  "meeting_date": "2026-10-08",
  "venue": "HV",
  "races": [ /* 见下；部分事件可为空数组，细节在 meta */ ],
  "meta": {}
}
```

### 4.3 变更才推（hash diff）

1. 每次拉取都会尝试入库。
2. 对载荷做稳定 canonical JSON → SHA-256。
3. **与上一份 hash 相同**：只记 `fetched_at` / 时间戳类元数据，**不推送**。
4. **hash 不同**：写新快照/原文，并推送对应 `event`。
5. 马匹类推送 **按会议批量**（`meta.horse_codes`），**绝不逐马刷屏**。

### 4.4 `LIVE_PUSH_ENABLED` 门闩

| 事件 | 默认（`false`） | 说明 |
|---|---|---|
| `test` / `schedule` / `backfill_progress` / `whitelist_alert` | 仍可推（需有启用订阅者或兜底 URL） | 联调与告警 |
| `odds_update` / `lock` / `scratch` / `result` / `horse_update` / `injury_update` / `runs_update` / `dividends` / `changes` | **跳过** | 接收方确认 `test` 后再设 `LIVE_PUSH_ENABLED=true` |

### 4.5 事件类型与示例

#### `test`（联调第一条）

```json
{
  "schema": "hkjc-push/1.0",
  "event": "test",
  "sent_at": "2026-10-08T12:00:00+08:00",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "races": [
    {
      "race_no": 1,
      "post_time": "2026-10-07T18:35:00+08:00",
      "snapshot_time": "2026-10-07T18:43:31.223+08:00",
      "pool_status": "STOP_SELL",
      "runners": [
        {
          "horse_no": 1,
          "horse_name": "CAN'T GO WONG",
          "win_odds": 4.0,
          "place_odds": 1.8,
          "status": "Ran",
          "final_position": 8
        }
      ]
    }
  ],
  "meta": { "note": "manual test push; LIVE_PUSH_ENABLED still gates live events" }
}
```

#### `schedule`

```json
{
  "schema": "hkjc-push/1.0",
  "event": "schedule",
  "sent_at": "2026-10-08T10:00:00+08:00",
  "meeting_date": null,
  "venue": null,
  "races": [],
  "meta": {
    "active": [
      { "date": "2026-10-07", "venue": "HV", "status": "CLOSED", "races": [] }
    ]
  }
}
```

#### `odds_update` / `lock` / `scratch` / `result`

与规格相同：`races[]` 内含 `race_no`、`post_time`、`snapshot_time`、`pool_status`、`runners[]`（`horse_no`、`horse_name`、`win_odds`、`place_odds`、`status`、`final_position`）。

- `lock`：池状态变为 `STOP_SELL` 时最终快照  
- `scratch`：检测到退出/划走  
- `result`：参赛马 `finalPosition` 齐全  

#### `dividends`

```json
{
  "schema": "hkjc-push/1.0",
  "event": "dividends",
  "sent_at": "2026-10-07T20:00:00+08:00",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "races": [],
  "meta": { "content_hash": "…", "pools": 18 }
}
```

完整派彩 JSON 已入库，接收方用 API `/v1/results` 拉取。

#### `changes`

```json
{
  "schema": "hkjc-push/1.0",
  "event": "changes",
  "sent_at": "2026-10-07T18:05:00+08:00",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "races": [],
  "meta": { "new_events": 3, "content_hash": "…" }
}
```

#### `horse_update` / `runs_update` / `injury_update`

```json
{
  "schema": "hkjc-push/1.0",
  "event": "horse_update",
  "sent_at": "2026-10-07T12:00:00+08:00",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "races": [],
  "meta": { "horse_codes": ["H087", "H123"], "count": 2, "content_hash": "…" }
}
```

```json
{
  "schema": "hkjc-push/1.0",
  "event": "runs_update",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "races": [],
  "meta": { "horse_codes": ["H087"], "count": 1, "content_hash": "…" }
}
```

```json
{
  "schema": "hkjc-push/1.0",
  "event": "injury_update",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "races": [],
  "meta": {
    "source": "https://racing.hkjc.com/en-us/local/information/veterinaryrecord?RaceDate=2026/10/07&Racecourse=HV"
  }
}
```

详情用 `/v1/horses/:code`、`/runs`、`/injuries` 查询。

#### `backfill_progress` / `whitelist_alert`

```json
{
  "schema": "hkjc-push/1.0",
  "event": "backfill_progress",
  "races": [],
  "meta": {
    "processed": [{ "date": "2026-10-04", "venue": "ST", "status": "done" }],
    "remaining_estimate": 8,
    "window": { "start": "2026-08-09", "end": "2026-10-07", "backfill_days": 60 }
  }
}
```

```json
{
  "schema": "hkjc-push/1.0",
  "event": "whitelist_alert",
  "races": [],
  "meta": { "message": "Internal server error - WHITELIST_ERROR" }
}
```

### 4.6 失败重试

1. **按订阅者**失败写入 `push_log` + `pending_pushes`（含 `subscriber_id`）。  
2. 指数退避：**1 分钟 → 5 分钟 → 15 分钟** 各重试一次（只重投失败的那一个订阅者）。  
3. 仍失败：挂起，**下一次成功推送时 piggy-back 补推**（不丢、不狂刷）。

### 4.7 可选 HMAC 校验（接收方伪代码）

```js
import crypto from "node:crypto";

function verify(reqBodyBuffer, signatureHex, secret) {
  const expected = crypto.createHmac("sha256", secret).update(reqBodyBuffer).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHex));
}

// Express 示例
app.post("/hook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.get("X-Signature");
  if (process.env.PUSH_SECRET) {
    if (!sig || !verify(req.body, sig, process.env.PUSH_SECRET)) {
      return res.status(401).json({ error: "bad signature" });
    }
  }
  const envelope = JSON.parse(req.body.toString("utf8"));
  // envelope.schema === "hkjc-push/1.0"
  res.status(202).json({ received: true });
});
```

---

## 5. 数据表与可空字段

| 表 | 作用 |
|---|---|
| `meetings` / `races` / `runners` | 赛事树 |
| `odds_snapshots` | 赔率快照（`raw_json` + `content_hash`）；仅 hash 变才新行 |
| `results` | 名次、最终赔率、派彩 JSON |
| `change_events` | 退出/骑师变更等 |
| `push_subscribers` | Webhook 订阅者（url / secret / enabled）；Admin API 管理 |
| `push_log` / `pending_pushes` | 推送审计与按订阅者重试队列 |
| `backfill_progress` / `worker_meta` | 回填断点与运行元数据 |
| `horses` | 马匹档案（HTML） |
| `horse_past_runs` | 往绩 |
| `horse_injuries` | 伤患/兽医记录 |
| `raw_documents` | 任意 GraphQL/HTML 文档原文 + hash（能采尽采） |
| `horse_fetch_state` | 马匹刷新去重（首见 / 赛日） |

### 可能为 `null` 的字段与原因

| 字段 | 何时为 null |
|---|---|
| `place_odds`（回填） | rbcMeeting 无位置赔率 |
| `final_position` / 马名 / 档位等（回填） | rbc 仅 status + dividends |
| `dividends`（非当前窗） | GraphQL 无更长历史 |
| 马匹中文名等 | 英文页未提供则 null |
| `horse_code`（部分伤患行） | 伤患页按马名列出，未能映射到 code 时 |
| 推送 `races`（部分事件） | 详情在 DB/API；信封只带 `meta` 索引 |

原则：**缺失不估算、不编造**。

---

## 6. 配置 / 环境变量

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `PUSH_TARGET_URL` | Secret | — | **仅当订阅者表为空时**兜底 Webhook；有订阅者行则忽略 |
| `API_TOKEN` | Secret | — | Bearer（查询 + Admin） |
| `PUSH_SECRET` | Secret 可选 | — | 写入 agent 订阅者 secret（若该行尚无 secret）；兜底 URL 时也用于 HMAC |
| `POLL_INTERVAL_SEC` | var | `30` | 开跑前 ≤30 分钟轮询秒数（更远见 §11） |
| `BACKFILL_DAYS` | var | `60` | GraphQL 回填窗口 |
| `BACKFILL_SOURCE` | var | `graphql` | `graphql` / `off` |
| `TIMEZONE` | var | `Asia/Hong_Kong` | |
| `LIVE_PUSH_ENABLED` | var/secret | `false` | 实时/马匹/派彩等推送门闩 |
| `HORSE_REFRESH_BATCH` | var | `15` | 每次最多抓取的马匹 HTML 页数（可续跑） |

`wrangler.toml` 已配置自定义域名：

```toml
routes = [
  { pattern = "hkjc.cf-connect.top", custom_domain = true }
]
```

`workers.dev` 默认仍启用作为 fallback。

---

## 7. 本地开发

```bash
npm ci
cp .dev.vars.example .dev.vars   # 设置 API_TOKEN；不要填真实 PUSH_TARGET_URL / PUSH_SECRET
npx wrangler d1 migrations apply hkjc --local
# 本地若不想打到 seed 的真实 URL：用 Admin API 删掉/禁用订阅者，或清空 push_subscribers
npx wrangler dev --local --persist-to .wrangler/state

# 另一终端：真实 GraphQL ingest + 打全 API
API_TOKEN=dev-local-token-change-me npx tsx scripts/local-ingest.ts

npm run typecheck
npm test
```

单元测试 **不** seed 生产 URL，且默认 **不会** 打真实 webhook。

---

## 8. D1 与部署

```bash
# 在 Buzzbus 账号
npx wrangler d1 create hkjc
# 把 database_id 写入 wrangler.toml
npx wrangler d1 migrations apply hkjc --remote

npx wrangler secret put API_TOKEN
# 可选：agent 订阅者 HMAC（迁移 seed URL 后运行时写入该行）
npx wrangler secret put PUSH_SECRET
# 可选：仅在订阅者表为空时的兜底 URL（一般可不设）
# npx wrangler secret put PUSH_TARGET_URL

npx wrangler deploy
# 部署后 apply migrations，再用 Admin API 增删订阅者
```

GitHub Actions：

- **PR / push**：`typecheck` + `test`
- **仅 `workflow_dispatch`**：部署（需 repo secrets `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`）

本 Agent **不会**替你部署，也 **不会**向真实 webhook 发数据。

---

## 9. 回填 / 测试推送 / 实时开关

```bash
# 可续跑回填
curl -X POST "$BASE/v1/admin/backfill" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"limit":5}'

# 先 test，接收方确认 202 后再开实时
curl -X POST "$BASE/v1/admin/test-push" -H "Authorization: Bearer $TOKEN"

# 开启实时推送
npx wrangler secret put LIVE_PUSH_ENABLED   # 设为 true
# 或改 wrangler.toml [vars] LIVE_PUSH_ENABLED = "true" 后重新部署
```

---

## 10. GraphQL 与马匹页说明

### GraphQL

- 端点：`POST https://info.cld.hkjc.com/graphql/base/`
- **必须**使用 `src/queries/*.gql`（bet.hkjc.com 白名单原文）。改字段 → `WHITELIST_ERROR`。
- `01` 赛事+马匹，`02` WIN/PLA（`raceNo:0` 全场），`03` 变动，`04` 派彩，`05` 赛日索引，`06` 按日回填。

### 实时轮询

- Cron（每小时）：赛程 + 少量回填 + 推送重试。  
- 有本地赛日：每 meeting 一个 Durable Object，alarm 自循环（档位见 §11）。  
- 无赛日：不高频空转。

### 马匹 HTML

- 档案+往绩：`https://racing.hkjc.com/en-us/local/information/horse?HorseNo={code}&Option=1`
- 伤患（赛日页）：`https://racing.hkjc.com/en-us/local/information/veterinaryrecord?RaceDate=YYYY/MM/DD&Racecourse=ST|HV`
- 礼貌间隔约 500ms；只对出赛马；首见 + 赛日各刷新一次。

---

## 11. Polling & write budget

生产曾出现约 **~114k D1 rows written/day**、每 15 分钟约 **~2.5k queries**（约 07:45 HKT 起）。根因：MeetingPoller 每次 alarm 无条件 `persistMeetingTree`（会议/场次/马匹/成绩约 100+ 行）+ 每次写 `last_fetch_at`，而赔率本身很少变。

### 轮询档位（相对下一场 `post_time`）

| 距开跑 | 间隔 |
|---|---|
| > 2 小时 | **5 分钟** |
| 30 分钟 – 2 小时 | **60 秒** |
| ≤ 30 分钟 | **`POLL_INTERVAL_SEC`（默认 30s）** |
| 会议结束 / 全部有成绩 | **停止** alarm（cron 日后再启） |

### D1 写入门闩

1. **Meeting tree hash 门控**（DO storage）：对规范化会议树算 content hash；仅 hash 变化时调用 `persistMeetingTree`。  
2. **Upsert 同值 no-op**：`ON CONFLICT DO UPDATE … WHERE … IS DISTINCT FROM …`，cron/回填路径也不会重写相同行。  
3. **`last_fetch_at`**：每次 poll 写入 DO storage；**最多每 5 分钟**刷到 D1（`/health` 仍读 D1）。  
4. **赔率快照**：仍用 `insertOddsSnapshotIfChanged`（hash 去重）；推送语义不变（`odds_update` 仅变赔率；`lock`/`result` 每场一次）。

### 预期写入量（量级）

| | Before | After（平稳日、赔率少变） |
|---|---|---|
| Meeting tree 行/日 | ~100+ 行 × 每次 poll ≈ **~10万级** | 仅内容变化时写（赛程/状态/成绩变动，通常 **数十～数百行/日**） |
| `last_fetch_at` | 每次 poll | ≤ **~288 次/日**（5 min） |
| Odds snapshots | 已 hash 去重 | 不变 |
| Queries / 15 min（07:45+） | ~2.5k（含大量无意义 upsert） | 随 poll 档位下降 + 跳过 tree persist 显著降低 |

---

## 开发命令速查

```bash
npm run typecheck
npm test
npm run dev
npm run db:migrate:local
```
