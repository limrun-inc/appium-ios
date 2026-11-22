import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';

import type {Ios} from '@limrun/api';

import {
  anyLimrunClient,
  getMaxIOSSDK,
  getPath,
  getVersion,
  limrunClientFor,
  registerLimrunClient,
  unregisterLimrunClient,
} from '../../lib/index.js';

// A client that answers like a Limrun host running Xcode 26.1 with the iOS 26.1 SDK.
function fakeClient(): Ios.InstanceClient {
  return {
    xcodebuild: async (args: string[]) => {
      assert.deepEqual(args, ['-version']);
      return {stdout: 'Xcode 26.1\nBuild version 17B55\n', stderr: '', exitCode: 0};
    },
    xcrun: async (args: string[]) => {
      assert.deepEqual(args, ['--sdk', 'iphonesimulator', '--show-sdk-version']);
      return {stdout: '26.1\n', stderr: '', exitCode: 0};
    },
  } as unknown as Ios.InstanceClient;
}

describe('limrun', function () {
  afterEach(function () {
    unregisterLimrunClient('udid-a');
    unregisterLimrunClient('udid-b');
  });

  it('finds each client by the udid it serves', function () {
    const a = fakeClient();
    const b = fakeClient();
    registerLimrunClient('udid-a', a);
    registerLimrunClient('udid-b', b);
    assert.equal(limrunClientFor('udid-a'), a);
    assert.equal(limrunClientFor('udid-b'), b);
    assert.equal(anyLimrunClient(), b);
  });

  it('fails loudly for a udid no session registered', function () {
    assert.throws(() => limrunClientFor('udid-a'), /No Limrun instance serves the simulator 'udid-a'/);
    assert.throws(() => anyLimrunClient(), /No Limrun instance is connected/);
  });

  it('reads the Xcode version and SDK from the Limrun host', async function () {
    registerLimrunClient('udid-a', fakeClient());
    const version = await getVersion(true);
    assert.equal(version.versionString, '26.1');
    assert.equal(version.major, 26);
    assert.equal(await getMaxIOSSDK(), '26.1');
  });

  it('reports that the developer path is unavailable', async function () {
    registerLimrunClient('udid-a', fakeClient());
    await assert.rejects(getPath(), /not available on Limrun simulators/);
  });
});
