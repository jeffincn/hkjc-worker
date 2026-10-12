import type { Env } from "../env";
import { envNum } from "../env";
import { setMeta } from "../store/db";
import {
  allowDeliveryAttempt,
  circuitHalfOpenMs,
  getCircuitSnapshot,
} from "./circuit";
import {
  deliverOne,
  deliverToTarget,
  type ResolvedTarget,
  type SubscriberDelivery,
} from "./delivery";
import type { PushEnvelope } from "./envelope";
import { requireEventId } from "./event-id";
import { getPushEventById } from "./ledger";
import { enqueueRetry } from "./pending";
import { getSubscriber } from "./subscribers";

/** Queue message: one (event, subscriber) delivery unit. */
export interface PushDeliveryMessage {
  event_id: string;
  subscriber_id: number | null;
  /** 0-based attempt; used for retry backoff delay. */
  attempt: number;
}

const QUEUE_BACKOFF_SECONDS = [60, 300, 900, 1800, 3600];

export function hasPushQueue(env: Env): boolean {
  return !!env.PUSH_QUEUE && typeof (env.PUSH_QUEUE as Queue).send === "function";
}

export function queueRetryDelaySeconds(attempt: number): number {
  return QUEUE_BACKOFF_SECONDS[Math.min(attempt, QUEUE_BACKOFF_SECONDS.length - 1)]!;
}

/**
 * Enqueue one delivery per subscriber (or send directly when queue unbound).
 * Returns per-target outcomes; queue path marks success when enqueue succeeds.
 * Direct path uses the in-memory envelope (same event_id/body as ledger).
 */
