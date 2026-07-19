import { buildApp } from "./app.js";
import { defaultDataDir, loadConfig, resolveNetwork, servicePort, watchDisabled, LOCAL_HOSTS } from "./config.js";
import { DEFAULT_HORIZON } from "./plan.js";

/**
 * Service boot (M5.1): load config, open the active ProfileStore, load the
 * world/market/story data (lazily for the non-active mode), start watchers
 * (unless TAC_NO_WATCH=1), listen on 3141, and shut down gracefully.
 * @tier T1 (reads game logs/screenshots; writes only under data/local).
 */

async function main(): Promise<void> {
  const dataDir = defaultDataDir();
  const config = loadConfig(dataDir);
  const watch = !watchDisabled();

  const app = await buildApp({ dataDir, config, watch, logger: false });
  const rt = app.tac;

  console.log(`[config]      ${dataDir} — active profile ${config.activeProfile}`);
  console.log(`[store]       ${rt.store.profileKey}.sqlite open (level ${rt.store.level}, epoch ${rt.store.progressEpoch})`);
  console.log(`[world]       snapshot ${rt.snapshotVersion()} (${rt.gameMode}) — ${Object.keys(rt.world().graph.tasks).length} tasks`);
  const gameVersion = rt.gameVersion();
  if (gameVersion && gameVersion !== rt.snapshotVersion()) {
    console.log(`[patch]       WARNING: installed game ${gameVersion} != snapshot ${rt.snapshotVersion()} — run \`pnpm snapshot\``);
  }
  console.log(`[story]       ${rt.story() ? `dataset v${rt.story()!.gameVersion} loaded` : "no dataset (data/story/story.json missing)"}`);
  console.log(`[watchers]    ${watch ? `log + screenshot watchers running (logs: ${rt.logsDir() ?? "not found"})` : "disabled (TAC_NO_WATCH=1)"}`);
  console.log(`[agent-proxy] ${rt.agentUrl}`);

  // M3.2 acceptance: measure one cold plan build at boot; must stay < 2 s.
  const bundle = rt.planner.get(DEFAULT_HORIZON);
  console.log(
    `[plan]        horizon ${bundle.horizon} built in ${bundle.buildMs} ms ` +
      `(${bundle.plan.raids.length} raids, hash ${bundle.hash})${bundle.buildMs >= 2000 ? " — SLOW, exceeds the 2 s replan budget!" : ""}`,
  );

  const port = servicePort();
  const net = resolveNetwork(config);
  await app.listen({ port, host: net.bindHost });
  if (net.lanEnabled) {
    const lanHosts = [...net.allowedHosts].filter((h) => h && !LOCAL_HOSTS.includes(h));
    console.log(`[http]        listening on http://${net.bindHost}:${port} (REST + /ws) — LAN-EXPOSED`);
    console.log(`[http]        reachable from this LAN at: ${lanHosts.map((h) => `http://${h}:${port}`).join(", ") || "(no LAN IP detected)"}`);
    console.log(`[http]        trusted-home-LAN model: no auth, Host allowlist only. Never expose this port to the internet.`);
  } else {
    console.log(`[http]        listening on http://127.0.0.1:${port} (REST + /ws) — local-only`);
  }

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[shutdown]    ${signal} — stopping watchers, closing DB and server`);
    // app.close() runs the onClose hook -> rt.close() (watchers, planner, metrics, DB)
    app
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("[shutdown]    error:", err);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[boot] fatal:", err);
  process.exit(1);
});
