import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";

/** Structural view of the ws socket @fastify/websocket hands us. */
interface WsSocket {
  send(data: string): void;
  on(event: "close", cb: () => void): void;
  terminate(): void;
}

/**
 * Tiny Fastify stub of the @tac/service REST+WS API (CONTRACTS §5) on an
 * ephemeral port. Canned responses mirror the REAL package shapes:
 * planner Plan (director.ts), AcquisitionPlan (§7), ExclusivityWarning
 * (foresight.ts), PlaystyleFingerprint + SurvivalByMapRow (insights).
 * Records writes (goals, notify) so tests can assert on them.
 * Never touches the network beyond 127.0.0.1. @tier T0
 */

export const STUB_STATE = {
  level: 15,
  xp: { estimate: 2250000, confidence: "calibrated" },
  prestige: 0,
  faction: "USEC",
  gameMode: "regular",
  progressEpoch: 1,
  tasks: { "task-debut": { complete: true, failed: false } },
  hideout: { "station-medstation": 1 },
  traders: { "trader-therapist": { level: 2, rep: 0.15 } },
};

export const STUB_PLAN = {
  raids: [
    {
      index: 1,
      map: "customs",
      tasks: [
        { id: "task-debut-2", name: "Background Check", anyMap: false, reasons: ["unlocks the Prapor chain"] },
        { id: "task-shoreline-prep", name: "Shortage", anyMap: false, reasons: ["kappa-required"] },
      ],
      levelBefore: 15,
      levelAfter: 16,
      score: 12.5,
      warnings: [],
    },
    {
      index: 2,
      map: "shoreline",
      tasks: [{ id: "task-spa-tour", name: "Spa Tour - Part 1", anyMap: false, reasons: ["opens Peacekeeper LL2"] }],
      levelBefore: 16,
      levelAfter: 16,
      score: 8,
      warnings: [],
    },
  ],
  freeTasksCompleted: [],
  goalTaskCount: 257,
  remainingGoalTasks: 240,
  levelStalls: [],
  reachedLevel: 17,
};

/** Live-service envelope for GET /api/plan (SPEC-4/apps-wave shape). */
export const STUB_PLAN_RESPONSE = {
  hash: "stub-plan-hash-1",
  builtAt: "2026-07-11T00:00:00.000Z",
  buildMs: 5,
  horizon: 10,
  goals: [{ type: "kappa" }],
  weights: { task: 1, xp: 0.15, criticality: 0.4, mapCost: {} },
  plan: STUB_PLAN,
};

export const STUB_QM = {
  raids: 5,
  items: [
    {
      itemId: "item-salewa",
      name: "Salewa first aid kit",
      count: 3,
      fir: true,
      forTasks: [{ id: "task-postman", name: "Shortage" }],
      route: { kind: "find-in-raid", detail: "Loot medical crates on Customs", raidIndex: 1 },
      alternatives: [],
      reasons: ["Shortage needs 3 found-in-raid Salewas"],
    },
    {
      itemId: "item-mp133",
      name: "MP-133 shotgun",
      count: 1,
      fir: false,
      forTasks: [{ id: "task-gunsmith-1", name: "Gunsmith - Part 1" }],
      route: { kind: "trader", detail: "Skier LL1 cash offer", unitCost: 24000, totalCost: 24000, traderGate: "Skier" },
      alternatives: [{ kind: "flea", detail: "flea market", unitCost: 31000, totalCost: 31000, levelGate: 15 }],
      reasons: ["Gunsmith - Part 1 base weapon"],
    },
  ],
  totalRubles: 24000,
  craftSchedule: [],
};

export const STUB_FORESIGHT = {
  warnings: [
    {
      kind: "task-exclusivity",
      completing: { id: "task-chemical-4", name: "Chemical - Part 4" },
      fails: [{ id: "task-big-customer", name: "Big Customer", kappaRequired: false, lightkeeperRequired: false }],
      severity: "warning",
    },
    {
      // M3.4b XP-gate stall shape (packages/planner foresight.ts XpGateStall).
      kind: "xp-gate",
      task: { id: "task-gunsmith-3", name: "Gunsmith - Part 3" },
      requiredLevel: 20,
      projectedLevel: 17,
      levelsShort: 3,
      raidsShort: 4,
      severity: "warning",
      message:
        "Route stalls at the Gunsmith - Part 3 L20 gate — projected L17 after the planned raids, ~3 levels / ~4 more raids short.",
    },
  ],
};

/** Per-source health (packages/sources SourceStatus): one up, one down. */
export const STUB_SOURCES_STATUS = [
  { id: "tarkov-dev-json", up: true, apiVersion: "1.2.3", cacheAgeSec: 42 },
  { id: "tarkovtracker", up: false, lastError: "no API token configured" },
  { id: "eft-wiki", up: true, cacheAgeSec: 300 },
];

