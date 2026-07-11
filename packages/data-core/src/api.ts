import { setTimeout as sleep } from "node:timers/promises";

const BASE = "https://json.tarkov.dev";
const UA = "tarkov-ai-companion/0.1 (local companion; contact: repo owner)";

/** Endpoints per game mode. `translated` ones also have a `<name>_<lang>` string table. */
export const ENDPOINTS = [
  { name: "tasks", translated: true },
  { name: "items", translated: true },
  { name: "maps", translated: true },
  { name: "hideout", translated: true },
  { name: "traders", translated: true },
  { name: "barters", translated: false },
  { name: "crafts", translated: false },
] as const;

export type EndpointName = (typeof ENDPOINTS)[number]["name"];

/**
 * Fetch a json.tarkov.dev path with retry. The upstream is Cloudflare-cached
 * (5-min TTL) and occasionally sheds bursts — be polite, retry with backoff.
 */
export async function fetchJson(path: string, attempts = 4): Promise<unknown> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
      const body = (await res.json()) as { data?: unknown; error?: string };
      if (body.error) throw new Error(`API error for ${path}: ${body.error}`);
      if (body.data === undefined) throw new Error(`No data field for ${path}`);
      return body.data;
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await sleep(2000 * (i + 1));
    }
  }
  throw lastError;
}
