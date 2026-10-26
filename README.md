# HKJC Data Worker

Cloudflare Worker：从马会官方 GraphQL + 官网马匹页拉取赛马数据 → 存 D1（原始 JSON + content hash）→ **仅在内容 hash 变化时**推送 → Bearer API 查询。

**不做任何计算、估算、推介或改写**；官方给什么存什么，取不到的字段一律 `null`。

---

## 目录

1. [与规格的偏差](#1-与规格的偏差已确认)
2. [基础 URL 与鉴权](#2-基础-url-与鉴权)
3. [查询 API（接收方）](#3-查询-api接收方)
4. [Webhook 推送契约（hkjc-push/1.1）](#4-webhook-推送契约hkjc-push11)
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

JSON 响应头：`Content-Type: application/json`，以及 **`Vary: Accept-Encoding`**（所有 `/v1/*` 成功／错误 JSON，含 `/health`）。

除 **`GET /health`** 外，所有接口需要 Bearer：

```http
Authorization: Bearer <token>
```

| Secret | 用途 |
|---|---|
| `API_TOKEN` | **写 + 读**。可逗号分隔多个。授权全部查询 `GET /v1/*`，以及 admin / subscriber / test-push 等写接口。 |
| `READ_API_TOKEN` | **只读**（issue #38）。可逗号分隔多个。仅授权查询 `GET /v1/*`（meetings、races、odds、results、events、changes、horses…）。**不能**调用 `/v1/admin/*`、`/v1/admin/subscribers`、`/v1/admin/test-push`。 |

配置（**不要**把真实 token 写进代码、issue 或聊天）：

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put READ_API_TOKEN
```

分析消费端应优先使用 `READ_API_TOKEN`。未配置 `READ_API_TOKEN` 时，查询仍可用 `API_TOKEN`。

### 配额与 429 / 重试约定（查询 API）

| 项 | 约定 |
|---|---|
| 查询 API 配额 | **当前无**按客户端的硬配额或主动 `429`。Worker 不按 Bearer 限流查询接口。 |
| 上游 GraphQL 预算 | `DAILY_REQUEST_BUDGET`（默认 30000）约束 **HKJC 抓取**，不影响已入库数据的读路径。 |
| 客户端重试 | 对 `5xx` / 网络错误建议指数退避（如 1s→2s→4s，上限约 30s），最多 3–5 次；`401`/`400`/`404` **不要**重试。 |
| `429` | 查询路径正常情况下 **不会**返回 `429`。若将来网关层出现 `429`，请尊重 `Retry-After`（若有），否则退避 ≥5s 再试。推送侧熔断的 `429` 计数仅针对 **出站 webhook**，与读 API 无关。 |

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
# 分析端优先用只读 token；也可用 API_TOKEN
export TOKEN='your-read-api-token'
```

### 3.1 `GET /health`（无需鉴权）

存活、回填范围、缺口、白名单告警、最后拉取/推送，以及推送隔离健康度（熔断、队列积压、poller 心跳、各 stage 最近错误）。

```bash
curl -s "$BASE/health" | jq .
```

示例响应（字段摘要）：

```json
{
  "ok": true,
  "service": "hkjc-data-worker",
  "timezone": "Asia/Hong_Kong",
  "live_push_enabled": "false",
  "last_fetch_at": "2026-10-08T12:00:00.000Z",
  "last_push_at": "2026-10-08T12:01:00+08:00",
  "last_push_status": "202",
  "last_push": { "event_type": "lock", "http_status": 202, "success": 1, "sent_at": "…" },
  "push_queue": {
    "bound": true,
    "backlog": 0,
    "pending_pushes": 2,
    "pending_due": 1,
    "pending_deferred": 1,
    "gave_up": 0,
    "rate_limit_delays": 0
  },
  "subscribers": [
    {
      "subscriber_id": 1,
      "url": "https://…",
      "circuit_state": "closed",
      "consecutive_failures": 0,
      "consecutive_429s": 0,
      "last_success_at": "…",
      "last_failure_at": null,
      "last_http_status": 202,
      "last_error": null,
      "backlog_size": 0,
      "rate_limit_delays": 0
    }
  ],
  "poller": {
    "last_fetch_at": "…",
    "age_ms": 12000,
    "watchdog_last_run": "…",
    "watchdog_last_rearm": null
  },
  "stage_errors": {
    "schedule": null,
    "odds": null,
    "dividends": null,
    "horses": null,
    "runs": null,
    "injuries": null,
    "pushes": null
  },
  "backfill": { "completed_meetings": 0, "from": null, "to": null },
  "gaps": {
    "odds_coverage_threshold_ms": 600000,
    "odds_coverage": null
  },
  "alerts": { "whitelist_error": "", "odds_coverage_gap": null }
}
```

- `last_push_at` / `last_push_status` 取自 **最新一条任意类型** 的 `push_log`（不再只看 odds_update）。
- `push_queue.gave_up` / `pending_due` / `pending_deferred`：故意放弃的 pre-1.1 行数、到期待重试、延后/ piggyback 等待数（触顶 `PUSH_RETRY_MAX_PER_RUN` 时是 defer 不是 drop）。
- `push_queue.rate_limit_delays`：因 per-subscriber 速率限制而 **延迟**（非丢弃）的累计次数；`subscribers[].backlog_size` / `rate_limit_delays` 为每订阅者视图。
- 熔断打开时不会自动删除订阅者；事件仍在 `push_events`，可用 `/v1/events` 回放。
- `gave_up` **仅**适用于 pre-1.1 legacy（空 `event_id` + `created_at` 早于 `PUSH_1_1_DEPLOY_CUTOFF` + 非 1.1 schema）；赛日 live 推送永不会被放弃。
- `gaps.odds_coverage` / `alerts.odds_coverage_gap`：来自 `worker_meta` 的廉价读取（非表扫描）。任一赛场 `poll_ticks` 间隔 **>10 分钟** → `COLLECTION_FAILURE`（R2），并推送一次 `odds_coverage_gap`（签名去重；仍走安静时段 / Manus 窗口门闩）。

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
      "data_source": "graphql",
      "observation": {
        "returned_at": "2026-10-07T10:45:00.000Z",
        "sample_interval_s": 3,
        "last_successful_poll_at": "2026-10-07T10:44:57.000Z",
        "last_content_change_at": "2026-10-07T10:40:00.000Z",
        "collection_failure_threshold_ms": 600000,
        "pools": {
          "WIN": { "last_successful_poll_at": "…", "last_content_change_at": "…", "source_updated_at": null, "sell_status": null, "pool_status": null, "returned_at": "…", "sample_interval_s": 3 },
          "PLA": { "last_successful_poll_at": "…", "last_content_change_at": "…", "source_updated_at": null, "sell_status": null, "pool_status": null, "returned_at": "…", "sample_interval_s": 3 }
        }
      },
      "runners": [
        {
          "horse_no": 1,
          "horse_code": "H087",
          "name_en": "CAN'T GO WONG",
          "name_ch": null,
          "status": "Declared",
          "barrier": 2,
          "handicap_weight": 126,
          "jockey_en": "Z Purton",
          "trainer_en": "F C Lor",
          "last6run": "…"
        }
      ]
    }
  ]
}
```

每场 `runners[]` 含 HKJC 品牌号 `horse_code`（如 `H087`；回填/rbc 缺口时可为 `null`）。

`observation` 为 **新增字段**（issue #38），不改动既有 `runners[]` / 赛程字段。列表路径通常不附带最新快照的 `pool_meta`，故 `pools.*.source_updated_at` / `sell_status` 常为 `null`；按场完整 WIN/PLA 源时间请用 §3.4 `odds/latest`。语义见下表。

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
          "runner_id": "H087",
          "horse_no": 1,
          "horse_code": "H087",
          "horse_name": "CAN'T GO WONG",
          "win_odds": 4.0,
          "place_odds": 1.8,
          "status": "Declared",
          "final_position": 8
        }
      ]
    }
  },
  "observation": {
    "returned_at": "2026-10-07T10:45:01.000Z",
    "sample_interval_s": 3,
    "last_successful_poll_at": "2026-10-07T10:45:00.000Z",
    "last_content_change_at": "2026-10-07T10:40:00.000Z",
    "collection_failure_threshold_ms": 600000,
    "pools": {
      "WIN": {
        "last_successful_poll_at": "2026-10-07T10:45:00.000Z",
        "last_content_change_at": "2026-10-07T10:40:00.000Z",
        "source_updated_at": "2026-10-07T18:40:00+08:00",
        "sell_status": "START_SELL",
        "pool_status": "START_SELL",
        "returned_at": "2026-10-07T10:45:01.000Z",
        "sample_interval_s": 3
      },
      "PLA": {
        "last_successful_poll_at": "2026-10-07T10:45:00.000Z",
        "last_content_change_at": "2026-10-07T10:40:00.000Z",
        "source_updated_at": null,
        "sell_status": "START_SELL",
        "pool_status": "START_SELL",
        "returned_at": "2026-10-07T10:45:01.000Z",
        "sample_interval_s": 3
      }
    }
  }
}
```

无快照时 `snapshot` 为 `null`，但仍返回 `observation`（可仅有 poll 时钟）。`runners[].horse_code` 在入库时写入；读路径也会用 `runners` 表按马号补齐旧快照。

#### `observation` 字段精确语义（issue #38）

| 字段 | 语义 |
|---|---|
| `last_successful_poll_at` | 该场最近一次 **成功写入** `poll_ticks` 的 `tick_time`（不论赔率内容是否变化）。价格静止数分钟时此字段仍会前进——**不能**仅凭变价时间判 stale。 |
| `last_content_change_at` | 该场最近一次 `poll_ticks.changed=1`（即内容 hash 变化、写入新 `odds_snapshots`）的时间。可远早于 `last_successful_poll_at`。 |
| `source_updated_at` | 官方 GraphQL `pmPools.lastUpdateTime`（按 WIN/PLA 分别）。官方省略时为 **`null`**，**从不**用本地时钟冒充。 |
| `returned_at` | 本 API 响应构建时的墙钟（ISO）。卡片可用 `returned_at - last_successful_poll_at` 看观测年龄。 |
| `sample_interval_s` | 配置的实时轮询间隔（秒），来自 `POLL_INTERVAL_MS`（或该快照入库时记录的 `sample_interval_s`）。 |
| `sell_status` / `pool_status` | 该彩池官方 `sellStatus`（二者同值；旧快照无 `pool_meta` 时可能回退到场级 `pool_status`）。 |
| `collection_failure_threshold_ms` | **600000（10 分钟）**——与 issue #26 `COLLECTION_FAILURE` / `MISSING` 一致。卡片仍应自行用 30s/60s 观测年龄告警，**不要**等到满 10 分钟才判不可用。 |

**验收要点**：连续成功轮询且价格 5 分钟不变 → `last_successful_poll_at` 仍新、`last_content_change_at` 旧（案例 A）；最后 >30s 无成功观测 → 即使 `snapshot` 仍有价格，也能从 `last_successful_poll_at` 看出真实年龄（案例 B）。脱敏 fixture：`test/fixtures/observation-case-a.json` / `observation-case-b.json`。

**不改动** webhook / push payload 格式。

---

### 3.5 `GET /v1/odds/history`

参数同 latest；返回该场全部快照时间序列（仅 **内容变化** 时写入新行）。每条快照的 `runners[]` 同样带 `horse_code`。

另含 `coverage`：基于 `poll_ticks`（**每次轮询每场一行**，不压实）的区间分类——`STATIC`（有 tick、间隔 ≤10 分钟）与 `MISSING`（间隔 >10 分钟 = `COLLECTION_FAILURE`）。可选 `from`/`to`（ISO）对任意 `(race, time_range)` 直接回答 `coverage.range.kind` = `STATIC` | `MISSING`（issue #26 A2）。

**`from` / `to` 现有语义（保持不变）：**

| 参数 | 作用 |
|---|---|
| （省略） | `snapshots[]` = 该场全部内容变化快照；`coverage.range` = `null` |
| `from` + `to`（须成对） | **只**计算 `coverage.range.kind` = `STATIC` \| `MISSING`；**不**裁剪 `snapshots[]` |

截止时点 / 游标分页请用 §3.5.0 `/v1/odds/snapshots`（issue #38 P1），勿依赖 history 的 `from`/`to` 过滤快照。

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/odds/history?date=2026-10-07&venue=HV&race_no=1" | jq .

curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/odds/history?date=2026-10-07&venue=HV&race_no=1&from=2026-10-07T12:00:00.000Z&to=2026-10-07T13:00:00.000Z" \
  | jq .coverage.range
```

---

### 3.5.0 `GET /v1/odds/snapshots`（增量 / as_of，issue #38 P1）

按场分页读取 WIN/PLA 赔率快照；**截止时点用入库时间 `created_at`（persisted/available）**，不用官方 `snapshot_time` / `lastUpdateTime`，避免「源时间较早、但 t 之后才入库」的未来泄漏。

| 参数 | 必填 | 说明 |
|---|---|---|
| `date` / `venue` / `race_no` | 是 | 场次 |
| `since_id` | 否 | 游标，只返回 `id > since_id`（类似 `/v1/events?since_seq=`；默认 `0`） |
| `as_of` | 否 | ISO 截止时点；只返回 `created_at <= as_of` 的行 |
| `limit` | 否 | 默认 50，最大 200 |
| `max_bytes` | 否 | 响应软上限，**默认与上限均为 1,200,000**；超额提前截断（至少 1 条）并设 `truncated_by_bytes`（issue #38 A2）。**按未压缩原始 JSON 的 UTF-8 字节计**（`TextEncoder`／响应体在任何 `Content-Encoding` 之前），不是 gzip 后大小，也不是 JS 字符串 `.length`。 |

```bash
# 截止时点 t 之前已入库的快照（第一页）
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/odds/snapshots?date=2026-10-07&venue=HV&race_no=1&as_of=2026-10-07T12:00:00.000Z&limit=50" | jq .

# 游标翻页
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/odds/snapshots?date=2026-10-07&venue=HV&race_no=1&since_id=$NEXT&limit=50" | jq .
```

响应要点：`persisted_time_field` 恒为 `"created_at"`；`next_since_id` / `has_more` / `truncated_by_bytes` 供翻页；`query_ms` 为本次构建耗时（目标 ≤10s）。只读；不增加 D1 写入或 HKJC 请求。

---

### 3.5.1 `GET /v1/odds/coverage`

赔率轮询存在证明（issue #26 R1b）。`date`+`venue` 必填；可选 `race_no`。返回每条 `poll_ticks` 行、缺口（`COLLECTION_FAILURE`）与 `STATIC`/`MISSING` 区间。

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/odds/coverage?date=2026-10-07&venue=HV&race_no=1" | jq .
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
      "horse_code": "H087",
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

回填来源行可能 `final_position` / `win_odds` / `place_odds` 为 `null`，但 `dividends` 可能有值。`horse_code` 优先取 `results` 列，否则 JOIN `runners`。

**名次 fallback（issue #29 / #31）**：当 **冠军名次缺失**（`final_position=1` 不存在——含全场未解析，或仅冠/亚缺失而其余名次齐全）且 WIN 派彩已 OFFICIAL 时，用 `winComb` 反推头马 `final_position=1`；**永不覆盖**任何已有 `>0` 官方名次。无可用派彩则保持 0/`null` 并打 warning。若 WIN 出现多个 `winComb`（平头），每个头马额外写 `dead_heat=1`；单一头马则 `dead_heat` 保持 `null`。修好后下次 `/v1/admin/ingest`（或回填）写入派彩时自动生效。若要补修历史例（如 `2026-10-14` HV R1），在赛日仍可被 GraphQL 拉到时执行：

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/admin/ingest" | jq .
# 然后核对：
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/results?date=2026-10-14&venue=HV" | jq '.results[] | select(.race_no==1) | {horse_no, final_position}'
```

---

### 3.6b `GET /v1/sectionals`（段速，issue #46）

| 参数 | 必填 |
|---|---|
| `date` / `venue` | 是 |
| `race_no` | 否（省略则返回该会议全部场次） |

来源：官网 `displaysectionaltime`（**非**已停用的 legacy `.aspx`）：

`https://racing.hkjc.com/en-us/local/information/displaysectionaltime?racedate=DD/MM/YYYY&RaceNo=N`

D1 表 `sectional_times`：PK `(meeting_date, venue, race_no, horse_code)`；`sec1`…`sec6` 为 `{pos,margin,time}`；`segments` 含后段可选 200m `splits`。

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/sectionals?date=2026-10-25&venue=ST&race_no=1" | jq .
```

```json
{
  "date": "2026-10-25",
  "venue": "ST",
  "race_no": 1,
  "sectionals": [
    {
      "horse_code": "M046",
      "horse_name": "HAPPY PEGASUS",
      "horse_no": 6,
      "finishing_order": 1,
      "finish_time": "1:08.41",
      "finish_time_sec": 68.41,
      "race_info": "Class 4 (Restricted) - 1200M - …",
      "sec1": { "pos": 4, "margin": "5", "time": 23.57 },
      "sec2": { "pos": 4, "margin": "8-1/4", "time": 22.15 },
      "sec3": { "pos": 1, "margin": "2", "time": 22.69 },
      "sec4": null,
      "sec5": null,
      "sec6": null,
      "segments": [
        { "idx": 1, "pos": 4, "margin": "5", "time": 23.57, "splits": null },
        { "idx": 2, "pos": 4, "margin": "8-1/4", "time": 22.15, "splits": [10.93, 11.22] },
        { "idx": 3, "pos": 1, "margin": "2", "time": 22.69, "splits": [11.14, 11.55] }
      ],
      "source_url": "https://racing.hkjc.com/en-us/local/information/displaysectionaltime?…",
      "content_hash": "…",
      "scraped_at": "2026-10-26T00:00:00.000Z"
    }
  ]
}
```

**采集触发**：赛后 `ingest`／hourly cron 在场次 `resultsComplete` 后挂鉤拉取（每场 1 请求，间隔 ≥3s，受 subrequest budget 与 `sectional_ingest_progress` 断点保护）。**不另建常驻爬虫**。

**Webhook**：内容 hash 变化时按 **会议批次** 推送 `event:"sectionals"`（`LIVE_PUSH_ENABLED` 门闩；`meta.race_nos` / `meta.content_hash`）。hash 未变不推。

**全量回填**（对齐 D1 已有 `races` 行，默认自 2015/16 季 `2015-09-01`）：

```bash
# 一步可续跑；limit_races 默认 20；delay_ms 下限 3000
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"from":"2015-09-01","limit_races":20,"delay_ms":3000}' \
  "$BASE/v1/admin/backfill-sectionals" | jq .
