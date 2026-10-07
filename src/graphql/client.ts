import { GRAPHQL_ENDPOINT } from "./queries";
import type { GraphQLResponse } from "./types";

export class WhitelistError extends Error {
  constructor(message = "WHITELIST_ERROR") {
    super(message);
    this.name = "WhitelistError";
  }
}

export interface FetchGraphQLOptions {
  query: string;
  variables?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  retries?: number;
}

export async function fetchGraphQL<T>(
  options: FetchGraphQLOptions,
): Promise<GraphQLResponse<T>> {
  const { query, variables = {}, fetchImpl = fetch, retries = 3 } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
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

      if (!res.ok) {
        throw new Error(`GraphQL HTTP ${res.status}`);
      }

      const json = (await res.json()) as GraphQLResponse<T>;
      const messages = (json.errors ?? []).map((e) => e.message).join("; ");
      if (messages.includes("WHITELIST_ERROR")) {
        throw new WhitelistError(messages);
      }
      return json;
    } catch (err) {
      lastError = err;
      if (err instanceof WhitelistError) throw err;
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
