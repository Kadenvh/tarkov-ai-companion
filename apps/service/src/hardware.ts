import { cpus, totalmem } from "node:os";
import { execFile } from "node:child_process";
import type { HardwareFacts } from "@tac/environment";

/**
 * Hardware detection for the performance advisory (T0 — reads the host, never
 * the game). Logical cores + RAM come free from `os`; physical core count needs
 * a probe because Node only exposes logical threads. The probe is best-effort
 * and guarded: any failure (or a non-Windows host with no injected runner)
 * yields `physicalCores: null`, and the pure `perfAdvice` degrades to a
 * logical-thread estimate. Windows is the shipping target.
 */

/** Minimal injectable shape of node:child_process execFile (for deterministic tests). */
export type ExecFileFn = (
  cmd: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
  callback: (error: Error | null, stdout: string) => void,
) => void;

const PROBE_TIMEOUT_MS = 4000;

const defaultExec: ExecFileFn = (cmd, args, options, callback) => {
  execFile(cmd, args, options, (err, stdout) => callback(err, String(stdout ?? "")));
};

/** Sum of physical cores across sockets, or null when it can't be determined. */
export async function detectPhysicalCores(execImpl?: ExecFileFn): Promise<number | null> {
  // Real runs only probe on Windows; an injected runner (tests) always runs so
  // the parse logic is exercised regardless of the host platform.
  const runner = execImpl ?? (process.platform === "win32" ? defaultExec : null);
  if (!runner) return null;
  return new Promise<number | null>((resolve) => {
    try {
      runner(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
        ],
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(null);
          const n = Number.parseInt(stdout.trim(), 10);
          resolve(Number.isInteger(n) && n > 0 ? n : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

export async function detectHardware(execImpl?: ExecFileFn): Promise<HardwareFacts> {
  return {
    logicalCores: cpus().length,
    physicalCores: await detectPhysicalCores(execImpl),
    totalRamGB: Math.round(totalmem() / 1024 ** 3),
  };
}
