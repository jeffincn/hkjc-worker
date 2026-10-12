import { GRAPHQL_ENDPOINT } from "./queries";
import type { GraphQLResponse } from "./types";

export class WhitelistError extends Error {
  constructor(message = "WHITELIST_ERROR") {
    super(message);
    this.name = "WhitelistError";
  }
}

export type SourceBlockKind = "http_403" | "http_429" | "challenge";

/** HKJC edge refused us (403/429) or served a challenge/HTML page instead of JSON. */
export class SourceBlockedError extends Error {
  readonly kind: SourceBlockKind;
  readonly status: number;
  constructor(kind: SourceBlockKind, status: number, message?: string) {
    super(message ?? `SOURCE_BLOCKED ${kind} (HTTP ${status})`);
    this.name = "SourceBlockedError";
    this.kind = kind;
    this.status = status;
  }
}

export function looksLikeChallenge(contentType: string | null, body: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  const head = body.trimStart().slice(0, 512).toLowerCase();
  if (ct.includes("text/html")) return true;
  if (head.startsWith("<")) return true;
  return /captcha|challenge|access denied|request rejected|cf-chl/.test(head);
}

export interface FetchGraphQLOptions {
  query: string;
  variables?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  retries?: number;
  /** Called once per HTTP attempt (incl. retries) for request accounting. */
  onAttempt?: () => void;
}

export async function fetchGraphQL<T>(
  options: FetchGraphQLOptions,
): Promise<GraphQLResponse<T>> {
  const { query, variables = {}, fetchImpl = fetch, retries = 3, onAttempt } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      onAttempt?.();
      const res = await fetchImpl(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://bet.hkjc.com",
          Referer: "https://bet.hkjc.com/",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 403) throw new SourceBlockedError("http_403", 403);
      if (res.status === 429) throw new SourceBlockedError("http_429", 429);
      const text = await res.text();
      if (!res.ok) {
        if (looksLikeChallenge(res.headers.get("content-type"), text)) {
          throw new SourceBlockedError("challenge", res.status);
        }
        throw new Error(`GraphQL HTTP ${res.status}`);
      }
      let json: GraphQLResponse<T>;
      try {
        json = JSON.parse(text) as GraphQLResponse<T>;
      } catch {
        if (looksLikeChallenge(res.headers.get("content-type"), text)) {
          throw new SourceBlockedError("challenge", res.status);
        }
        throw new Error("GraphQL invalid JSON");
      }
      const messages = (json.errors ?? []).map((e) => e.message).join("; ");
      if (messages.includes("WHITELIST_ERROR")) {
        throw new WhitelistError(messages);
      }
      return json;
    } catch (err) {
      lastError = err;
      // Never hammer a blocking edge with retries.
      if (err instanceof WhitelistError || err instanceof SourceBlockedError) throw err;
      if (attempt < retries) {
        await sleep(250 * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
