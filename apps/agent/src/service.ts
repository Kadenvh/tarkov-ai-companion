/**
 * Thin HTTP client for the @tac/service REST API (CONTRACTS §5).
 * All game facts the agent ever states flow through this client — it is the
 * single seam the tests replace with a stub Fastify instance.
 * @tier T0
 */

export const DEFAULT_SERVICE_URL = "http://localhost:3141";

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`service ${path} -> ${status}: ${message}`);
    this.name = "ServiceError";
  }
}

export class ServiceClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl?: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = (baseUrl ?? process.env["TAC_SERVICE_URL"] ?? DEFAULT_SERVICE_URL).replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  /** WebSocket URL for the CONTRACTS §5.3 event stream. */
  get wsUrl(): string {
    return this.baseUrl.replace(/^http/, "ws") + "/ws";
  }

  async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(this.baseUrl + path);
    const body = await res.text();
    if (!res.ok) throw new ServiceError(res.status, path, body.slice(0, 300));
    return body ? JSON.parse(body) : null;
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new ServiceError(res.status, path, text.slice(0, 300));
    return text ? JSON.parse(text) : null;
  }

  /** True when GET /api/health answers 2xx. Never throws. */
  async reachable(): Promise<boolean> {
    try {
      await this.get("/api/health");
      return true;
    } catch {
      return false;
    }
  }
}
