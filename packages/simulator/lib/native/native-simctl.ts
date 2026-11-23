import type {NativeSimctl} from '@appium/coresim';

import {LimrunNativeSimctl} from '../limrun/native-simctl.js';

/**
 * Builds the simulator driver for the given device set path.
 *
 * This fork drives simulators on Limrun instances, so it always returns the
 * Limrun backend. coresim's native binding would look for the simulator on
 * this machine, where it does not exist.
 *
 * @param bulletinBoardVersions - the notifications store versions supported by the simulator class,
 * see `SimulatorXcode15.bulletinBoardVersions`; all the known ones by default.
 */
export function createNativeSimctl(
  deviceSetPath?: string | null,
  bulletinBoardVersions?: readonly number[],
): NativeSimctl {
  return new LimrunNativeSimctl({
    deviceSetPath: deviceSetPath ?? undefined,
    bulletinBoardVersions,
  }) as unknown as NativeSimctl;
}

/** Whether the given driver is the Limrun backend. Always true in this fork. */
export function isLimrun(nativeSimctl: NativeSimctl): boolean {
  return (nativeSimctl as unknown) instanceof LimrunNativeSimctl;
}
