import {EventEmitter} from 'node:events';
import type {Socket} from 'node:net';
import path from 'node:path';
import {PassThrough} from 'node:stream';

import {DeviceOrientation, SimDeviceState} from '@appium/coresim';
import type {
  BiometricName,
  JpegStream,
  NativeSimctl,
  NativeSimctlOptions,
  PushNotificationPayload,
  ScreenshotOptions,
  SimBootInfo,
  SimDeviceInfo,
  SimDeviceTypeInfo,
  SimDisplayInfo,
  SimPermissionService,
  SimPermissionStatus,
  SimProcessInfo,
  SimRuntimeInfo,
  SpawnedProcess,
  SpawnOptions,
  StopVideoRecordingOptions,
  VideoRecordingOptions,
  VideoStream,
} from '@appium/coresim';
import {fs, tempDir} from '@appium/support';
import type {Ios} from '@limrun/api';
import {limrunClientFor, limrunUdids} from 'appium-xcode';

import {log} from '../logger.js';
import {parseAsciiPlist} from './ascii-plist.js';

/** Every public member of `NativeSimctl`, so the compiler flags any method this backend lacks. */
type NativeSimctlApi = {[K in keyof NativeSimctl as K extends `_${string}` ? never : K]: NativeSimctl[K]};

/**
 * Thrown for simulator operations a Limrun instance cannot perform, such as
 * erasing the device or anything that needs the host's CoreSimulator directly.
 */
export class LimrunUnsupportedError extends Error {
  constructor(operation: string, hint?: string) {
    super(`${operation} is not supported on Limrun simulators${hint ? `: ${hint}` : ''}`);
    this.name = 'LimrunUnsupportedError';
  }
}

// The SDK's orientation names, which the instance reports back as camelCase `deviceInfo` names.
const SDK_ORIENTATIONS: Record<DeviceOrientation, Ios.DeviceOrientation> = {
  [DeviceOrientation.Portrait]: 'Portrait',
  [DeviceOrientation.PortraitUpsideDown]: 'PortraitUpsideDown',
  [DeviceOrientation.LandscapeRight]: 'LandscapeRight',
  [DeviceOrientation.LandscapeLeft]: 'LandscapeLeft',
};

// Darwin notifications the simulator posts for biometrics and shake, as `simctl spawn notifyutil` names them.
const BIOMETRIC_ENROLLMENT = 'com.apple.BiometricKit.enrollmentChanged';
const SHAKE_NOTIFICATION = 'com.apple.UIKit.SimulatorShake';
const BIOMETRIC_MATCH_PREFIX: Record<BiometricName, string> = {
  touchId: 'com.apple.BiometricKit_Sim.fingerTouch',
  faceId: 'com.apple.BiometricKit_Sim.pearl',
};

// `simctl ui content_size` names in the order of coresim's raw categories, which start at 1.
const CONTENT_SIZES = [
  'extra-small',
  'small',
  'medium',
  'large',
  'extra-large',
  'extra-extra-large',
  'extra-extra-extra-large',
  'accessibility-medium',
  'accessibility-large',
  'accessibility-extra-large',
  'accessibility-extra-extra-large',
  'accessibility-extra-extra-extra-large',
];

const DEVICE_STATES: Record<string, SimDeviceState> = {
  Creating: SimDeviceState.Creating,
  Shutdown: SimDeviceState.Shutdown,
  Booting: SimDeviceState.Booting,
  Booted: SimDeviceState.Booted,
  'Shutting Down': SimDeviceState.ShuttingDown,
};

