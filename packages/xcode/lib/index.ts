import {getPath, getVersion, getMaxIOSSDK, getMaxTVOSSDK, getClangVersion} from './xcode.js';

const xcode = {
  getPath,
  getVersion,
  getMaxIOSSDK,
  getMaxTVOSSDK,
  getClangVersion,
};

export {getPath, getVersion, getMaxIOSSDK, getMaxTVOSSDK, getClangVersion};
export default xcode;

export type {XcodeVersion} from './types.js';
export {registerLimrunClient, unregisterLimrunClient, limrunClientFor, limrunUdids, anyLimrunClient} from './limrun.js';
