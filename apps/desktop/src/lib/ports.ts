import net from "node:net";

/**
 * Pure port-selection helper for the desktop shell.
 *
 * The shell must hand its sidecars (@tac/service :3141, @tac/agent :3142) a
 * free port even when the defaults are taken (a stray dev server, a second
 * install, etc). Selection is factored out as a pure function over an injected
 * `isFree` probe so it is deterministic under test; the real probe lives in
 * {@link isPortFree}.
 *
 * @tier T0 — pure computation + a loopback TCP bind probe on OUR ports only;
 * never contacts the game process.
 */

/** Predicate: resolves true when `port` is bindable on loopback right now. */
export type PortProbe = (port: number) => Promise<boolean>;

export interface SelectPortOptions {
  /** Highest port to consider before giving up (inclusive). Default 65535. */
  readonly maxPort?: number;
  /** Hard cap on probe attempts, guards against runaway loops. Default 512. */
  readonly maxProbes?: number;
}

/**
 * Return `preferred` if the injected probe says it is free, otherwise walk
 * upward to the next free port. Throws if none is found within the bounds.
 */
export async function selectPort(
  preferred: number,
  isFree: PortProbe,
  options: SelectPortOptions = {},
): Promise<number> {
  const maxPort = options.maxPort ?? 65535;
  const maxProbes = options.maxProbes ?? 512;
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > maxPort) {
    throw new RangeError(`preferred port ${preferred} is out of range (1..${maxPort})`);
  }

  let probes = 0;
  for (let port = preferred; port <= maxPort; port += 1) {
    if (probes >= maxProbes) break;
    probes += 1;
    if (await isFree(port)) return port;
  }
  throw new Error(
    `no free port found from ${preferred} within ${maxProbes} probes (maxPort ${maxPort})`,
  );
}

/**
 * Select several ports in one pass, never returning a duplicate even when two
 * requests share a preferred value. Returns the chosen ports in request order.
 */
export async function selectPorts(
  preferred: readonly number[],
  isFree: PortProbe,
  options: SelectPortOptions = {},
): Promise<number[]> {
  const taken = new Set<number>();
  const guarded: PortProbe = async (port) => (taken.has(port) ? false : isFree(port));
  const chosen: number[] = [];
  for (const want of preferred) {
    const port = await selectPort(want, guarded, options);
    taken.add(port);
    chosen.push(port);
  }
  return chosen;
}

/**
 * Real probe: attempt to bind `127.0.0.1:<port>` and release immediately.
 * Resolves true when the bind succeeds (port free), false on EADDRINUSE / any
 * bind error. Loopback-only so we never expose a listener to the network.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}
