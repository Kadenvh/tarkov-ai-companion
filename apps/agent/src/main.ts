import { buildServer } from "./server.js";
import { ServiceClient } from "./service.js";
import { createModelClient, resolveBackend } from "./model.js";
import { ReplanPipeline } from "./replan.js";

/**
 * @tac/agent entrypoint. Port 3142 (TAC_AGENT_PORT), service at
 * TAC_SERVICE_URL (default http://localhost:3141). Set TAC_AGENT_BACKEND to
 * agent-sdk (default) | api | mock; TAC_AGENT_MOCK=1 forces mock.
 * TAC_AGENT_NO_REPLAN=1 disables the WS replan pipeline.
 * @tier T0
 */

const port = Number(process.env["TAC_AGENT_PORT"] ?? 3142);
const backend = resolveBackend();
const service = new ServiceClient();
const client = createModelClient(backend);

const app = buildServer({ client, service });

const replan =
  process.env["TAC_AGENT_NO_REPLAN"] === "1"
    ? null
    : new ReplanPipeline({ service, client, log: (m) => console.log(`[replan] ${m}`) });

app
  .listen({ port, host: "127.0.0.1" })
  .then(() => {
    console.log(`@tac/agent listening on http://127.0.0.1:${port} (backend=${backend}, service=${service.baseUrl})`);
    replan?.start();
  })
  .catch((err) => {
    console.error("agent failed to start:", err);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    replan?.stop();
    void app.close().then(() => process.exit(0));
  });
}
