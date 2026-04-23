/**
 * Shared Cloud Foundry CLI helper.
 *
 * All CF CLI interactions use `child_process.execFile` (no shell on macOS/Linux)
 * to avoid shell-injection risks.
 */

import { execFile } from 'child_process';

const DEFAULT_TIMEOUT_MS = 15_000;

/** Promisified wrapper around `execFile` for the CF CLI. */
export function runCf(
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'cf',
      args,
      { timeout: timeoutMs, cwd, shell: process.platform === 'win32' },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
