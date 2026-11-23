import type {Ios} from '@limrun/api';

/**
 * Limrun instance clients keyed by the udid of the simulator each one serves.
 *
 * The Limrun driver registers a client per session, and every simulator call
 * finds its client by udid. Keying by udid keeps concurrent sessions on
 * different instances apart in one Appium server.
 */
const clients = new Map<string, Ios.InstanceClient>();

/**
 * Registers the client that serves the simulator with the given udid.
 * A later registration for the same udid replaces the earlier one.
 */
export function registerLimrunClient(udid: string, client: Ios.InstanceClient): void {
  clients.set(key(udid), client);
}

/**
 * Forgets the client of the given udid when its session ends.
 *
 * Only the registered client is removed. A session that ends after a newer
 * session on the same instance registered its own client, such as an abandoned
 * session reaching its command timeout, leaves the newer client in place.
 */
export function unregisterLimrunClient(udid: string, client: Ios.InstanceClient): void {
  if (clients.get(key(udid)) === client) {
    clients.delete(key(udid));
  }
}

/**
 * Returns the client that serves the given udid.
 *
 * @throws {Error} If no Limrun session registered that udid
 */
export function limrunClientFor(udid: string): Ios.InstanceClient {
  const client = clients.get(key(udid));
  if (!client) {
    throw new Error(
      `No Limrun instance serves the simulator '${udid}'. ` +
        `Start the session with the limInstanceApiUrl and limInstanceToken capabilities.`,
    );
  }
  return client;
}

// Callers spell udids in either case; CoreSimulator prints them uppercase.
function key(udid: string): string {
  return udid.toUpperCase();
}

/** Lists the udids that have a registered client. */
export function limrunUdids(): string[] {
  return [...clients.keys()];
}

/**
 * Returns the most recently registered client, for calls that name no
 * simulator, such as the Xcode version.
 *
 * The Xcode helpers memoize their answers process-wide, so concurrent
 * sessions on hosts with different Xcode versions all see the first answer.
 *
 * @throws {Error} If no Limrun session is active
 */
export function anyLimrunClient(): Ios.InstanceClient {
  const all = [...clients.values()];
  const client = all[all.length - 1];
  if (!client) {
    throw new Error(
      'No Limrun instance is connected. ' +
        'Start the session with the limInstanceApiUrl and limInstanceToken capabilities.',
    );
  }
  return client;
}
