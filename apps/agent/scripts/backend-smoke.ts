/**
 * One-shot backend smoke: does the configured model backend initialize and
 * answer on this machine? Costs a few tokens. Usage:
 *   pnpm --filter @tac/agent exec tsx scripts/backend-smoke.ts
 * Respects TAC_AGENT_BACKEND / TAC_AGENT_MODEL. @tier T0
 */
import { createModelClient, resolveBackend } from "../src/model.js";

const backend = resolveBackend();
const client = createModelClient(backend);
console.log(`backend: ${backend}`);
console.log("available:", JSON.stringify(await client.available()));
const res = await client.complete({
  system: "Reply with exactly the single word OK and nothing else.",
  messages: [{ role: "user", content: "ping" }],
  tools: [],
  maxTokens: 8,
});
console.log("SMOKE_RESULT:", JSON.stringify(res.text.slice(0, 100)));
