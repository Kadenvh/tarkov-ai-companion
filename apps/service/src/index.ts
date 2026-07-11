// @tac/service — Fastify daemon: REST + WS (CONTRACTS §5), watcher host,
// plan pipeline, patch sentinel, agent proxy, web static host. Boot via
// `src/main.ts`; tests build the app with `buildApp()` and use inject().
export { buildApp, defaultWebDist, type BuildAppOptions } from "./app.js";
export {
  ProfileEntry,
  ServiceConfig,
  DEFAULT_PORT,
  DEFAULT_AGENT_PORT,
  defaultConfig,
  defaultDataDir,
  configPath,
  loadConfig,
  saveConfig,
  servicePort,
  resolveAgentUrl,
  watchDisabled,
} from "./config.js";
export { ServiceRuntime, UnknownProfileError, type RuntimeOptions } from "./runtime.js";
export { WsHub, ENGINE_EVENTS, type HubSocket } from "./ws.js";
export {
  PlanPipeline,
  buildPlanBundle,
  goalsOf,
  weightsOf,
  GoalSchema,
  WeightsSchema,
  DEFAULT_HORIZON,
  MAX_HORIZON,
  DEFAULT_GOALS,
  PLAN_DEBOUNCE_MS,
  type PlanBundle,
  type RaidForesight,
  type PlanPipelineOptions,
} from "./plan.js";
export { Metrics, type MetricsSnapshot } from "./metrics.js";