export async function enqueueDeliveries(
  env: Env,
  envelope: PushEnvelope,
  targets: ResolvedTarget[],
  opts?: {
    fetchImpl?: typeof fetch;
    /** Direct-send only (tests / no queue). */
    forceDirect?: boolean;
  },
): Promise<SubscriberDelivery[]> {
  const eventId = requireEventId(envelope);
  const useQueue = !opts?.forceDirect && hasPushQueue(env);
  const out: SubscriberDelivery[] = [];
  const body = JSON.stringify(envelope);
  const fetchImpl = opts?.fetchImpl ?? fetch;

  for (const target of targets) {
    const gate = await allowDeliveryAttempt(env, target.subscriber_id);
    if (!gate.allowed) {
      out.push({
        subscriber_id: target.subscriber_id,
        url: target.url,
        http_status: null,
        success: false,
        error_message: `skipped: circuit ${gate.state}`,
        signed: !!(target.secret && target.secret.length > 0),
        skipped_circuit: true,
      });
      continue;
    }

    if (useQueue) {
      try {
        await env.PUSH_QUEUE!.send({
          event_id: eventId,
          subscriber_id: target.subscriber_id,
          attempt: 0,
        } satisfies PushDeliveryMessage);
        await bumpQueueBacklog(env, 1);
        out.push({
          subscriber_id: target.subscriber_id,
          url: target.url,
          http_status: null,
          success: true,
          signed: !!(target.secret && target.secret.length > 0),
          queued: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const delivery = await deliverToTarget(env, envelope, body, target, fetchImpl);
        if (!delivery.success) {
          await enqueueRetry(
            env,
            envelope,
            0,
            delivery.error_message ?? `queue send failed: ${msg}`,
            target.subscriber_id,
          );
        }
        out.push({
          ...delivery,
          error_message: delivery.error_message ?? `queue send failed: ${msg}`,
        });
      }
    } else {
      const delivery = await deliverToTarget(env, envelope, body, target, fetchImpl);
      if (!delivery.success && !delivery.skipped_circuit) {
        await enqueueRetry(
          env,
          envelope,
          0,
          delivery.error_message ?? "HTTP delivery failed",
          target.subscriber_id,
        );
      }
      out.push(delivery);
    }
  }

  return out;
}

/** Process a single queue message (own invocation / own subrequest budget). */
export async function processDeliveryMessage(
  env: Env,
  msg: PushDeliveryMessage,
  opts?: { fetchImpl?: typeof fetch },
): Promise<{ ack: boolean; retryDelaySeconds?: number; nextAttempt?: number }> {
  const envelope = await getPushEventById(env, msg.event_id);
  if (!envelope) {
    console.error("push queue: event_id not in ledger", msg.event_id);
    await bumpQueueBacklog(env, -1);
    return { ack: true };
  }

  const gate = await allowDeliveryAttempt(env, msg.subscriber_id);
  if (!gate.allowed) {
    const snap = await getCircuitSnapshot(env, msg.subscriber_id);
    const openedAt = snap.circuit_opened_at ? Date.parse(snap.circuit_opened_at) : Date.now();
    const remainingMs = Math.max(
      60_000,
      circuitHalfOpenMs(env) - (Date.now() - openedAt),
    );
    return { ack: false, retryDelaySeconds: Math.ceil(remainingMs / 1000) };
  }

  let target: ResolvedTarget | null = null;
  if (msg.subscriber_id != null) {
    const sub = await getSubscriber(env, msg.subscriber_id);
    if (!sub || !sub.enabled) {
      await bumpQueueBacklog(env, -1);
      return { ack: true };
    }
    target = { subscriber_id: sub.id, url: sub.url, secret: sub.secret };
  } else {
    const fallback = env.PUSH_TARGET_URL?.trim();
    if (!fallback) {
      await bumpQueueBacklog(env, -1);
      return { ack: true };
    }
    target = {
      subscriber_id: null,
      url: fallback,
      secret: env.PUSH_SECRET?.trim() || null,
    };
  }

  const delivery = await deliverOne(env, msg.event_id, target, opts?.fetchImpl ?? fetch);

  if (delivery.success) {
    await bumpQueueBacklog(env, -1);
    return { ack: true };
  }

  const maxAttempts = Math.max(1, envNum(env, "PUSH_QUEUE_MAX_ATTEMPTS", 5));
  const nextAttempt = (msg.attempt ?? 0) + 1;
  if (nextAttempt >= maxAttempts) {
    await enqueueRetry(
      env,
      envelope,
      nextAttempt,
      delivery.error_message ?? "queue delivery failed",
      msg.subscriber_id,
    );
    await bumpQueueBacklog(env, -1);
    return { ack: true };
  }

  return {
    ack: false,
    retryDelaySeconds: queueRetryDelaySeconds(msg.attempt ?? 0),
    nextAttempt,
  };
}

async function bumpQueueBacklog(env: Env, delta: number): Promise<void> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM worker_meta WHERE key=?`)
      .bind("push_queue_backlog")
      .first<{ value: string }>();
    const cur = Math.max(0, Number(row?.value ?? 0) || 0);
    const next = Math.max(0, cur + delta);
    await setMeta(env.DB, "push_queue_backlog", String(next));
  } catch {
    // non-fatal
  }
}

export async function getQueueBacklog(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT value FROM worker_meta WHERE key=?`)
    .bind("push_queue_backlog")
    .first<{ value: string }>();
  return Math.max(0, Number(row?.value ?? 0) || 0);
}

/** Cloudflare Queues consumer entry — one message ≈ one delivery. */
export async function handlePushQueueBatch(
  batch: MessageBatch<PushDeliveryMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const body = message.body;
      const result = await processDeliveryMessage(env, {
        event_id: body.event_id,
        subscriber_id: body.subscriber_id ?? null,
        attempt: body.attempt ?? 0,
      });
      if (result.ack) {
        message.ack();
      } else if (typeof message.retry === "function") {
        // Native retry keeps the same body; bump attempt via re-send when possible.
        if (result.nextAttempt != null && hasPushQueue(env)) {
          await env.PUSH_QUEUE!.send({
            event_id: body.event_id,
            subscriber_id: body.subscriber_id ?? null,
            attempt: result.nextAttempt,
          });
          message.ack();
          // backlog already counted; re-send is same logical message
        } else {
          message.retry({ delaySeconds: result.retryDelaySeconds ?? 60 });
        }
      } else {
        if (hasPushQueue(env)) {
          await env.PUSH_QUEUE!.send({
            event_id: body.event_id,
            subscriber_id: body.subscriber_id ?? null,
            attempt: result.nextAttempt ?? (body.attempt ?? 0) + 1,
          });
        }
        message.ack();
      }
    } catch (err) {
      console.error("push queue consumer error", err);
      message.retry();
    }
  }
}
