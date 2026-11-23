import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {DeviceOrientation, SimDeviceState} from '@appium/coresim';
import type {Ios} from '@limrun/api';
import {registerLimrunClient, unregisterLimrunClient} from 'appium-xcode';

import {LimrunNativeSimctl, LimrunUnsupportedError, parseAsciiPlist} from '../../lib/limrun/index.js';

const UDID = 'D768CB90-CBB4-4557-82F6-B89E1CD0E80B';

// `simctl appinfo` output from an iOS 26 simulator, trimmed.
const SAFARI_APPINFO = `{
    ApplicationType = System;
    Bundle = "file:///Library/Developer/CoreSimulator/Volumes/iOS_23A343/Applications/MobileSafari.app/";
    CFBundleDisplayName = Safari;
    CFBundleIdentifier = "com.apple.mobilesafari";
    CFBundleName = Safari;
    DataContainer = "file:///Users/tenant/Devices/${UDID}/data/Containers/Data/Application/5F1/";
    GroupContainers =     {
        "group.com.apple.mobilesafari" = "file:///Users/tenant/Devices/${UDID}/data/Containers/Shared/AppGroup/9A2/";
    };
    Path = "/Library/Developer/CoreSimulator/Volumes/iOS_23A343/Applications/MobileSafari.app";
    SBAppTags =     (
    );
}`;

interface SimctlCall {
  args: string[];
  stdin?: string;
}

// Answers like a Limrun instance: simctl results come from `outputs`, keyed by subcommand.
class FakeInstance {
  calls: SimctlCall[] = [];
  actions: unknown[] = [];
  outputs: Record<string, {code?: number; stdout?: string; stderr?: string}> = {};
  syslog = new EventEmitter() as EventEmitter & {stop: () => void};
  stopped = false;

  constructor() {
    this.syslog.stop = () => {
      this.stopped = true;
    };
  }

  client(): Ios.InstanceClient {
    return {
      simctl: (args: string[], opts: {stdin?: string} = {}) => {
        this.calls.push({args, stdin: opts.stdin});
        const out = this.outputs[args[0]] ?? {};
        const execution = new EventEmitter() as EventEmitter & {wait: () => Promise<unknown>; stop: () => void};
        execution.wait = async () => ({code: out.code ?? 0, stdout: out.stdout ?? '', stderr: out.stderr ?? ''});
        execution.stop = () => {};
        setImmediate(() => {
          if (out.stdout) {
            execution.emit('stdout', Buffer.from(out.stdout));
          }
          execution.emit('exit', out.code ?? 0);
        });
        return execution;
      },
      listApps: async () => [
        {bundleId: 'com.apple.mobilesafari', name: 'Safari', installType: 'System', pid: 4242},
        {bundleId: 'com.example.app', name: 'Example', installType: 'User'},
      ],
      getDeviceInfo: async () => ({udid: UDID, orientation: 'landscapeLeft'}),
      getFoldState: async () => null,
      setOrientation: async (o: string) => {
        this.actions.push({setOrientation: o});
      },
      setPermission: async (bundleId: string, service: string, status: string) => {
        this.actions.push({setPermission: [bundleId, service, status]});
      },
      getPermission: async () => 'limited',
      performActions: async (actions: unknown[]) => {
        this.actions.push(...actions);
        return {results: []};
      },
      screenshot: async (opts: unknown) => {
        this.actions.push({screenshot: opts});
        return {base64: Buffer.from('png-bytes').toString('base64'), width: 1, height: 1};
      },
      lsof: async () => [
        {kind: 'unix', path: '/tmp/other.socket'},
        {kind: 'unix', path: `/private/tmp/com.apple.launchd.x/com.apple.webinspectord_sim.socket`},
      ],
      streamSyslog: () => this.syslog,
    } as unknown as Ios.InstanceClient;
  }
}

describe('parseAsciiPlist', function () {
  it('reads the appinfo output of simctl', function () {
    const info = parseAsciiPlist(SAFARI_APPINFO) as Record<string, any>;
    assert.equal(info.CFBundleIdentifier, 'com.apple.mobilesafari');
    assert.equal(info.ApplicationType, 'System');
    assert.deepEqual(info.SBAppTags, []);
    assert.match(info.GroupContainers['group.com.apple.mobilesafari'], /AppGroup\/9A2\/$/);
  });

  it('reads arrays and escapes', function () {
    assert.deepEqual(parseAsciiPlist('(\n    en,\n    "he-IL"\n)'), ['en', 'he-IL']);
    assert.equal(parseAsciiPlist('"a \\"b\\"\\n"'), 'a "b"\n');
  });

  it('rejects malformed input', function () {
    assert.throws(() => parseAsciiPlist('{ a = b'), /Expected ';'/);
  });
});

