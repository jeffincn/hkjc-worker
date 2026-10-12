# hkjc-push/1.1 JSON Schema

Additive, backward-compatible evolution of `hkjc-push/1.0`.

- Keeps `odds_update` snapshot events and existing `races[]` fields.
- Adds envelope identity/ordering (`event_id`, `seq`), capture/send times, `source`, `quality`.
- Adds `odds_delta` and `no_update` events.
- Full event bodies are stored once in D1 `push_events` and replayable via `GET /v1/events`.

## Odds basis

HKJC GraphQL `oddsNodes.oddsValue` for WIN/PLA is a **decimal multiplier**:

> **HKD total return per $1 unit incl. stake**

Example: `4.0` means a $1 WIN stake returns $4 total (profit $3). This is **not** a per-$10 tote dividend board figure, and **not** pool investment.

Pool turnover (when available) is exposed only on `pools[].investment` as the **entire pool** total from `raceMeetings.poolInvs.investment`. The odds whitelist query (`QUERY_PM_POOLS_ODDS`) does not select `investment`; when unavailable the field is `null`. Never treat pool total as per-horse money.

## Time fields

| Field | Meaning |
|---|---|
| `captured_at` | When the worker fetched source data (Asia/Hong_Kong, `+08:00`) |
| `sent_at` | When the immutable envelope was first assembled for delivery (`+08:00`). Retries resend the same body. |
| `source.last_updated_at` | Best-effort `pmPools.lastUpdateTime` (or max across races). **Explicit `null` when unknown — never omit.** |
| `races[].source_last_updated_at` | Per-race pool last update (additive on snapshots) |
| `quality.late_ms` | `sent_at - captured_at` in milliseconds |
| `quality.missing_source_time` | `true` iff `source.last_updated_at` is `null` |
| `quality.post_start` | `true` if any race `post_time` was already past at `captured_at` |

## JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://hkjc.cf-connect.top/schemas/hkjc-push-1.1.json",
  "title": "hkjc-push/1.1",
  "type": "object",
  "required": [
    "schema",
    "event",
    "event_id",
    "seq",
    "captured_at",
    "sent_at",
    "meeting_date",
    "venue",
    "source",
    "quality",
    "races"
  ],
  "properties": {
    "schema": { "const": "hkjc-push/1.1" },
    "event": {
      "type": "string",
      "enum": [
        "test",
        "schedule",
        "odds_update",
        "odds_delta",
        "no_update",
        "lock",
        "scratch",
        "result",
        "backfill_progress",
        "whitelist_alert",
        "horse_update",
        "injury_update",
        "runs_update",
        "dividends",
        "changes"
      ]
    },
    "event_id": {
      "type": "string",
      "format": "uuid",
      "description": "UUID v4; unique per event; identical across subscribers and retries"
    },
    "seq": {
      "type": "integer",
      "minimum": 1,
      "description": "Monotonic per meeting_date+venue (global * for null meeting)"
    },
    "captured_at": {
      "type": "string",
      "pattern": ".+[+]08:00$"
    },
    "sent_at": {
      "type": "string",
      "pattern": ".+[+]08:00$"
    },
    "meeting_date": {
      "type": ["string", "null"],
      "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
    },
    "venue": {
      "type": ["string", "null"],
      "enum": ["ST", "HV", null]
    },
    "source": {
      "type": "object",
      "required": ["name", "url", "last_updated_at"],
      "additionalProperties": false,
      "properties": {
        "name": { "const": "HKJC GraphQL" },
        "url": { "type": "string", "format": "uri" },
        "last_updated_at": {
          "type": ["string", "null"],
          "description": "Explicit null when unknown"
        }
      }
    },
    "quality": {
      "type": "object",
      "required": ["missing_source_time", "post_start", "late_ms"],
      "additionalProperties": false,
      "properties": {
        "missing_source_time": { "type": "boolean" },
        "post_start": { "type": "boolean" },
        "late_ms": { "type": "integer", "minimum": 0 }
      }
    },
    "races": {
      "type": "array",
      "items": { "$ref": "#/$defs/race" }
    },
    "changes": {
      "type": "array",
      "description": "Present on odds_delta",
      "items": { "$ref": "#/$defs/oddsDeltaChange" }
    },
    "pools": {
      "type": "array",
      "description": "Present on odds_delta; pool total turnover only",
      "items": { "$ref": "#/$defs/poolInvestment" }
    },
    "last_change_seq": {
      "type": ["integer", "null"],
      "description": "Present on no_update"
    },
    "last_change_at": {
      "type": ["string", "null"],
      "description": "Present on no_update"
    },
    "meta": {
      "type": "object",
      "additionalProperties": true
    }
  },
  "allOf": [
    {
      "if": { "properties": { "event": { "const": "odds_delta" } } },
      "then": { "required": ["changes", "pools"] }
    },
    {
      "if": { "properties": { "event": { "const": "no_update" } } },
      "then": { "required": ["last_change_seq", "last_change_at"] }
    }
  ],
  "$defs": {
    "runner": {
      "type": "object",
      "required": [
        "horse_no",
        "horse_name",
        "win_odds",
        "place_odds",
        "status",
        "final_position"
      ],
      "properties": {
        "horse_no": { "type": "integer" },
        "horse_name": { "type": ["string", "null"] },
        "horse_name_ch": { "type": ["string", "null"] },
        "win_odds": { "type": ["number", "null"] },
        "place_odds": { "type": ["number", "null"] },
        "status": { "type": ["string", "null"] },
        "final_position": { "type": ["integer", "null"] }
      }
    },
    "race": {
      "type": "object",
      "required": [
        "race_no",
        "post_time",
        "snapshot_time",
        "pool_status",
        "runners"
      ],
      "properties": {
        "race_no": { "type": "integer" },
        "post_time": { "type": ["string", "null"] },
        "snapshot_time": { "type": "string" },
        "pool_status": { "type": ["string", "null"] },
        "source_last_updated_at": { "type": ["string", "null"] },
        "runners": {
          "type": "array",
          "items": { "$ref": "#/$defs/runner" }
        }
      }
    },
    "oddsDeltaChange": {
      "type": "object",
      "required": [
        "race_no",
        "runner_no",
        "horse_name_ch",
        "horse_name_en",
        "bet_type",
        "odds_basis",
        "prev_odds",
        "new_odds",
        "source_last_updated_at",
        "race_post_time",
        "pool_status"
      ],
      "additionalProperties": false,
      "properties": {
        "race_no": { "type": "integer" },
        "runner_no": { "type": "integer" },
        "horse_name_ch": { "type": ["string", "null"] },
        "horse_name_en": { "type": ["string", "null"] },
        "bet_type": { "type": "string", "enum": ["WIN", "PLA"] },
        "odds_basis": {
          "const": "HKD total return per $1 unit incl. stake"
        },
        "prev_odds": {
          "type": ["number", "null"],
          "description": "null on first observation"
        },
        "new_odds": { "type": ["number", "null"] },
        "source_last_updated_at": { "type": ["string", "null"] },
        "race_post_time": { "type": ["string", "null"] },
        "pool_status": { "type": ["string", "null"] }
      }
    },
    "poolInvestment": {
      "type": "object",
      "required": ["race_no", "bet_type", "investment"],
      "additionalProperties": false,
      "properties": {
        "race_no": { "type": "integer" },
        "bet_type": { "type": "string", "enum": ["WIN", "PLA"] },
        "investment": {
          "type": ["number", "null"],
          "description": "Pool total turnover (HKD); null if not in whitelist payload"
        }
      }
    }
  }
}
```

## Replay API

Bearer-auth:

```http
GET /v1/events?meeting_date=YYYY-MM-DD&venue=ST|HV&since_seq=0&limit=100
GET /v1/events/:event_id
```

Response bodies contain the stored envelope objects (`payload_json` as parsed JSON).

## Event ledger table

```sql
CREATE TABLE push_events (
  event_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  meeting_date TEXT,
  venue TEXT,
  event_type TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source_last_updated_at TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```
