import type {TeenProcessExecResult} from 'teen_process';

import {anyLimrunClient} from './limrun.js';

export const XCRUN_TIMEOUT = 15000;

/**
 * Executes 'xcrun' command line utility
 *
 * @param args xcrun arguments
 * @param timeout The maximum number of milliseconds to wait until xcrun exists
 * @returns The result of xcrun execution
 * @throws {Error} If xcrun returned non-zero exit code or timed out
 */
export async function runXcrunCommand(
  args: string[],
  timeout: number = XCRUN_TIMEOUT,
): Promise<TeenProcessExecResult<string>> {
  // xcrun runs on the Limrun host that owns the simulator, not on this machine.
  const result = await withTimeout(anyLimrunClient().xcrun(args), timeout, `xcrun ${args.join(' ')}`);
  if (result.exitCode !== 0) {
    throw new Error(`xcrun ${args.join(' ')} exited with code ${result.exitCode}: ${result.stderr || result.stdout}`);
  }
  return {stdout: result.stdout, stderr: result.stderr, code: result.exitCode};
}

/**
 * Executes 'xcodebuild -version' on the Limrun host.
 * The host allows no other xcodebuild arguments.
 *
 * @param timeout The maximum number of milliseconds to wait for the result
 * @returns The output of `xcodebuild -version`
 */
export async function runXcodebuildVersion(timeout: number = XCRUN_TIMEOUT): Promise<string> {
  const result = await withTimeout(anyLimrunClient().xcodebuild(['-version']), timeout, 'xcodebuild -version');
  if (result.exitCode !== 0) {
    throw new Error(`xcodebuild -version exited with code ${result.exitCode}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function withTimeout<T>(promise: Promise<T>, timeout: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeout}ms`)), timeout);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Uses macOS Spotlight service to detect where the given app is installed
 *
 * @param bundleId Bundle identifier of the target app
 * @returns Full paths to where the app with the given bundle id is present.
 */
export async function findAppPaths(bundleId: string): Promise<string[]> {
  throw new Error(`Finding '${bundleId}' with Spotlight is not supported on Limrun simulators`);
}

/**
 * Finds and retrieves the content of the Xcode's Info.plist file
 *
 * @param developerRoot Full path to the Contents/Developer folder under Xcode.app root
 * @returns All plist entries as an object or an empty object if no plist was found
 */
export async function readXcodePlist(developerRoot: string): Promise<Record<string, any>> {
  throw new Error(`Reading the Xcode plist under '${developerRoot}' is not supported on Limrun simulators`);
}
