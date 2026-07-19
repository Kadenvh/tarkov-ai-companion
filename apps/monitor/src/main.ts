import { MonitorEngine } from "./engine.js";
import { UpstreamClient } from "./upstream.js";
import { TarkovDevSubmitter } from "./submit.js";
import { buildMonitorServer } from "./server.js";
import { loadConfig } from "./config.js";

/**
 * @tac/monitor entrypoint. A TarkovMonitor-style live companion that rides the
 * service's event stream (no direct log/game access — @tier T0).
 *
 * Ports/env:
 *   TAC_MONITOR_PORT   monitor window + API (default 3143)
 *   TAC_SERVICE_URL    upstream service (default http://localhost:3141)
 *   TAC_MONITOR_ACCOUNT_ID   account id for opt-in goons reports (optional)
 */

const port = Number(process.env["TAC_MONITOR_PORT"] ?? 3143);
const serviceUrl = process.env["TAC_SERVICE_URL"] ?? "http://localhost:3141";

const config = loadConfig();
const submitter = new TarkovDevSubmitter({ log: (m) => console.log(`[submit] ${m}`) });
const engine = new MonitorEngine({ config, submitter, log: (m) => console.log(`[monitor] ${m}`) });

const upstream = new UpstreamClient({ serviceUrl, engine, log: (m) => console.log(`[upstream] ${m}`) });
const app = buildMonitorServer({ engine });

const ticker = setInterval(() => engine.tick(), 1_000);

app
  .listen({ port, host: "127.0.0.1" })
  .then(() => {
    console.log(`@tac/monitor listening on http://127.0.0.1:${port} (service=${serviceUrl})`);
    console.log(`Open http://localhost:${port} and click "Enable sound" for voice + chime alerts.`);
    upstream.start();
  })
  .catch((err) => {
    console.error("monitor failed to start:", err);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(ticker);
    upstream.stop();
    void app.close().then(() => process.exit(0));
  });
}