describe('LimrunNativeSimctl', function () {
  let instance: FakeInstance;
  let client: Ios.InstanceClient;
  let simctl: LimrunNativeSimctl;

  beforeEach(function () {
    instance = new FakeInstance();
    client = instance.client();
    registerLimrunClient(UDID, client);
    simctl = new LimrunNativeSimctl();
  });

  afterEach(function () {
    unregisterLimrunClient(UDID, client);
  });

  it('lists the instance simulator with its runtime', async function () {
    instance.outputs.list = {
      stdout: JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [
            {udid: UDID, name: 'iPhone 17', state: 'Booted', deviceTypeIdentifier: 'com.apple.x.iPhone-17'},
          ],
        },
      }),
    };
    assert.deepEqual(await simctl.getDevices(), [
      {
        udid: UDID,
        name: 'iPhone 17',
        state: SimDeviceState.Booted,
        deviceTypeIdentifier: 'com.apple.x.iPhone-17',
        runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-1',
      },
    ]);
    assert.deepEqual(instance.calls[0].args, ['list', 'devices', '-j']);
  });

  it('finds the client whatever the udid case', async function () {
    instance.outputs.pbpaste = {stdout: 'copied'};
    assert.equal(await simctl.getPasteboard(UDID.toLowerCase()), 'copied');
  });

  it('resolves app containers to paths on the Limrun host', async function () {
    instance.outputs.appinfo = {stdout: SAFARI_APPINFO};
    assert.match(await simctl.getAppContainer(UDID, 'com.apple.mobilesafari', 'data'), /Application\/5F1$/);
    assert.match(await simctl.getAppContainer(UDID, 'com.apple.mobilesafari', 'groups'), /AppGroup\/9A2$/);
    assert.equal(
      await simctl.getAppContainer(UDID, 'com.apple.mobilesafari'),
      '/Library/Developer/CoreSimulator/Volumes/iOS_23A343/Applications/MobileSafari.app',
    );
  });

  it('sends pasteboard content as stdin', async function () {
    await simctl.setPasteboard(UDID, 'hello ÆØÅ');
    assert.deepEqual(instance.calls[0], {args: ['pbcopy', UDID], stdin: 'hello ÆØÅ'});
  });

  it('reports a failed simctl command with its stderr', async function () {
    instance.outputs.location = {code: 1, stderr: 'Invalid coordinate'};
    await assert.rejects(
      simctl.setLocation(UDID, 91, 0),
      /simctl location failed with exit code 1: Invalid coordinate/,
    );
  });

  it('posts biometric matches through notifyutil', async function () {
    await simctl.sendBiometricMatch(UDID, false, 'faceId');
    assert.deepEqual(instance.calls[0].args, [
      'spawn',
      UDID,
      'notifyutil',
      '-p',
      'com.apple.BiometricKit_Sim.pearl.nomatch',
    ]);
  });

  it('sets and reads permissions on the instance', async function () {
    await simctl.grantPermission(UDID, 'faceid', 'com.example.app');
    await simctl.grantPermission(UDID, 'photos', 'com.example.app', 'limited');
    await simctl.revokePermission(UDID, 'notifications', 'com.example.app');
    await simctl.resetPermission(UDID, 'camera', 'com.example.app');
    assert.deepEqual(instance.actions, [
      {setPermission: ['com.example.app', 'faceid', 'granted']},
      {setPermission: ['com.example.app', 'photos', 'limited']},
      {setPermission: ['com.example.app', 'notifications', 'denied']},
      {setPermission: ['com.example.app', 'camera', 'unset']},
    ]);
    assert.equal(await simctl.getPermission(UDID, 'photos', 'com.example.app'), 'limited');
    await assert.rejects(simctl.getPermission(UDID, 'notifications', 'com.example.app'), /cannot be read/);
  });

  it('lists installed apps with their simctl properties', async function () {
    instance.outputs.listapps = {
      stdout: `{
    "com.apple.mobilesafari" =     {
        ApplicationType = System;
        CFBundleIdentifier = "com.apple.mobilesafari";
        CFBundleName = Safari;
    };
    "com.example.app" =     {
        ApplicationType = User;
        CFBundleIdentifier = "com.example.app";
        CFBundleName = Example;
        UIFileSharingEnabled = 1;
    };
}`,
    };
    const apps = await simctl.installedApps(UDID);
    assert.deepEqual(instance.calls[0].args, ['listapps', UDID]);
    assert.deepEqual(Object.keys(apps).sort(), ['com.apple.mobilesafari', 'com.example.app']);
    assert.deepEqual(apps['com.example.app'], {
      ApplicationType: 'User',
      CFBundleIdentifier: 'com.example.app',
      CFBundleName: 'Example',
      UIFileSharingEnabled: '1',
    });
  });

  it('reports running apps as processes', async function () {
    assert.deepEqual(await simctl.listProcesses(UDID), [
      {pid: 4242, group: 'UIKitApplication', name: 'com.apple.mobilesafari'},
    ]);
  });

  it('maps the interface orientation by name', async function () {
    assert.equal(await simctl.getOrientation(UDID), DeviceOrientation.LandscapeLeft);
    await simctl.setOrientation(UDID, DeviceOrientation.LandscapeRight);
    await simctl.setOrientation(UDID, DeviceOrientation.PortraitUpsideDown);
    assert.deepEqual(instance.actions, [{setOrientation: 'LandscapeRight'}, {setOrientation: 'PortraitUpsideDown'}]);
  });

  it('presses any HID usage on the instance', async function () {
    await simctl.pressHidButton(UDID, 12, 111, 0.2);
    assert.deepEqual(instance.actions, [
      {type: 'usageDown', usagePage: 12, usage: 111},
      {type: 'wait', durationMs: 200},
      {type: 'usageUp', usagePage: 12, usage: 111},
    ]);
  });

  it('takes full-size PNG screenshots by default', async function () {
    assert.equal((await simctl.getScreenshot(UDID)).toString(), 'png-bytes');
    assert.deepEqual(instance.actions, [{screenshot: {format: 'png', size: 'full'}}]);
  });

  it('returns the Web Inspector socket path on the host', async function () {
    assert.match(await simctl.getWebInspectorSocket(UDID), /com\.apple\.webinspectord_sim\.socket$/);
  });

  it('runs defaults in the simulator by its bare name', async function () {
    const proc = await simctl.spawnProcess(UDID, '/usr/bin/defaults', {
      arguments: ['/usr/bin/defaults', 'write', 'com.apple.Preferences', 'a', '1'],
    });
    const [code] = await once(proc, 'exit');
    assert.equal(code, 0);
    assert.deepEqual(instance.calls[0].args, ['spawn', UDID, 'defaults', 'write', 'com.apple.Preferences', 'a', '1']);
  });

  it('streams the syslog for log stream and stops it on kill', async function () {
    const proc = await simctl.spawnProcess(UDID, '/usr/bin/log', {
      arguments: ['/usr/bin/log', 'stream', '--style', 'compact'],
    });
    const chunks: string[] = [];
    proc.stdout.on('data', (c: Buffer) => chunks.push(c.toString()));
    instance.syslog.emit('line', 'first line');
    await new Promise((r) => setImmediate(r));
    assert.equal(chunks.join(''), 'first line\n');
    assert.ok(proc.running);
    assert.ok(proc.kill());
    assert.ok(instance.stopped);
    assert.equal(proc.running, false);
  });

  it('refuses to run other tools in the simulator', async function () {
    await assert.rejects(
      simctl.spawnProcess(UDID, '/bin/launchctl', {arguments: ['/bin/launchctl', 'stop', 'x']}),
      /Running '\/bin\/launchctl' in the simulator is not supported on Limrun simulators/,
    );
  });

  it('refuses device lifecycle changes', async function () {
    await assert.rejects(simctl.eraseDevice(UDID), LimrunUnsupportedError);
    await assert.rejects(simctl.shutdownDevice(UDID), LimrunUnsupportedError);
    await assert.rejects(simctl.createDevice(), LimrunUnsupportedError);
  });
});