/** Registered local connectors (service /api/connectors shape). */
export const STUB_CONNECTORS = [
  { id: "eft-config", vendor: "BSG", capabilities: ["game-config"], riskTier: "T1", health: "connected" },
  { id: "wootility", vendor: "Wooting", capabilities: ["game-config"], riskTier: "T2", health: "missing" },
  { id: "manual-capture", vendor: "tac", capabilities: ["manual-capture"], riskTier: "T0", health: "connected" },
];

export const STUB_STORY = {
  chapters: [
    { id: "ch-1", name: "Awakening", status: "complete" },
    { id: "ch-2", name: "The Lightkeeper", status: "in-progress" },
  ],
  endings: {
    possible: ["savior", "collaborator", "survivor"],
    locked: [],
    forced: null,
  },
};

export const STUB_GRAPH_SUMMARY = {
  totalTasks: 510,
  kappaRequired: 257,
  lightkeeperRequired: 102,
  kappaRemaining: 240,
  lightkeeperRemaining: 96,
};

export const STUB_FINGERPRINT = {
  features: {
    map_share_customs: 0.4,
    map_share_lighthouse: 0.3,
    survival_rate: 0.55,
    task_focus_ratio: 2.5,
  },
  explanations: {
    map_share_customs: "share of recent raids on Customs",
    map_share_lighthouse: "share of recent raids on Lighthouse",
    survival_rate: "survived / decided raids",
    task_focus_ratio: "quest events per raid",
  },
  sampleSizes: { raids: 20, decidedRaids: 16, questEvents: 50, sessions: 6 },
  lowConfidence: false,
};

export const STUB_INSIGHTS_RAIDS = {
  byMap: [
    { map: "customs", n: 8, survived: 6, died: 1, unknown: 1, survivalRate: 0.857, lowConfidence: false },
    { map: "lighthouse", n: 6, survived: 1, died: 4, unknown: 1, survivalRate: 0.2, lowConfidence: false },
  ],
};

export interface StubService {
  app: FastifyInstance;
  url: string;
  notifications: { title: string; body: string }[];
  goalsPosts: unknown[];
  planFetches: number;
  wsClients: Set<WsSocket>;
  broadcast(event: unknown): void;
  close(): Promise<void>;
}

export interface StubOptions {
  /** first POST /api/notify returns 500 (tests replan retry-ability) */
  failFirstNotify?: boolean;
}

export async function startStubService(opts: StubOptions = {}): Promise<StubService> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  const notifications: { title: string; body: string }[] = [];
  const goalsPosts: unknown[] = [];
  const wsClients = new Set<WsSocket>();
  const counters = { planFetches: 0, notifyFailuresLeft: opts.failFirstNotify ? 1 : 0 };
  let goals: unknown = { goals: [{ type: "kappa" }], weights: { task: 1, xp: 0.15, criticality: 0.4, mapCost: {} } };

  app.get("/api/health", async () => ({
    ok: true,
    version: "1.0.6",
    snapshotVersion: "1.0.6",
    profileKey: "main-regular",
    gameMode: "regular",
  }));
  app.get("/api/state", async () => STUB_STATE);
  app.get("/api/plan", async () => {
    counters.planFetches++;
    return STUB_PLAN_RESPONSE;
  });
  app.get("/api/quartermaster", async () => STUB_QM);
  app.get("/api/foresight", async () => STUB_FORESIGHT);
  app.get("/api/sources/status", async () => STUB_SOURCES_STATUS);
  app.get("/api/connectors", async () => STUB_CONNECTORS);
  app.get("/api/story", async () => STUB_STORY);
  app.get("/api/graph/summary", async () => STUB_GRAPH_SUMMARY);
  app.get("/api/goals", async () => goals);
  app.post("/api/goals", async (req) => {
    goalsPosts.push(req.body);
    goals = req.body;
    return { ok: true };
  });
  app.get("/api/insights/fingerprint", async () => STUB_FINGERPRINT);
  app.get("/api/insights/raids", async () => STUB_INSIGHTS_RAIDS);
  app.post("/api/notify", async (req, reply) => {
    if (counters.notifyFailuresLeft > 0) {
      counters.notifyFailuresLeft--;
      return reply.code(500).send({ error: "stub notify failure" });
    }
    notifications.push(req.body as { title: string; body: string });
    return { ok: true };
  });
  app.get("/ws", { websocket: true }, (socket) => {
    wsClients.add(socket);
    socket.on("close", () => wsClients.delete(socket));
    socket.send(JSON.stringify({ type: "hello", payload: { profileKey: "main-regular" }, ts: new Date().toISOString() }));
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("stub service: no ephemeral port assigned");

  const stub: StubService = {
    app,
    url: `http://127.0.0.1:${address.port}`,
    notifications,
    goalsPosts,
    get planFetches() {
      return counters.planFetches;
    },
    wsClients,
    broadcast(event: unknown) {
      const raw = JSON.stringify(event);
      for (const client of wsClients) client.send(raw);
    },
    async close() {
      for (const client of wsClients) client.terminate();
      await app.close();
    },
  };
  return stub;
}

/** Poll until `cond` is true (test helper; 5 ms tick, throws after timeout). */
export async function waitFor(cond: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