// The SDK reports interface orientations. coresim's values number them the same way as
// UIInterfaceOrientation (LandscapeRight 3, LandscapeLeft 4), so the names map one to one.
const ORIENTATIONS: Record<NonNullable<Ios.DeviceInfo['orientation']>, DeviceOrientation> = {
  portrait: DeviceOrientation.Portrait,
  portraitUpsideDown: DeviceOrientation.PortraitUpsideDown,
  landscapeLeft: DeviceOrientation.LandscapeLeft,
  landscapeRight: DeviceOrientation.LandscapeRight,
};
const DUO_ORIENTATIONS: Record<DeviceOrientation, Ios.DuoOrientation> = {
  [DeviceOrientation.Portrait]: 'portrait',
  [DeviceOrientation.PortraitUpsideDown]: 'pud',
  [DeviceOrientation.LandscapeRight]: 'landscape-right',
  [DeviceOrientation.LandscapeLeft]: 'landscape-left',
};

const WEB_INSPECTOR_SOCKET = 'com.apple.webinspectord_sim.socket';
// `simctl spawn` on the instance runs only these tools, by bare name.
const SPAWN_TOOLS = new Set(['defaults', 'notifyutil']);
const LOG_TOOL = 'log';

/**
 * Drives simulators on Limrun instances through the Limrun SDK, in place of
 * `@appium/coresim`'s native CoreSimulator binding, which needs the simulator
 * on this machine.
 *
 * Each call finds the instance client by the simulator's udid. The instance
 * runs `simctl` only for an allowlist of subcommands, so operations outside it
 * throw {@link LimrunUnsupportedError} instead of failing in a confusing way.
 */
export class LimrunNativeSimctl implements NativeSimctlApi {
  readonly _options: Readonly<NativeSimctlOptions>;
  private readonly recordings = new Map<string, string>();

  constructor(options: NativeSimctlOptions = {}) {
    this._options = {...options};
  }

  // lifecycle

  async getDevices(): Promise<SimDeviceInfo[]> {
    const devices = new Map<string, SimDeviceInfo>();
    for (const udid of limrunUdids()) {
      const {devices: byRuntime} = (await simctlJson(udid, ['list', 'devices', '-j'])) as {
        devices: Record<string, {udid: string; name: string; state: string; deviceTypeIdentifier?: string}[]>;
      };
      for (const [runtimeIdentifier, list] of Object.entries(byRuntime)) {
        for (const d of list) {
          devices.set(d.udid, {
            udid: d.udid,
            name: d.name,
            state: DEVICE_STATES[d.state] ?? SimDeviceState.Shutdown,
            deviceTypeIdentifier: d.deviceTypeIdentifier ?? '',
            runtimeIdentifier,
          });
        }
      }
    }
    return [...devices.values()];
  }

  async getSupportedDeviceTypes(): Promise<SimDeviceTypeInfo[]> {
    const {devicetypes} = (await simctlJson(anyUdid(), ['list', 'devicetypes', '-j'])) as {
      devicetypes: {identifier: string; name: string}[];
    };
    return devicetypes.map(({identifier, name}) => ({identifier, name}));
  }

  async getSupportedRuntimes(): Promise<SimRuntimeInfo[]> {
    const {runtimes} = (await simctlJson(anyUdid(), ['list', 'runtimes', '-j'])) as {
      runtimes: {identifier: string; name: string; version: string}[];
    };
    return runtimes.map(({identifier, name, version}) => ({identifier, name, versionString: version}));
  }

  async createDevice(): Promise<SimDeviceInfo> {
    throw new LimrunUnsupportedError('Creating a simulator', 'create a Limrun iOS instance instead');
  }

  async deleteDevice(): Promise<void> {
    throw new LimrunUnsupportedError('Deleting a simulator', 'delete the Limrun iOS instance instead');
  }

  async bootDevice(udid: string): Promise<void> {
    // Limrun boots the simulator when it creates the instance.
    const device = (await this.getDevices()).find((d) => sameUdid(d.udid, udid));
    if (device?.state !== SimDeviceState.Booted) {
      throw new LimrunUnsupportedError('Booting a simulator', `'${udid}' is not booted; create a new instance`);
    }
  }

  async getBootStatus(udid: string): Promise<SimBootInfo | null> {
    throw new LimrunUnsupportedError(`Reading the boot status of '${udid}'`);
  }

