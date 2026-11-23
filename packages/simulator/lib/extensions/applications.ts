import {util} from '@appium/support';
import {limrunClientFor} from 'appium-xcode';
import {waitForCondition} from 'asyncbox';

import type {HasNativeSimctl} from '../native/types.js';
import type {AppContainerType, CoreSimulator, InteractsWithApps, LaunchAppOptions} from '../types.js';

declare module '../simulator-xcode-15.js' {
  interface SimulatorXcode15 extends InteractsWithApps {}
}

type CoreSimulatorWithApps = CoreSimulator & InteractsWithApps & HasNativeSimctl;

interface PlistBundleInfo {
  CFBundleName?: string;
  CFBundleIdentifier?: string;
}

/**
 * Install valid .app package on Simulator.
 *
 * @param app The path to the .app package.
 */
export async function installApp(this: CoreSimulatorWithApps, app: string): Promise<void> {
  return await this._native.installApp(this.udid, app);
}

/**
 * Returns user installed bundle ids which has 'bundleName' in their Info.Plist as 'CFBundleName'
 *
 * @param bundleName The bundle name of the application to be checked.
 * @return The list of bundle ids which have 'bundleName'
 */
export async function getUserInstalledBundleIdsByBundleName(
  this: CoreSimulatorWithApps,
  bundleName: string,
): Promise<string[]> {
  // The simulator lives on a Limrun host, so the instance lists its apps instead of a local glob.
  const apps = (await this._native.installedApps(this.udid)) as Record<
    string,
    PlistBundleInfo & {ApplicationType?: string}
  >;
  const bundleIds = Object.values(apps)
    .filter(
      ({CFBundleName, CFBundleIdentifier, ApplicationType}) =>
        CFBundleName === bundleName &&
        typeof CFBundleIdentifier === 'string' &&
        ApplicationType?.toLowerCase() === 'user',
    )
    .map(({CFBundleIdentifier}) => CFBundleIdentifier as string);
  if (bundleIds.length === 0) {
    return [];
  }

  this.log.debug(
    `The simulator has ${util.pluralize('bundle', bundleIds.length, true)} which ` +
      `have '${bundleName}' as their 'CFBundleName': ${JSON.stringify(bundleIds)}`,
  );
  return bundleIds;
}

/**
 * Uninstall the given application from the current Simulator.
 *
 * @param bundleId The bundle ID of the application to be removed.
 */
export async function removeApp(this: CoreSimulatorWithApps, bundleId: string): Promise<void> {
  await this._native.removeApp(this.udid, bundleId);
}

/**
 * Starts the given application on Simulator
 *
 * @param bundleId The bundle ID of the application to be launched
 * @param opts Launch options
 */
export async function launchApp(
  this: CoreSimulatorWithApps,
  bundleId: string,
  opts: LaunchAppOptions = {},
): Promise<void> {
  const {wait = false, timeoutMs = 10000, environment, terminateExisting, activateSuspended} = opts;
  const nativeOptions: Record<string, unknown> = {};
  if (environment) {
    nativeOptions.environment = environment;
  }
  if (terminateExisting) {
    nativeOptions.terminate_running_process = true;
  }
  if (activateSuspended) {
    nativeOptions.activate_suspended = true;
  }
  await this._native.launchApp(this.udid, bundleId, nativeOptions);
  if (!wait) {
    return;
  }

  try {
    await waitForCondition(async () => await this.isAppRunning(bundleId), {
      waitMs: timeoutMs,
      intervalMs: 300,
    });
  } catch {
    throw new Error(`App '${bundleId}' is not runnning after ${timeoutMs}ms timeout.`);
  }
}

/**
 * Stops the given application on Simulator.
 *
 * @param bundleId The bundle ID of the application to be stopped
 */
export async function terminateApp(this: CoreSimulatorWithApps, bundleId: string): Promise<void> {
  await this._native.terminateApp(this.udid, bundleId);
}

/**
 * Resolves the full filesystem path to one of an installed app's on-disk containers.
 *
 * @param bundleId Bundle identifier of the installed app.
 * @param containerType `'app'` (the default) for the `.app` bundle itself, `'data'` for its data
 * container, `'groups'` for its sole App Group container, or a specific App Group identifier.
 */
export async function getAppContainer(
  this: CoreSimulatorWithApps,
  bundleId: string,
  containerType: AppContainerType = 'app',
): Promise<string> {
  return await this._native.getAppContainer(this.udid, bundleId, containerType);
}

/**
 * @param bundleId Bundle identifier of the installed app.
 * @returns The app's properties, as reported by CoreSimulator's own `propertiesOfApplication:`.
 */
export async function appInfo(this: CoreSimulatorWithApps, bundleId: string): Promise<Record<string, unknown>> {
  return await this._native.appInfo(this.udid, bundleId);
}

/**
 * Verify whether the particular application is installed on Simulator.
 *
 * @param bundleId The bundle id of the application to be checked.
 * @return True if the given application is installed.
 */
export async function isAppInstalled(this: CoreSimulatorWithApps, bundleId: string): Promise<boolean> {
  return await this._native.isAppInstalled(this.udid, bundleId);
}

/**
 * Check if app with the given identifier is running.
 *
 * @param bundleId The bundle ID of the application to be checked.
 */
export async function isAppRunning(this: CoreSimulatorWithApps, bundleId: string): Promise<boolean> {
  return (await this.ps()).some(({name}) => name === bundleId);
}

/**
 * Scrub (delete the preferences and changed files) the particular application on Simulator.
 * The app will be terminated automatically if it is running.
 *
 * @param bundleId Bundle identifier of the application.
 * @throws {Error} if the given app is not installed.
 */
export async function scrubApp(this: CoreSimulatorWithApps, bundleId: string): Promise<void> {
  // The data container is on the Limrun host; the instance wipes it and relaunches the app.
  await limrunClientFor(this.udid).softReset(bundleId, {strategy: 'data'});
  this.log.info(`Scrubbed the data of ${bundleId}`);
  try {
    await this.terminateApp(bundleId);
  } catch {}
}
