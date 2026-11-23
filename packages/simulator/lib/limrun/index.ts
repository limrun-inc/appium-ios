export {LimrunNativeSimctl, LimrunUnsupportedError} from './native-simctl.js';
export {parseAsciiPlist} from './ascii-plist.js';

/**
 * Whether this simulator runs on a Limrun instance. Always true in this fork.
 *
 * Local-only code paths start with this guard instead of being deleted, so
 * upstream changes to them still merge cleanly.
 */
export function isLimrunSimulator(): boolean {
  return true;
}