# 单日／单场
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"date":"2026-10-25","venue":"ST","force":false}' \
  "$BASE/v1/admin/backfill-sectionals" | jq .
```

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

### 3.8 事件账本回放（`hkjc-push/1.1`）

每个推送事件在 D1 `push_events` 存一份不可变正文（按会议单调 `seq`，非按订阅者）。

#### `GET /v1/events`

| 参数 | 必填 | 说明 |
|---|---|---|
| `meeting_date` | 是 | `YYYY-MM-DD` |
| `venue` | 是 | `ST` / `HV` |
| `since_seq` | 否 | 只返回 `seq > since_seq`（默认 `0`） |
| `limit` | 否 | 默认 100，最大 500 |
| `max_bytes` | 否 | 响应软上限，**默认与上限均为 1,200,000**（issue #38 A2）。累计超过则提前停（**至少返回 1 条**），设 `truncated_by_bytes=true`，并用 `next_since_seq` 继续翻页。**按未压缩原始 JSON 的 UTF-8 字节计**（gzip／br 之前的原始 body），与 runner 的 1.5MB／1.2MB 上限对齐。 |

**不改**事件正文、`seq` 语义与既有字段；仅新增 `max_bytes` / `next_since_seq` / `truncated_by_bytes` / `has_more`。

所有 `/v1/*` JSON 响应（含错误体）带 `Vary: Accept-Encoding`，避免缓存混用压缩／未压缩表示。

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/events?meeting_date=2026-10-07&venue=HV&since_seq=0&limit=500" | jq '{n:(.events|length), next:.next_since_seq, trunc:.truncated_by_bytes}'

# 下一页
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/events?meeting_date=2026-10-07&venue=HV&since_seq=$NEXT&limit=500" | jq .
```

#### `GET /v1/events/:event_id`

按 UUID 取单条完整信封。

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/events/550e8400-e29b-41d4-a716-446655440000" | jq .
```

---

### 3.9 马匹资料

GraphQL **无**伤患/往绩；档案详情来自官网 HTML（`html_horse` / `html_vet`）。会议树入库时会写入 `runners.horse_code`（GraphQL `horse.code`），并对 `horses` 表 `INSERT OR IGNORE` 占位行，因此 **`/v1/horses/H087` 在 HTML 未刷前也可命中**。完整档案由赛日 HTML 刷新覆盖。`horses` 主键为品牌号 `horse_code`；亦可用 `horse_id` 查询。

#### 回填既有 `runners.horse_code`（`POST /v1/admin/backfill-horse-codes`）

迁移 `0010` 后，历史 `runners` 的 `horse_code` 可能仍为 `null`：自动回填只挂在 `/v1/admin/ingest` 上；且许多会议的 `meetings.raw_json` 来自 **rbcMeeting**（白名单查询仅有 `runners.no/status`，**无** `horse.code`）。赛日轮询写入的 `odds_snapshots.runners[].runner_id` 通常已是品牌号（如 `H087`），是离线回填的主来源。

**身份规则：** 禁止仅按 `horse_no` 在 Declared+Standby 共用布号时赋值。优先按 `name_en` 匹配；仅当该布号在来源中唯一且目标行非 Standby 时才允许按 `horse_no` 回退。

若曾跑过错误的 `source=store` 回填（Standby 被打上 Declared 的 code），先清再填：

```bash
# 修复错误赋值：清除 Standby / 布号碰撞 / 名称不符，再按身份回填
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source":"store","reset_ambiguous":true,"limit_meetings":200}' \
  "$BASE/v1/admin/backfill-horse-codes" | jq .

# 或分两步
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"date":"2026-10-11","venue":"ST"}' \
  "$BASE/v1/admin/reset-ambiguous-horse-codes" | jq .
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source":"store","date":"2026-10-11","venue":"ST"}' \
  "$BASE/v1/admin/backfill-horse-codes" | jq .

# 仍缺时：限速重拉 raceMeetings FULL（计入 30k/日；HKJC 对过往日可能返回空）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source":"both","date":"2026-10-11","venue":"ST","limit_meetings":5,"hkjc_delay_ms":400}' \
  "$BASE/v1/admin/backfill-horse-codes" | jq .
```

回填后验证：

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/horses/resolve?date=2026-10-11&venue=ST&race_no=1&horse_no=1" | jq .
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/horses/resolve?date=2026-10-11&venue=ST&race_no=8&horse_no=2" | jq .
```

#### `GET /v1/horses/resolve`

按会议位置解析品牌号（纯 D1 读，无额外 HKJC 请求）：

| 参数 | 必填 |
|---|---|
| `date` / `venue` / `race_no` / `horse_no` | 是 |

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/horses/resolve?date=2026-10-07&venue=HV&race_no=1&horse_no=1" | jq .
```

```json
{
  "date": "2026-10-07",
  "venue": "HV",
  "race_no": 1,
  "horse_no": 1,
  "horse_code": "H087",
  "name_en": "CAN'T GO WONG",
  "name_ch": null
}
```

#### `GET /v1/horses/:code`

按品牌号（如 `H087`）或 `horse_id`（如 `HK_2022_H087`）查询。

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

### 3.10 管理接口（同样 Bearer）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/admin/ingest` | 拉取当前 GraphQL 赛事入库（并触发马匹页按策略刷新） |
| `POST` | `/v1/admin/backfill` | 回填一步；body 可选 `{"limit":5}` |
| `POST` | `/v1/admin/backfill-horse-codes` | 回填 `runners.horse_code`：`{"source":"store"\|"hkjc"\|"both","reset_ambiguous?","date?","venue?","limit_meetings?"}` |
| `POST` | `/v1/admin/reset-ambiguous-horse-codes` | 清除 Standby／布号碰撞／名称不符的错误 `horse_code`：`{"date?","venue?"}` |
| `POST` | `/v1/admin/backfill-sectionals` | 回填段速：`{"date?","venue?","from?","to?","limit_races?","delay_ms?","force?"}`（≥3s／请求；可续跑） |
| `POST` | `/v1/admin/test-push` | 推送 `event:"test"`（需有启用中的订阅者，或兜底 `PUSH_TARGET_URL`） |
| `GET` | `/v1/admin/subscribers` | 列出订阅者（**不返回 secret**，仅 `has_secret`） |
| `POST` | `/v1/admin/subscribers` | 新增：`{"url","secret?","enabled?","active_window?","window_before_sec?","quiet_start?","quiet_end?"}` |
| `PATCH` | `/v1/admin/subscribers/:id` | 更新 `url` / `secret` / `enabled` / `active_window` / `window_before_sec` / `quiet_start` / `quiet_end`（`secret` 或 quiet 字段传 `null`/`""` 清除） |
| `DELETE` | `/v1/admin/subscribers/:id` | 删除订阅者 |

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/admin/ingest" | jq .
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"limit":5}' "$BASE/v1/admin/backfill" | jq .
# 回填既有 runners.horse_code（优先 D1 内赔率快照 runner_id；无需 HKJC）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source":"store","limit_meetings":100}' "$BASE/v1/admin/backfill-horse-codes" | jq .
# 针对仍缺 code 的会议限速重拉 raceMeetings FULL（计入 30k/日；过往日可能空）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source":"hkjc","date":"2026-10-11","venue":"ST","limit_meetings":5}' \
  "$BASE/v1/admin/backfill-horse-codes" | jq .
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/admin/test-push" | jq .

# 订阅者管理
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/admin/subscribers" | jq .
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/hook","secret":"optional-hmac","enabled":true}' \
  "$BASE/v1/admin/subscribers" | jq .
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled":false}' "$BASE/v1/admin/subscribers/1" | jq .
# Manus-style race-day window (3h before first post → final dividends)
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"active_window":"raceday","window_before_sec":10800}' \
  "$BASE/v1/admin/subscribers/4" | jq .
# Clear quiet hours for a subscriber (e.g. id 2) — both null disables quiet
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"quiet_start":null,"quiet_end":null}' \
  "$BASE/v1/admin/subscribers/2" | jq .
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
      "active_window": "always",
      "window_before_sec": 10800,
      "quiet_start": "00:00",
      "quiet_end": "08:00",
      "created_at": "2026-10-08T00:00:00.000Z",
      "updated_at": "2026-10-08T00:00:00.000Z"
    },
    {
      "id": 4,
      "url": "https://api.manus.im/api/webhook/triggers/…",
      "enabled": true,
      "has_secret": true,
      "active_window": "raceday",
      "window_before_sec": 10800,
      "quiet_start": "00:00",
      "quiet_end": "08:00"
    }
  ]
}
```

#### 订阅者投递窗口（`active_window`）

| `active_window` | 行为 |
|---|---|
| `always`（默认） | 接收全部事件（含心跳 / off-window keepalive） |
| `raceday` | **仅**在该会议窗口内投递：`[first_post − window_before_sec, final_race dividends)` |

- `window_before_sec` 默认 **10800**（赛日前 3 小时）。窗口外：**不发送、不入队**（含 `no_update` / heartbeat）。
- 窗口首次打开时，对该订阅者先发一条完整 `odds_update` 会议快照（`meta.window_open_snapshot: true`），再发后续事件。
- 迁移 `0008_subscriber_active_window.sql` 将 **subscriber id=4**（Manus）设为 `raceday` / `10800`；其余保持 `always`。

#### 安静时段（`quiet_start` / `quiet_end`）

- 字段为 **Asia/Hong_Kong** 墙钟 `HH:MM`（半开区间 `[start, end)`）。两者皆非空才生效；任一为 `null` 则无安静时段。
- 迁移 `0009_subscriber_quiet_hours.sql` 为**所有现有订阅者**（含 id 2）写入默认 **`00:00`–`08:00`**。新建订阅者若不传字段则为 `null`/`null`（无安静时段）；可经 API 显式设置。
- 安静时段内：**不发送、不入队**（含 heartbeat / `no_update`）。D1 采集照常。
- **例外**：会议仍进行中（最终场派彩未发布）时继续推送，直至派彩落地（HV 夜赛过零点场景）。
- 安静结束后，若该订阅者曾被跳过且会议赔率内容相对上次推送有变化，则补发一条完整 `odds_update`（`meta.post_quiet_snapshot: true`）。
- 可用 PATCH 清除，例如 id 2：`{"quiet_start":null,"quiet_end":null}`。

---

## 4. Webhook 推送契约（`hkjc-push/1.1`）

完整 JSON Schema 见 [`docs/push-schema-1.1.md`](docs/push-schema-1.1.md)。相对 1.0 **加法兼容**：保留 `odds_update` 快照与既有 `races[]` 字段；新增信封字段、`odds_delta`、`no_update`、账本回放 API。

### 4.1 传输

- 向**每个启用中的订阅者**独立 `POST` **同一份**信封（同一 `event_id` / `seq` / body；互不影响）
- `Content-Type: application/json`
- `User-Agent: hkjc-data-worker/1.0`（Cloudflare 对空 UA 会报 1010，必须带）
- 若该订阅者配置了 secret：`X-Signature` = 对**原始 JSON body** 的 HMAC-SHA256 **小写 hex**（无 `sha256=` 前缀）
- 期望响应：`202`（或 2xx），body 建议 `{"received":true}`
- 迁移会 seed 两个接收方（仅 URL，密钥不进 git）：
  - `https://webhook.site/902a6166-6336-452d-97c5-e64018d97919`（无 HMAC）
  - `https://hkjc-agent.cf-connect.top/webhook`（若设置了 `PUSH_SECRET`，运行时写入该行 secret）
- **兜底**：仅当 `push_subscribers` **没有任何行**时，才使用 `PUSH_TARGET_URL`（+ 可选全局 `PUSH_SECRET`）

### 4.2 公共信封字段

| 字段 | 含义 |
|---|---|
| `schema` | 固定 `"hkjc-push/1.1"` |
| `event` | 事件类型 |
| `event_id` | UUID v4；每事件唯一；跨订阅者与重试相同 |
| `seq` | 按 `meeting_date`+`venue` 单调递增整数（无会议事件用全局 `*`）；**每事件 +1，非每订阅者** |
| `captured_at` | Worker 拉取源数据时刻，ISO-8601 `+08:00` |
| `sent_at` | 首次投递组包时刻（写入账本后不变），ISO `+08:00`；重试重发同一 body |
| `meeting_date` / `venue` | 会议键；部分事件可为 `null` |
| `source` | `{ name: "HKJC GraphQL", url, last_updated_at }`；`last_updated_at` **未知时显式 `null`，不可省略** |
| `quality` | `{ missing_source_time, post_start, late_ms }` |
| `races` | 既有快照结构（可空）；可含加法字段 `source_last_updated_at` |
| `meta` | 可选扩展 |

**赔率口径（odds basis）**：HKJC GraphQL `oddsValue` 为 decimal —— **每 $1 含本金总返还（HKD）**。常量：`HKD total return per $1 unit incl. stake`。不要把池总投注额当成单马金额。

**quality 标志**：

| 字段 | 含义 |
|---|---|
| `missing_source_time` | `source.last_updated_at === null`（pmPools `lastUpdateTime` 缺失） |
| `post_start` | 捕获时至少一场的 `post_time` 已过 |
| `late_ms` | `sent_at - captured_at`（毫秒） |

### 4.3 变更才推（hash diff）+ 节流推送 + 赛日感知心跳

1. 每次拉取都会尝试入库（D1 `odds_snapshots` 仍按 hash 去重写入）。
2. 对载荷做稳定 canonical JSON → SHA-256。
3. **与上一份 hash 相同**：不推赔率事件；仅在心跳窗口到期且本窗口内无其它推送时发 keepalive（见下）。
4. **hash 不同**：
   - **始终**推 `odds_delta`（`changes[]` 含 prev/new）；同会议在 `PUSH_COALESCE_MS`（默认 **2000**）内的多次观测合并为**一条** `odds_delta`，每条 change 保留自己的 `captured_at` / `seq` / `sample_interval_s`。
   - **不再**每次都推全量 `odds_update`。全量快照仅在：该场**首次**快照、**pool_status 变化**、或距上次全量 ≥ `PUSH_FULL_SNAPSHOT_INTERVAL_SEC`（默认 **300**）时推送。
5. **赛日高频窗口**（按会议）：从**第一场** `post_time` 前 `RACEDAY_WINDOW_BEFORE_SEC`（默认 **7200** = 2h）起，到**最后一场派彩（dividends）已入库**止。
   - **窗口内**：变更才推 + 2s coalesce；空闲 keepalive = `HEARTBEAT_INTERVAL_SEC`（默认 **300**）。若同期全量快照也到期，合并为**一次** `odds_update`（`meta.merged_heartbeat`），否则发 `no_update`。
   - **窗口外**（非赛日 / 赛日前 / 派彩后）：keepalive = `OFFDAY_HEARTBEAT_INTERVAL_SEC`（默认 **1800**），且**始终**与全量 `odds_update` 合并为一次推送（接收方每 30 分钟只需应答一次）。
6. 马匹类推送 **按会议批量**（`meta.horse_codes`），**绝不逐马刷屏**。

**3s 轮询下的量级（示意）**：原先约每小时 ~73×`odds_update` + ~72×`odds_delta`（变更双发）。节流后约 ~N×`odds_delta`（N≈变更 tick 数，3s>2s 时几乎不跨 tick 合并）+ 少量全量 `odds_update`（首场/状态变/≤每 5min）+ 赛日空闲 ≤12 次/小时 keepalive（或与到期快照合并）。窗口外约 2 次/小时合并快照。

### 4.4 `LIVE_PUSH_ENABLED` 门闩

| 事件 | 默认（`false`） | 说明 |
|---|---|---|
| `test` / `schedule` / `backfill_progress` / `whitelist_alert` / `source_blocked` / `source_recovered` / `odds_coverage_gap` | 仍可推 | 联调与告警 |
| `odds_update` / `odds_delta` / `no_update` / `lock` / `scratch` / `result` / `horse_update` / `injury_update` / `runs_update` / `dividends` / `changes` / `backlog_replay` | **跳过** | 确认 `test` 后再开 |

### 4.5 事件类型与完整 JSON 示例

#### `backlog_replay`（积压合并）

订阅者 `pending_pushes` 积压时由 flush/piggyback 生成（见 §4.6）。新 `event_id`/`seq`；`changes[]` 含全部中间赔率变更（每条带原 `seq`/`captured_at`）；`meta.covered_seq_from`/`covered_seq_to` 标明覆盖的原 seq 范围。细节见 [`docs/push-schema-1.1.md`](docs/push-schema-1.1.md)。

#### `odds_delta`（1.1 新增）

赔率变化时的主推送（全量 `odds_update` 仅按 §4.3 门控）。`changes[]` 每条 = 一匹马 × 一种彩种（`WIN`/`PLA`）；首次观测 `prev_odds` 为 `null`。合并窗口内发出的 `odds_delta` 会在每条 change 上带 `captured_at` / `seq` / `sample_interval_s`。`pools[].investment` 为**整池总投注额**（来自 `raceMeetings` 的 `poolInvs.investment`）；赔率白名单 query `QUERY_PM_POOLS_ODDS` **不含** `investment`，取不到时为 `null`（永不把池总额写成单马金额）。

```json
{
  "schema": "hkjc-push/1.1",
  "event": "odds_delta",
  "event_id": "550e8400-e29b-41d4-a716-446655440001",
  "seq": 12,
  "captured_at": "2026-10-07T19:04:28+08:00",
  "sent_at": "2026-10-07T19:04:30+08:00",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "source": {
    "name": "HKJC GraphQL",
    "url": "https://info.cld.hkjc.com/graphql/base/",
    "last_updated_at": "2026-10-07T19:04:28+08:00"
  },
  "quality": {
    "missing_source_time": false,
    "post_start": false,
    "late_ms": 2000
  },
  "races": [
    {
      "race_no": 3,
      "post_time": "2026-10-07T19:35:00+08:00",
      "snapshot_time": "2026-10-07T19:04:28+08:00",
      "pool_status": "START_SELL",
      "source_last_updated_at": "2026-10-07T19:04:28+08:00",
      "runners": [
        {
          "horse_no": 1,
          "horse_name": "EXAMPLE",
          "win_odds": 3.5,
          "place_odds": 1.7,
          "status": "Declared",
          "final_position": null
        }
      ]
    }
  ],
  "changes": [
    {
      "race_no": 3,
      "runner_no": 1,
      "horse_name_ch": "例子",
      "horse_name_en": "EXAMPLE",
      "bet_type": "WIN",
      "odds_basis": "HKD total return per $1 unit incl. stake",
      "prev_odds": 4.0,
      "new_odds": 3.5,
      "source_last_updated_at": "2026-10-07T19:04:28+08:00",
      "race_post_time": "2026-10-07T19:35:00+08:00",
      "pool_status": "START_SELL"
    },
    {
      "race_no": 3,
      "runner_no": 1,
      "horse_name_ch": "例子",
      "horse_name_en": "EXAMPLE",
      "bet_type": "PLA",
      "odds_basis": "HKD total return per $1 unit incl. stake",
      "prev_odds": 1.8,
      "new_odds": 1.7,
      "source_last_updated_at": "2026-10-07T19:04:28+08:00",
      "race_post_time": "2026-10-07T19:35:00+08:00",
      "pool_status": "START_SELL"
    }
  ],
  "pools": [
    { "race_no": 3, "bet_type": "WIN", "investment": 1234567 },
    { "race_no": 3, "bet_type": "PLA", "investment": 890123 }
  ]
}
```

#### `odds_update`（兼容快照，门控推送）

仅在首次快照 / `pool_status` 变化 / 每场至多每 `PUSH_FULL_SNAPSHOT_INTERVAL_SEC`，或作为赛日/非赛日 keepalive（可与心跳合并）时推送。信封形状不变：

```json
{
  "schema": "hkjc-push/1.1",
  "event": "odds_update",
  "event_id": "550e8400-e29b-41d4-a716-446655440002",
  "seq": 11,
  "captured_at": "2026-10-07T19:04:28+08:00",
  "sent_at": "2026-10-07T19:04:30+08:00",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "source": {
    "name": "HKJC GraphQL",
    "url": "https://info.cld.hkjc.com/graphql/base/",
    "last_updated_at": "2026-10-07T19:04:28+08:00"
  },
  "quality": { "missing_source_time": false, "post_start": false, "late_ms": 2000 },
  "races": [
    {
      "race_no": 3,
      "post_time": "2026-10-07T19:35:00+08:00",
      "snapshot_time": "2026-10-07T19:04:28+08:00",
      "pool_status": "START_SELL",
      "source_last_updated_at": "2026-10-07T19:04:28+08:00",
      "runners": [
        {
          "horse_no": 1,
          "horse_name": "EXAMPLE",
          "win_odds": 3.5,
          "place_odds": 1.7,
          "status": "Declared",
          "final_position": null
        }
      ]
    }
  ]
}
```

#### `no_update`（1.1 心跳）

赛日高频窗口内、无赔率变化且本心跳周期内无其它推送、且全量快照尚未到期时由 MeetingPoller 发出；`last_change_seq` / `last_change_at` 区分「无变化」与「漏收」。窗口外优先发合并后的 `odds_update` keepalive，而不是单独的 `no_update`。

```json
{
  "schema": "hkjc-push/1.1",
  "event": "no_update",
  "event_id": "550e8400-e29b-41d4-a716-446655440003",
  "seq": 13,
  "captured_at": "2026-10-07T19:05:00+08:00",
  "sent_at": "2026-10-07T19:05:00+08:00",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "source": {
    "name": "HKJC GraphQL",
    "url": "https://info.cld.hkjc.com/graphql/base/",
    "last_updated_at": "2026-10-07T19:04:28+08:00"
  },
  "quality": { "missing_source_time": false, "post_start": false, "late_ms": 0 },
  "races": [],
  "last_change_seq": 12,
  "last_change_at": "2026-10-07T19:04:28+08:00"
}
```

#### `lock` / `scratch` / `result`

`races[]` 同规格。`lock`：需 `STOP_SELL` + `post_time` 已过或 ≤15 分钟内 + 此前开售/当前有赔率；空壳不入库。`result`：参赛马 `finalPosition` 齐全。

```json
{
  "schema": "hkjc-push/1.1",
  "event": "lock",
  "event_id": "550e8400-e29b-41d4-a716-446655440004",
  "seq": 20,
  "captured_at": "2026-10-07T19:34:50+08:00",
  "sent_at": "2026-10-07T19:34:51+08:00",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "source": {
    "name": "HKJC GraphQL",
    "url": "https://info.cld.hkjc.com/graphql/base/",
    "last_updated_at": "2026-10-07T19:34:50+08:00"
  },
  "quality": { "missing_source_time": false, "post_start": false, "late_ms": 1000 },
  "races": [
    {
      "race_no": 3,
      "post_time": "2026-10-07T19:35:00+08:00",
      "snapshot_time": "2026-10-07T19:34:50+08:00",
      "pool_status": "STOP_SELL",
      "source_last_updated_at": "2026-10-07T19:34:50+08:00",
      "runners": [
        {
          "horse_no": 1,
          "horse_name": "EXAMPLE",
          "win_odds": 3.2,
          "place_odds": 1.6,
          "status": "Declared",
          "final_position": null
        }
      ]
    }
  ]
}
```

#### `dividends`

```json
{
  "schema": "hkjc-push/1.1",
  "event": "dividends",
  "event_id": "550e8400-e29b-41d4-a716-446655440005",
  "seq": 30,
  "captured_at": "2026-10-07T20:00:00+08:00",
  "sent_at": "2026-10-07T20:00:01+08:00",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "source": {
    "name": "HKJC GraphQL",
    "url": "https://info.cld.hkjc.com/graphql/base/",
    "last_updated_at": null
  },
  "quality": { "missing_source_time": true, "post_start": true, "late_ms": 1000 },
  "races": [],
  "meta": { "content_hash": "…", "pools": 18 }
}
```

完整派彩用 `/v1/results`；仅当非空派彩有意义内容变化时推送。

#### `changes`

```json
{
  "schema": "hkjc-push/1.1",
  "event": "changes",
  "event_id": "550e8400-e29b-41d4-a716-446655440006",
  "seq": 8,
  "captured_at": "2026-10-07T18:05:00+08:00",
  "sent_at": "2026-10-07T18:05:00+08:00",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "source": {
    "name": "HKJC GraphQL",
    "url": "https://info.cld.hkjc.com/graphql/base/",
    "last_updated_at": null
  },
  "quality": { "missing_source_time": true, "post_start": false, "late_ms": 0 },
  "races": [],
  "meta": { "new_events": 3, "content_hash": "…" }
}
```

#### `schedule`

```json
{
  "schema": "hkjc-push/1.1",
  "event": "schedule",
  "event_id": "550e8400-e29b-41d4-a716-446655440007",
  "seq": 1,
  "captured_at": "2026-10-08T10:00:00+08:00",
  "sent_at": "2026-10-08T10:00:00+08:00",
  "meeting_date": null,
  "venue": null,
  "source": {
    "name": "HKJC GraphQL",
    "url": "https://info.cld.hkjc.com/graphql/base/",
    "last_updated_at": null
  },
  "quality": { "missing_source_time": true, "post_start": false, "late_ms": 0 },
  "races": [],
  "meta": {
    "active": [
      { "date": "2026-10-07", "venue": "HV", "status": "CLOSED", "races": [] }
    ]
  }
}
```

#### `test`

```json
{
  "schema": "hkjc-push/1.1",
  "event": "test",
  "event_id": "550e8400-e29b-41d4-a716-446655440008",
  "seq": 1,
  "captured_at": "2026-10-08T12:00:00+08:00",
  "sent_at": "2026-10-08T12:00:00+08:00",
  "meeting_date": "2026-10-07",
  "venue": "HV",
  "source": {
    "name": "HKJC GraphQL",
    "url": "https://info.cld.hkjc.com/graphql/base/",
    "last_updated_at": "2026-10-07T18:43:31.223+08:00"
  },
  "quality": { "missing_source_time": false, "post_start": true, "late_ms": 0 },
  "races": [
    {
      "race_no": 1,
      "post_time": "2026-10-07T18:35:00+08:00",
      "snapshot_time": "2026-10-07T18:43:31.223+08:00",
      "pool_status": "STOP_SELL",
      "source_last_updated_at": "2026-10-07T18:43:31.223+08:00",
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

#### `horse_update` / `runs_update` / `injury_update` / `backfill_progress` / `whitelist_alert`

结构同前（现为 1.1 信封字段）；详情用 `/v1/horses/:code` 等查询。

### 4.6 失败重试与投递隔离

1. 事件先写入 `push_events`（不可变 body），再按订阅者扇出。  
2. **生产路径**：每个 `(event_id, subscriber_id)` 投递进入 Cloudflare Queue（`PUSH_QUEUE` → `hkjc-push-deliveries`），由 **独立 invocation** 消费，自带 subrequest 预算；队列重试退避 1m/5m/15m/30m/60m，body 始终从 `push_events` 重载。  
3. **无队列绑定**（本地 / 测试）：回退为进程内直推（行为与旧版一致）。  
4. 直推或队列耗尽后仍失败：写入 `pending_pushes`（含 `subscriber_id` + `event_id`）；legacy 退避 **1 → 5 → 15 分钟**，并可 piggy-back。  
5. **熔断**：连续失败 ≥ `CIRCUIT_BREAKER_THRESHOLD`（默认 10）或连续 429 ≥ `CIRCUIT_BREAKER_429_THRESHOLD`（默认 3）→ `open`（停发 HTTP，账本保留供 `/v1/events` 回放）；5 分钟后 `half_open` 探测，成功则 `closed`。**从不自动删除订阅者**。  
6. **Per-subscriber 速率限制**：每个订阅者最多 `PUSH_RATE_PER_SUB_PER_SEC`（默认 **2**）次 HTTP/秒。超额投递用队列 `delaySeconds`（或直推写入 `pending_pushes` 短延迟）**延后，绝不丢弃**——避免 webhook.site 等接收方在约 30–40 次突发后回 429。  
7. **Backlog 合并回放**：当某订阅者 `pending_pushes` 积压 ≥ `PUSH_BACKLOG_COALESCE_MIN`（默认 2）时（熔断恢复、宕机、legacy 积压等），**不再逐条重放**。按会议合并：
   - `odds_delta`：`changes[]` 按序拼接（保留每条变更自己的 `seq` / `captured_at` / prev/new odds），过大按 `PUSH_BACKLOG_MAX_CHANGES`（默认 200）切块 → 事件类型 `backlog_replay`（新 `event_id` + 新 `seq`；`meta.covered_seq_from` / `covered_seq_to` / `coalesced_event_ids`）
   - **按场次增量**（`lock` / `result` / `scratch` / `dividends`）：按 `(event, race_no)` 保留每场最新信封，**不丢场次**（同场多次只留最新；无法解析 `race_no` 时退回逐条重发）
   - **会议快照**（如 `odds_update` / `schedule` / `changes` / 马匹类）：同类型只留最新
   - 原始事件仍在账本，可用 `/v1/events` 按原 `event_id`/`seq` 查阅。  
8. Ingest / DO poll 各 stage（schedule、odds、dividends、horses、runs、injuries、pushes…）错误隔离；DO alarm 在 `finally` 中 **必定** 重排；小时 cron 兼 watchdog，发现 stale poller 则 `/start` 重武装。

### 4.7 可选 HMAC 校验（接收方伪代码）

```js
import crypto from "node:crypto";

function verify(reqBodyBuffer, signatureHex, secret) {
  const expected = crypto.createHmac("sha256", secret).update(reqBodyBuffer).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHex));
}

app.post("/hook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.get("X-Signature");
  if (process.env.PUSH_SECRET) {
    if (!sig || !verify(req.body, sig, process.env.PUSH_SECRET)) {
      return res.status(401).json({ error: "bad signature" });
    }
  }
  const envelope = JSON.parse(req.body.toString("utf8"));
  // envelope.schema === "hkjc-push/1.1"
  res.status(202).json({ received: true });
});
```

---

## 5. 数据表与可空字段

| 表 | 作用 |
|---|---|
| `meetings` / `races` / `runners` | 赛事树（`runners.horse_code` = HKJC 品牌号，可空） |
| `odds_snapshots` | 赔率快照（`raw_json` + `content_hash`）；仅 hash 变才新行 |
| `poll_ticks` | 每次轮询每场一行存在证明 `(meeting_date, venue, race_no, tick_time, changed)`；**不压实**（C1）；区分 STATIC 与 MISSING/COLLECTION_FAILURE（migration 0011 / R1b） |
| `results` | 名次、最终赔率、派彩 JSON |
| `change_events` | 退出/骑师变更等 |
| `push_subscribers` | Webhook 订阅者（url / secret / enabled / `active_window` / `window_before_sec` / `quiet_start` / `quiet_end`）；Admin API 管理 |
| `push_seq` | 每会议单调 `seq` + `last_change_seq`/`last_change_at` |
| `push_events` | 推送事件账本（每事件一份不可变 JSON） |
| `push_log` / `pending_pushes` | 推送审计与按订阅者重试队列（含 `event_id`） |
| `backfill_progress` / `worker_meta` | 回填断点与运行元数据 |
| `horses` | 马匹档案（HTML） |
| `horse_past_runs` | 往绩 |
| `horse_injuries` | 伤患/兽医记录 |
| `sectional_times` | 逐驹段速（migration **0013**；PK `meeting_date+venue+race_no+horse_code`；`sec1_json`…`sec6_json` + `segments_json`） |
| `sectional_ingest_progress` | 段速按场次回填／赛后采集断点（`done`/`empty`/`error`） |
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
| `API_TOKEN` | Secret | — | Bearer（查询 + Admin）；可逗号分隔多个 |
| `READ_API_TOKEN` | Secret 可选 | — | 只读 Bearer（仅 `GET /v1/*`）；可逗号分隔多个。issue #38 |
| `PUSH_SECRET` | Secret 可选 | — | 写入 agent 订阅者 secret（若该行尚无 secret）；兜底 URL 时也用于 HMAC |
| `POLL_INTERVAL_MS` | var | `3000` | 实时赔率轮询间隔（毫秒）：任一未完赛场次 WIN/PLA 开售中、或距开跑 ≤30 分钟时使用（clamp 1000–600000）。见 §11 |
| `DAILY_REQUEST_BUDGET` | var | `30000` | 每个 HKT 自然日 HKJC GraphQL 请求上限（含重试），接近时自动降频 3s→5s→10s→30s→60s，用尽后 300s |
| `POLL_INTERVAL_SEC` | var | — | **已废弃**，MeetingPoller 不再读取 |
| `BACKFILL_DAYS` | var | `60` | GraphQL 回填窗口 |
| `BACKFILL_SOURCE` | var | `graphql` | `graphql` / `off` |
| `TIMEZONE` | var | `Asia/Hong_Kong` | |
| `LIVE_PUSH_ENABLED` | var/secret | `false` | 实时/马匹/派彩等推送门闩 |
| `HORSE_REFRESH_BATCH` | var | `15` | 每次最多抓取的马匹 HTML 页数（可续跑） |
| `SUBREQUEST_BUDGET` | var | `45` | 单次 invocation 软 subrequest 上限；赔率/lock/result 优先，马匹页可 defer |
| `CIRCUIT_BREAKER_THRESHOLD` | var | `10` | 连续失败打开熔断 |
| `CIRCUIT_BREAKER_429_THRESHOLD` | var | `3` | 连续 429 打开熔断 |
| `CIRCUIT_HALF_OPEN_MS` | var | `300000` | open → half_open 探测间隔 |
| `PUSH_QUEUE_MAX_ATTEMPTS` | var | `5` | 队列投递最大尝试次数（之后进 `pending_pushes`） |
| `PUSH_RATE_PER_SUB_PER_SEC` | var | `2` | 每订阅者每秒最大 HTTP 投递数；超额 delay 不丢弃 |
| `PUSH_BACKLOG_COALESCE_MIN` | var | `2` | 每订阅者 pending 达到此数时合并为 `backlog_replay` |
| `PUSH_BACKLOG_MAX_CHANGES` | var | `200` | 单个 `backlog_replay` 最多包含的 odds change 行数 |
| `PUSH_FULL_SNAPSHOT_INTERVAL_SEC` | var | `300` | 每场全量 `odds_update` 最短间隔（另：首次 / pool_status 变） |
| `PUSH_COALESCE_MS` | var | `2000` | 同会议多次赔率变更合并为一条 `odds_delta` 的窗口 |
| `HEARTBEAT_INTERVAL_SEC` | var | `300` | 赛日高频窗口内空闲 keepalive 间隔 |
| `OFFDAY_HEARTBEAT_INTERVAL_SEC` | var | `1800` | 窗口外 / 非赛日 keepalive（与全量快照合并） |
| `RACEDAY_WINDOW_BEFORE_SEC` | var | `7200` | 高频窗口：第一场 post 前多少秒开启（至末场 dividends） |
| `POLLER_STALE_MS` | var | `600000` | cron watchdog 判定 MeetingPoller 过期并重武装 |

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

# 推送投递队列（每个 event×subscriber 独立 invocation）
npx wrangler queues create hkjc-push-deliveries
# 仓库模板 wrangler.toml 已含：
#   [[queues.producers]] binding = "PUSH_QUEUE"  queue = "hkjc-push-deliveries"
#   [[queues.consumers]] queue = "hkjc-push-deliveries"  max_batch_size = 1
# 生产 wrangler.toml 由部署方单独维护，请把上述 binding / queue 名同步进去。

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
# 可续跑回填（GraphQL rbc，~60 天窗）
curl -X POST "$BASE/v1/admin/backfill" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"limit":5}'

# 段速全量回填（对齐 D1 races；默认 from=2015-09-01；≥3s／场；可续跑）
curl -X POST "$BASE/v1/admin/backfill-sectionals" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"2015-09-01","limit_races":20,"delay_ms":3000}'

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

### 段速 HTML（issue #46）

- 逐驹段速：`https://racing.hkjc.com/en-us/local/information/displaysectionaltime?racedate=DD/MM/YYYY&RaceNo=N`（旧 `.aspx` 已停用；更早日期可能 302 → `/archive/…`）
- 赛后由既有 ingest／cron 挂鉤采集；全量用 `POST /v1/admin/backfill-sectionals`
- 限速 ≥3s／请求；断点表 `sectional_ingest_progress`

---

## 11. Polling & write budget

生产曾出现约 **~114k D1 rows written/day**、每 15 分钟约 **~2.5k queries**（约 07:45 HKT 起）。根因：MeetingPoller 每次 alarm 无条件 `persistMeetingTree`（会议/场次/马匹/成绩约 100+ 行）+ 每次写 `last_fetch_at`，而赔率本身很少变。

### 轮询档位（相对下一场 `post_time`）

| 距开跑 | 间隔 |
|---|---|
| > 24 小时 | **60 分钟** |
| 2 – 24 小时 | **5 分钟** |
| 30 分钟 – 2 小时 | **60 秒** |
| ≤ 30 分钟 | **`POLL_INTERVAL_MS`（默认 3s）** |
| 任一未完赛场次开售中（START_SELL/SELLING） | **`POLL_INTERVAL_MS`（默认 3s）**，不论距开跑多久 |
| 会议结束 / 全部有成绩 | **停止** alarm（cron 日后再启） |

### 实时轮询控制（3s）

有效间隔 = `max(赛程档位, 日预算节流, 封锁退避)`；下一次 alarm 以本次 tick **开始时间**为基准（不因处理耗时漂移），且至少 250ms 后。DO alarm 串行执行，不会重叠。

- **请求计数**：每次 GraphQL HTTP 尝试（含重试）计数，按 HKT 日存 DO storage，最多每 60s 累加刷入 D1 `graphql_usage`（migration 0007）。`/health.graphql_requests` = `{day, today, daily_budget, remaining}`（D1 已刷入值，最多滞后 60s）。仅统计 MeetingPoller；hourly cron / 回填的少量请求不计入。
- **日预算节流**：预测 `今日已用 + 剩余 tick × 2`（时间窗 = 最后一场 post_time + 30 分钟，封顶 HKT 午夜），取能落在 `DAILY_REQUEST_BUDGET` 内的最快档 3s→5s→10s→30s→60s；已用尽时 300s。
- **封锁退避**：403 / 429 / HTML challenge 页（`SourceBlockedError`，不重试）立即判为 blocked；普通网络/HTTP 错误连续 3 次也判为 blocked。退避 `base × 2^level`（6s→12s→24s→48s→60s 封顶）；每次健康 tick 降一级逐步恢复，降到 0 时恢复。状态写入 DO storage 与 `worker_meta.source_block_state`，`/health.source_block` 展示。进入/恢复时各推送一次 `source_blocked` / `source_recovered`（`meta.reason/since/backoff_ms`，不受 `LIVE_PUSH_ENABLED` 门控）。
- **`quality.sample_interval_s`**：每个推送 envelope 带上本次采样实际生效的轮询间隔（秒，=上一 tick 设定的有效间隔，如 3/5/10/60）；非轮询事件为 `null`。同时写入 `odds_snapshots.sample_interval_s`（不参与 content hash，去重语义不变）。
- **D1 读写削减**：`stage_ok_at_*` 每 stage 每 isolate 最多 60s 写一次；已 lock 的场次不再每 tick 查 `raceHadOpenOddsSnapshot`。

### D1 写入门闩

1. **Meeting tree hash 门控**（DO storage）：对规范化会议树算 content hash；仅 hash 变化时调用 `persistMeetingTree`。  
2. **Upsert 同值 no-op**：`ON CONFLICT DO UPDATE … WHERE … IS DISTINCT FROM …`，cron/回填路径也不会重写相同行。  
3. **`last_fetch_at`**：每次 poll 写入 DO storage；**最多每 5 分钟**刷到 D1（`/health` 仍读 D1）。  
4. **赔率快照**：仍用 `insertOddsSnapshotIfChanged`（hash 去重）；推送见 §4.3（`odds_delta` 为主，`odds_update` 门控；`lock`/`result` 每场一次）。
5. **`poll_ticks`（migration 0011 / R1b）**：每次成功拉取赔率后，**每场插入一行** `(tick_time, changed)`（不压实、不合併——C1）；计为 **essential/odds** 写入。不改动 `odds_snapshots` hash 去重（C2），不加 TTL（C3）。`/v1/odds/history?from=&to=` 可答 STATIC vs MISSING；缺口 >10 分钟 = `COLLECTION_FAILURE`。

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