  async waitForBoot(udid: string, options: {timeoutMs?: number} = {}): Promise<void> {
    const wait = simctl(udid, ['bootstatus', udid]);
    const timeoutMs = options.timeoutMs ?? 240000;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Simulator '${udid}' did not finish booting within ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([wait, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdownDevice(udid: string): Promise<void> {
    throw new LimrunUnsupportedError(`Shutting down '${udid}'`, 'delete the Limrun iOS instance instead');
  }

  async shutdownAllDevices(): Promise<void> {
    throw new LimrunUnsupportedError('Shutting down all simulators');
  }

  async eraseDevice(udid: string): Promise<void> {
    throw new LimrunUnsupportedError(`Erasing '${udid}'`, 'create a new Limrun iOS instance for a clean simulator');
  }

  async renameDevice(udid: string): Promise<void> {
    throw new LimrunUnsupportedError(`Renaming '${udid}'`);
  }

  // apps

  async installApp(udid: string, appPath: string): Promise<void> {
    if (/^https?:\/\//.test(appPath)) {
      await client(udid).installApp(appPath);
      return;
    }
    await client(udid).syncApp(appPath, {install: true, launchMode: 'None', watch: false});
  }

  async removeApp(udid: string, bundleId: string): Promise<void> {
    await simctl(udid, ['uninstall', udid, bundleId]);
  }

  async launchApp(udid: string, bundleId: string, options: Record<string, unknown> = {}): Promise<number> {
    const env = options.environment as Record<string, string> | undefined;
    if (options.activate_suspended) {
      log.info(`Launching '${bundleId}' on Limrun foregrounds it; activateSuspended has no separate effect`);
    }
    await client(udid).launchApp(bundleId, {
      mode: options.terminate_running_process ? 'RelaunchIfRunning' : 'ForegroundIfRunning',
      ...(env && {env}),
    });
    const app = (await client(udid).listApps()).find((a) => a.bundleId === bundleId);
    return app?.pid ?? 0;
  }

  async terminateApp(udid: string, bundleId: string): Promise<void> {
    await client(udid).terminateApp(bundleId);
  }

  async isAppInstalled(udid: string, bundleId: string): Promise<boolean> {
    return (await client(udid).listApps()).some((a) => a.bundleId === bundleId);
  }

  async appInfo(udid: string, bundleId: string): Promise<Record<string, unknown>> {
    const {stdout} = await simctl(udid, ['appinfo', udid, bundleId]);
    const info = parseAsciiPlist(stdout);
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      throw new Error(`'${bundleId}' is not installed on '${udid}'`);
    }
    return info as Record<string, unknown>;
  }

  async installedApps(udid: string): Promise<Record<string, unknown>> {
    // `simctl listapps` prints every app's properties, the same dictionary coresim reads locally.
    const {stdout} = await simctl(udid, ['listapps', udid]);
    return parseAsciiPlist(stdout) as Record<string, unknown>;
  }

  /**
   * Returns the container path on the Limrun host. It names a remote folder,
   * so read and write its files with the SDK's container file calls.
   */
  async getAppContainer(udid: string, bundleId: string, containerType: string = 'app'): Promise<string> {
    const info = await this.appInfo(udid, bundleId);
    const fromUrl = (v: unknown) => (typeof v === 'string' ? v.replace(/^file:\/\//, '').replace(/\/$/, '') : '');
    if (containerType === 'app') {
      return fromUrl(info.Path);
    }
    if (containerType === 'data') {
      return fromUrl(info.DataContainer);
    }
    const groups = (info.GroupContainers ?? {}) as Record<string, unknown>;
    if (containerType === 'groups') {
      const ids = Object.keys(groups);
      if (ids.length !== 1) {
        throw new Error(`'${bundleId}' has ${ids.length} App Group containers; name the one you need`);
      }
      return fromUrl(groups[ids[0]]);
    }
    if (!(containerType in groups)) {
      throw new Error(`'${bundleId}' has no App Group container '${containerType}'`);
    }
    return fromUrl(groups[containerType]);
  }

  // media

  async addMedia(udid: string, filePaths: string[]): Promise<void> {
    const remotePaths = await Promise.all(filePaths.map((p) => client(udid).pushFile(p, path.basename(p))));
    await simctl(udid, ['addmedia', udid, ...remotePaths]);
  }

  async addPhoto(udid: string, filePath: string): Promise<void> {
    await this.addMedia(udid, [filePath]);
  }

  async addVideo(udid: string, filePath: string): Promise<void> {
    await this.addMedia(udid, [filePath]);
  }

  // biometric

  async isBiometricEnrolled(udid: string): Promise<boolean> {
    const {stdout} = await simctl(udid, ['spawn', udid, 'notifyutil', '-g', BIOMETRIC_ENROLLMENT]);
    // notifyutil prints "<name> <state>".
    return stdout.trim().split(/\s+/).pop() === '1';
  }

  async enrollBiometric(udid: string, isEnabled: boolean = true): Promise<void> {
    await simctl(udid, [
      'spawn',
      udid,
      'notifyutil',
      '-s',
      BIOMETRIC_ENROLLMENT,
      isEnabled ? '1' : '0',
      '-p',
      BIOMETRIC_ENROLLMENT,
    ]);
  }

  async sendBiometricMatch(
    udid: string,
    shouldMatch: boolean = true,
    biometricName: BiometricName = 'touchId',
  ): Promise<void> {
    const name = `${BIOMETRIC_MATCH_PREFIX[biometricName]}.${shouldMatch ? 'match' : 'nomatch'}`;
    await simctl(udid, ['spawn', udid, 'notifyutil', '-p', name]);
  }

  // darwin notifications

  async getDarwinNotificationState(udid: string, name: string): Promise<bigint> {
    const {stdout} = await simctl(udid, ['spawn', udid, 'notifyutil', '-g', name]);
    return BigInt(stdout.trim().split(/\s+/).pop() ?? '0');
  }

  async setDarwinNotificationState(udid: string, name: string, state: bigint): Promise<void> {
    await simctl(udid, ['spawn', udid, 'notifyutil', '-s', name, state.toString()]);
  }

  async postDarwinNotification(udid: string, name: string): Promise<void> {
    await simctl(udid, ['spawn', udid, 'notifyutil', '-p', name]);
  }

  // misc

  async shake(udid: string): Promise<void> {
    await this.postDarwinNotification(udid, SHAKE_NOTIFICATION);
  }

  // interaction

  async getEnv(udid: string, name: string): Promise<string> {
    return (await simctl(udid, ['getenv', udid, name])).stdout.trim();
  }

  async openUrl(udid: string, url: string): Promise<void> {
    await client(udid).openUrl(url);
  }

  async setLocation(udid: string, latitude: number, longitude: number): Promise<void> {
    await simctl(udid, ['location', udid, 'set', `${latitude},${longitude}`]);
  }

  async clearLocation(udid: string): Promise<void> {
    await simctl(udid, ['location', udid, 'clear']);
  }

  async pushNotification(udid: string, bundleId: string, payload: PushNotificationPayload): Promise<void> {
    await withTempFile('payload.apns', JSON.stringify(payload), async (localPath) => {
      const remotePath = await client(udid).pushFile(localPath, path.basename(localPath));
      await simctl(udid, ['push', udid, bundleId, remotePath]);
    });
  }

  // pasteboard

  async getPasteboard(udid: string): Promise<string> {
    return (await simctl(udid, ['pbpaste', udid])).stdout;
  }

  async setPasteboard(udid: string, content: string): Promise<void> {
    await simctl(udid, ['pbcopy', udid], content);
  }

  // keychain

  async addCertificate(udid: string): Promise<void> {
    throw new LimrunUnsupportedError(
      `Adding a non-root certificate to '${udid}'`,
      'add it as a trusted root certificate instead',
    );
  }

  async addRootCertificate(udid: string, cert: string | Buffer): Promise<void> {
    await client(udid).addCaCertificate(toPem(cert));
  }

  async resetKeychain(udid: string): Promise<void> {
    throw new LimrunUnsupportedError(`Resetting the keychain of '${udid}'`);
  }

  // ui

  async getAppearance(udid: string): Promise<number> {
    const {stdout} = await simctl(udid, ['ui', udid, 'appearance']);
    return {light: 1, dark: 2}[stdout.trim()] ?? 0;
  }

  async setAppearance(udid: string, style: number): Promise<void> {
    const name = {1: 'light', 2: 'dark'}[style];
    if (!name) {
      throw new Error(`Unknown appearance style ${style}`);
    }
    await simctl(udid, ['ui', udid, 'appearance', name]);
  }

  async getIncreaseContrast(udid: string): Promise<number> {
    const {stdout} = await simctl(udid, ['ui', udid, 'increase_contrast']);
    return {disabled: 1, enabled: 2}[stdout.trim()] ?? 0;
  }

  async setIncreaseContrast(udid: string, enabled: boolean): Promise<void> {
    await simctl(udid, ['ui', udid, 'increase_contrast', enabled ? 'enabled' : 'disabled']);
  }

  async getContentSize(udid: string): Promise<number> {
    const {stdout} = await simctl(udid, ['ui', udid, 'content_size']);
    return CONTENT_SIZES.indexOf(stdout.trim()) + 1;
  }

  async setContentSize(udid: string, category: number): Promise<void> {
    const name = CONTENT_SIZES[category - 1];
    if (!name) {
      throw new Error(`Unknown content size category ${category}`);
    }
    await simctl(udid, ['ui', udid, 'content_size', name]);
  }

  async setOrientation(udid: string, orientation: DeviceOrientation): Promise<void> {
    if (await this.isDuo(udid)) {
      await client(udid).setDuoOrientation(DUO_ORIENTATIONS[orientation]);
      return;
    }
    await client(udid).setOrientation(SDK_ORIENTATIONS[orientation]);
  }

  async getOrientation(udid: string): Promise<DeviceOrientation> {
    const {orientation} = await client(udid).getDeviceInfo();
    return orientation ? ORIENTATIONS[orientation] : DeviceOrientation.Portrait;
  }

  // permissions

  // The instance writes TCC.db and SpringBoard's notification store itself, the way coresim does
  // on a local host. A notifications change restarts SpringBoard and returns once it is back.

  async grantPermission(
    udid: string,
    service: SimPermissionService,
    bundleId: string,
    status: 'granted' | 'limited' | 'critical' = 'granted',
  ): Promise<void> {
    await client(udid).setPermission(bundleId, service, status);
  }

  async revokePermission(udid: string, service: SimPermissionService, bundleId: string): Promise<void> {
    await client(udid).setPermission(bundleId, service, 'denied');
  }

  async resetPermission(udid: string, service: SimPermissionService, bundleId: string): Promise<void> {
    await client(udid).setPermission(bundleId, service, 'unset');
  }

  async getPermission(udid: string, service: SimPermissionService, bundleId: string): Promise<SimPermissionStatus> {
    if (service === 'notifications') {
      throw new Error(`The status of the 'notifications' permission cannot be read`);
    }
    const status = await client(udid).getPermission(bundleId, service);
    if (status === 'critical') {
      // Only notifications have a critical status, and they cannot be read.
      throw new Error(`Unexpected '${status}' status of the '${service}' permission`);
    }
    return status;
  }

  // process

  async listProcesses(udid: string): Promise<SimProcessInfo[]> {
    // The instance reports running apps only; system daemons stay invisible.
    return (await client(udid).listApps())
      .filter((a) => a.pid !== undefined)
      .map((a) => ({pid: a.pid as number, group: 'UIKitApplication', name: a.bundleId}));
  }

  async getRuntimeRootPath(udid: string): Promise<string> {
    return await this.getEnv(udid, 'IPHONE_SIMULATOR_ROOT');
  }

  // spawn

  async spawnProcess(udid: string, executable: string, options: SpawnOptions = {}): Promise<SpawnedProcess> {
    const tool = path.basename(executable);
    // `arguments` replaces argv including argv[0], as in coresim.
    const args = (options.arguments ?? [executable]).slice(1);
    if (options.environment && Object.keys(options.environment).length) {
      throw new LimrunUnsupportedError(`Passing environment variables to '${tool}'`);
    }
    if (tool === LOG_TOOL && args[0] === 'stream') {
      if (args.length > 1) {
        log.info(
          `Limrun streams the full simulator log; ignoring the log stream arguments ${JSON.stringify(args.slice(1))}`,
        );
      }
      return syslogProcess(client(udid)) as unknown as SpawnedProcess;
    }
    if (!SPAWN_TOOLS.has(tool)) {
      throw new LimrunUnsupportedError(
        `Running '${executable}' in the simulator`,
        'only defaults and notifyutil run there',
      );
    }
    return simctlProcess(client(udid).simctl(['spawn', udid, tool, ...args])) as unknown as SpawnedProcess;
  }

  // screenshot

  async getScreenshot(udid: string, options: ScreenshotOptions = {}): Promise<Buffer> {
    if (options.displayId !== undefined) {
      log.info(`Limrun captures the main display; ignoring displayId ${options.displayId}`);
    }
    const {base64} = await client(udid).screenshot({format: options.format ?? 'png', size: 'full'});
    return Buffer.from(base64, 'base64');
  }

  async getDisplays(udid: string): Promise<SimDisplayInfo[]> {
    throw new LimrunUnsupportedError(`Listing the displays of '${udid}'`);
  }

  // video

  async startVideoRecording(udid: string, outputFile: string, options: VideoRecordingOptions = {}): Promise<void> {
    if (Object.keys(options).length) {
      log.info(`Limrun records with its own encoding settings; ignoring ${JSON.stringify(Object.keys(options))}`);
    }
    await client(udid).startRecording();
    this.recordings.set(udid, outputFile);
  }

  async stopVideoRecording(udid: string, options: StopVideoRecordingOptions = {}): Promise<void> {
    const outputFile = this.recordings.get(udid);
    if (!outputFile) {
      if (options.force) {
        return;
      }
      throw new Error(`No video recording is running on '${udid}'`);
    }
    this.recordings.delete(udid);
    await client(udid).stopRecording({localPath: outputFile});
  }

  async isVideoRecording(udid: string): Promise<boolean> {
    return this.recordings.has(udid);
  }

  async startVideoStream(udid: string): Promise<VideoStream> {
    throw new LimrunUnsupportedError(`Streaming video from '${udid}'`);
  }

  async startJpegStream(udid: string): Promise<JpegStream> {
    throw new LimrunUnsupportedError(`Streaming JPEG frames from '${udid}'`);
  }

  // webinspector

  /**
   * Returns the Web Inspector socket path on the Limrun host. Connect to it
   * through the instance's port-forward tunnel, not with a local socket.
   */
  async getWebInspectorSocket(udid: string): Promise<string> {
    const entry = (await client(udid).lsof()).find((e) => e.path.endsWith(WEB_INSPECTOR_SOCKET));
    if (!entry) {
      throw new Error(`The Web Inspector socket of '${udid}' is not open yet`);
    }
    return entry.path;
  }

  // duo

  async isDuo(udid: string): Promise<boolean> {
    return (await client(udid).getFoldState()) !== null;
  }

  async setSimulatedHingeAngle(udid: string, angle: number): Promise<void> {
    await client(udid).setHingeAngle(angle);
  }

  async setHidOrientation(udid: string, orientation: DeviceOrientation, isMainDisplay: boolean): Promise<void> {
    if (!isMainDisplay) {
      log.info('Limrun rotates both displays of a Duo together');
    }
    await client(udid).setDuoOrientation(DUO_ORIENTATIONS[orientation]);
  }

  // hid

  async pressHidButton(udid: string, page: number, usage: number, duration: number = 0.1): Promise<void> {
    // The instance sends keyboard-page usages as key events and other pages as raw usages.
    await client(udid).performActions([
      {type: 'usageDown', usagePage: page, usage},
      {type: 'wait', durationMs: Math.round(duration * 1000)},
      {type: 'usageUp', usagePage: page, usage},
    ]);
  }
}

function client(udid: string): Ios.InstanceClient {
  return limrunClientFor(udid);
}

function anyUdid(): string {
  const [udid] = limrunUdids();
  if (!udid) {
    throw new Error('No Limrun instance is connected');
  }
  return udid;
}

function sameUdid(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Runs a `simctl` subcommand on the instance and fails on a nonzero exit. */
async function simctl(udid: string, args: string[], stdin?: string): Promise<{stdout: string; stderr: string}> {
  const result = await client(udid)
    .simctl(args, stdin === undefined ? {} : {stdin})
    .wait();
  if (result.code !== 0) {
    throw new Error(
      `simctl ${args[0]} failed with exit code ${result.code}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return {stdout: result.stdout, stderr: result.stderr};
}

async function simctlJson(udid: string, args: string[]): Promise<unknown> {
  return JSON.parse((await simctl(udid, args)).stdout);
}

function toPem(cert: string | Buffer): string {
  const text = Buffer.isBuffer(cert) ? cert.toString('utf8') : cert;
  if (text.includes('-----BEGIN CERTIFICATE-----')) {
    return text;
  }
  // A DER certificate: wrap its base64 in PEM armor.
  const der = Buffer.isBuffer(cert) ? cert : Buffer.from(cert, 'binary');
  const body =
    der
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

async function withTempFile<T>(name: string, content: string, fn: (p: string) => Promise<T>): Promise<T> {
  const dir = await tempDir.openDir();
  const file = path.join(dir, name);
  try {
    await fs.writeFile(file, content);
    return await fn(file);
  } finally {
    await fs.rimraf(dir);
  }
}

/**
 * A remote process shaped like coresim's `SpawnedProcess`. Its pid is 0 because
 * the process runs on the Limrun host; `kill` stops reading its output.
 */
class RemoteProcess extends EventEmitter {
  readonly pid = 0;
  readonly stdout = new PassThrough() as unknown as Socket;
  readonly stderr = new PassThrough() as unknown as Socket;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(private readonly stop: () => void) {
    super();
  }

  get running(): boolean {
    return this.exitCode === null && this.signalCode === null;
  }

  kill(): boolean {
    if (!this.running) {
      return false;
    }
    this.stop();
    this.finish(null, 'SIGTERM');
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.running) {
      return;
    }
    this.exitCode = code;
    this.signalCode = signal;
    (this.stdout as unknown as PassThrough).end();
    (this.stderr as unknown as PassThrough).end();
    this.emit('exit', code, signal);
  }
}

function simctlProcess(execution: Ios.SimctlExecution): RemoteProcess {
  const proc = new RemoteProcess(() => execution.stop());
  execution.on('stdout', (data: Buffer) => (proc.stdout as unknown as PassThrough).write(data));
  execution.on('stderr', (data: Buffer) => (proc.stderr as unknown as PassThrough).write(data));
  execution.on('exit', (code: number) => proc.finish(code, null));
  execution.on('error', (err: Error) => {
    (proc.stderr as unknown as PassThrough).write(`${err.message}\n`);
    proc.finish(1, null);
  });
  return proc;
}

function syslogProcess(instance: Ios.InstanceClient): RemoteProcess {
  const stream = instance.streamSyslog();
  const proc = new RemoteProcess(() => stream.stop());
  stream.on('line', (line: string) => (proc.stdout as unknown as PassThrough).write(`${line}\n`));
  stream.on('error', (err: Error) => {
    (proc.stderr as unknown as PassThrough).write(`${err.message}\n`);
    proc.finish(1, null);
  });
  stream.on('close', () => proc.finish(0, null));
  return proc;
}
