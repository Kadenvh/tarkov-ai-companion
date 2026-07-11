import { describe, expect, it } from "vitest";
import { ApiError, buildUrl, createClient, type FetchLike } from "../src/api/client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("buildUrl", () => {
  it("appends query params and drops undefined values", () => {
    expect(buildUrl("/api/plan", { horizon: 10, raids: undefined })).toBe("/api/plan?horizon=10");
  });

  it("returns the bare path when there is no query", () => {
    expect(buildUrl("/api/health")).toBe("/api/health");
    expect(buildUrl("/api/health", {})).toBe("/api/health");
  });

  it("prefixes the base and stringifies values", () => {
    expect(buildUrl("/api/environment/ammo", { caliber: "5.45x39" }, "http://localhost:3141")).toBe(
      "http://localhost:3141/api/environment/ammo?caliber=5.45x39",
    );
  });
});

describe("createClient", () => {
  it("returns parsed JSON on success", async () => {
    const fetchFn: FetchLike = async () => jsonResponse(200, { ok: true });
    const client = createClient({ fetchFn });
    await expect(client.get("/api/health")).resolves.toEqual({ ok: true });
  });

  it("maps { error } bodies to the ApiError message with status", async () => {
    const fetchFn: FetchLike = async () => jsonResponse(409, { error: "game running" });
    const client = createClient({ fetchFn });
    const err = (await client
      .post("/api/environment/settings/apply", { profile: "max-fps" })
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.message).toBe("game running");
    expect(err.isConflict).toBe(true);
  });

  it("keeps the status line for non-JSON error bodies", async () => {
    const fetchFn: FetchLike = async () =>
      new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" });
    const client = createClient({ fetchFn });
    const err = (await client.get("/api/plan").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.message).toBe("502 Bad Gateway");
  });

  it("maps thrown fetch (service down) to status 0 / isNetwork", async () => {
    const fetchFn: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const client = createClient({ fetchFn });
    const err = (await client.get("/api/health").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.isNetwork).toBe(true);
    expect(err.message).toMatch(/3141/);
  });

  it("invokes the onError hook exactly once per failure (toast hook)", async () => {
    const seen: ApiError[] = [];
    const fetchFn: FetchLike = async () => jsonResponse(500, { error: "boom" });
    const client = createClient({ fetchFn, onError: (e) => seen.push(e) });
    await client.get("/api/state").catch(() => undefined);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toBe("boom");
  });

  it("POSTs a JSON body with the content-type header", async () => {
    let captured: RequestInit | undefined;
    const fetchFn: FetchLike = async (_input, init) => {
      captured = init;
      return jsonResponse(200, {});
    };
    const client = createClient({ fetchFn });
    await client.post("/api/goals", { goals: [{ type: "kappa" }] });
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBe(JSON.stringify({ goals: [{ type: "kappa" }] }));
    expect((captured?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
});
