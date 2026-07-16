import { describe, expect, it, vi } from "vitest";
import {
  buildSidecarSpawn,
  restartDelay,
  terminateAll,
  type Killable,
  type SidecarConfig,
} from "../src/lib/sidecar.js";

const serviceCfg: SidecarConfig = {
  name: "service",
  filter: "@tac/service",
  portEnv: "TAC_PORT",
  port: 3141,
  cwd: "C:/repo/apps/service",
};

describe("buildSidecarSpawn", () => {
  it("builds `node --import tsx <entry>` by default", () => {
    const plan = buildSidecarSpawn(serviceCfg, { baseEnv: {} });
    expect(plan.command).toBe("node");
    expect(plan.args).toEqual(["--import", "tsx", "C:/repo/apps/service/src/main.ts"]);
    expect(plan.cwd).toBe("C:/repo/apps/service");
  });

  it("injects the chosen port under the sidecar's portEnv", () => {
    const plan = buildSidecarSpawn(serviceCfg, { baseEnv: {} });
    expect(plan.env["TAC_PORT"]).toBe("3141");
  });

  it("merges baseEnv but drops undefined values", () => {
    const plan = buildSidecarSpawn(serviceCfg, {
      baseEnv: { PATH: "/usr/bin", MISSING: undefined },
    });
    expect(plan.env["PATH"]).toBe("/usr/bin");
    expect("MISSING" in plan.env).toBe(false);
  });

  it("applies extraEnv last (agent → TAC_SERVICE_URL)", () => {
    const plan = buildSidecarSpawn(
      {
        name: "agent",
        filter: "@tac/agent",
        portEnv: "TAC_AGENT_PORT",
        port: 3142,
        cwd: "C:/repo/apps/agent",
        extraEnv: { TAC_SERVICE_URL: "http://127.0.0.1:3141" },
      },
      { baseEnv: {} },
    );
    expect(plan.env["TAC_AGENT_PORT"]).toBe("3142");
    expect(plan.env["TAC_SERVICE_URL"]).toBe("http://127.0.0.1:3141");
  });

  it("honours a nodeCommand override + custom entry for the packaged case", () => {
    const plan = buildSidecarSpawn(
      { ...serviceCfg, entry: "dist/main.js" },
      { nodeCommand: "C:/app/resources/runtime/node.exe", baseEnv: {} },
    );
    expect(plan.command).toBe("C:/app/resources/runtime/node.exe");
    expect(plan.args).toEqual(["--import", "tsx", "C:/repo/apps/service/dist/main.js"]);
  });
});

describe("terminateAll", () => {
  function fakeProc(pid: number | undefined, killed = false): Killable & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      pid,
      killed,
      calls,
      kill(signal?: NodeJS.Signals | number) {
        calls.push(signal);
        return true;
      },
    };
  }

  it("signals every live, pid-bearing child and reports their pids", () => {
    const a = fakeProc(101);
    const b = fakeProc(102);
    const result = terminateAll([a, b]);
    expect(result.signalled).toEqual([101, 102]);
    expect(a.calls).toEqual(["SIGTERM"]);
    expect(b.calls).toEqual(["SIGTERM"]);
  });

  it("skips already-killed and pid-less handles", () => {
    const dead = fakeProc(200, true);
    const nopid = fakeProc(undefined);
    const live = fakeProc(201);
    const result = terminateAll([dead, nopid, live]);
    expect(result.signalled).toEqual([201]);
    expect(dead.calls).toEqual([]);
    expect(nopid.calls).toEqual([]);
  });

  it("forwards a custom signal (SIGKILL escalation)", () => {
    const p = fakeProc(300);
    terminateAll([p], "SIGKILL");
    expect(p.calls).toEqual(["SIGKILL"]);
  });

  it("does not count a kill that returns false", () => {
    const calls: unknown[] = [];
    const proc: Killable = {
      pid: 400,
      killed: false,
      kill: (s) => {
        calls.push(s);
        return false;
      },
    };
    const result = terminateAll([proc]);
    expect(result.attempted).toBe(1);
    expect(result.signalled).toEqual([]);
  });
});

describe("restartDelay", () => {
  it("grows exponentially from the base", () => {
    expect(restartDelay(1)).toBe(500);
    expect(restartDelay(2)).toBe(1_000);
    expect(restartDelay(3)).toBe(2_000);
  });

  it("caps at maxMs", () => {
    expect(restartDelay(5, { baseMs: 500, maxMs: 10_000 })).toBe(8_000);
    expect(restartDelay(6, { baseMs: 500, maxMs: 10_000, maxRestarts: 10 })).toBe(10_000);
  });

  it("returns null once the restart budget is exceeded", () => {
    expect(restartDelay(6)).toBeNull();
    expect(restartDelay(0)).toBeNull();
  });
});
