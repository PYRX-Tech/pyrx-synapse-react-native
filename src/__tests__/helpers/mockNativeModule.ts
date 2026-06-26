/**
 * Shared mock fixtures for the PYRX TurboModule + native event emitter.
 *
 * This file does NOT install the mock — Jest's `jest.mock(...)` calls
 * hoist above imports, so each test file owns its own `jest.mock`
 * declaration referencing this module's exports. The factory + emit
 * helpers live here so every test file shares the same shape.
 *
 * Usage in a test file:
 *
 *   import {
 *     createMockNative,
 *     emitNativeEvent,
 *     resetNativeMock,
 *   } from './helpers/mockNativeModule';
 *
 *   jest.mock('../NativePyrxSynapse', () => ({
 *     __esModule: true,
 *     default: createMockNative(),
 *   }));
 *
 *   jest.mock('react-native', () => {
 *     const Real = jest.requireActual('react-native');
 *     return { ...Real, NativeEventEmitter: MockedEmitter };
 *   });
 */

import type { Spec as TurboSpec } from '../../NativePyrxSynapse';

export type Listener = (payload: unknown) => void;
export type MockNativeModule = { [K in keyof TurboSpec]: jest.Mock };

/**
 * Shared listener registry. Indexed by event name. The mocked
 * NativeEventEmitter writes here; `emitNativeEvent` fans out from
 * here.
 */
export const listeners: Map<string, Set<Listener>> = new Map();

/**
 * Construct a fresh mock TurboModule with sensible defaults. Each test
 * can override individual method behaviours via the standard
 * `mockNative.identify.mockResolvedValueOnce(...)` pattern.
 */
export function createMockNative(): MockNativeModule {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    setLogLevel: jest.fn().mockResolvedValue(undefined),
    debugInfo: jest.fn().mockResolvedValue({
      initialized: true,
      anonymousId: 'anon-default',
      externalId: null,
      hasDeviceToken: false,
      queueDepth: 0,
      sdkVersion: '0.1.0',
      sdkPlatform: 'jest+rn',
      trackingEnabled: true,
    }),
    identify: jest.fn().mockResolvedValue({
      contactId: 'contact-default',
      path: 'no_anonymous',
      aliasedExternalId: null,
      eventsReattributed: 0,
      devicesReattributed: 0,
      anonymousContactTombstoned: false,
    }),
    alias: jest.fn().mockResolvedValue({
      contactId: 'contact-default',
      path: 'known_exists',
      aliasedExternalId: null,
      eventsReattributed: 0,
      devicesReattributed: 0,
      anonymousContactTombstoned: false,
    }),
    logout: jest.fn().mockResolvedValue(undefined),
    track: jest.fn().mockResolvedValue(undefined),
    screen: jest.fn().mockResolvedValue(undefined),
    requestPushPermission: jest.fn().mockResolvedValue('granted'),
    getPushPermissionStatus: jest.fn().mockResolvedValue('notDetermined'),
    setTrackingEnabled: jest.fn().mockResolvedValue(undefined),
    deleteUser: jest.fn().mockResolvedValue(undefined),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
}

/**
 * Mocked `NativeEventEmitter` constructor. Mirrors RN's public surface
 * (`addListener` returns a subscription with `.remove()`) and routes
 * registrations into the shared `listeners` map so tests can synthesise
 * events via `emitNativeEvent`.
 */
export class MockNativeEventEmitter {
  // Constructor argument intentionally accepted-and-ignored; the real
  // RN class takes the native module here for bookkeeping. The mock
  // module is wired via the shared `listeners` registry instead.
  constructor(_module?: unknown) {
    // No-op; bookkeeping shared across instances.
  }

  addListener(eventName: string, listener: Listener): { remove: () => void } {
    let set = listeners.get(eventName);
    if (!set) {
      set = new Set();
      listeners.set(eventName, set);
    }
    set.add(listener);
    return {
      remove: () => {
        listeners.get(eventName)?.delete(listener);
      },
    };
  }

  removeAllListeners(eventName: string): void {
    listeners.delete(eventName);
  }
}

/**
 * Synthesise a native-side event delivery. Calls every listener
 * registered for the event name.
 */
export function emitNativeEvent(eventName: string, payload: unknown): void {
  const set = listeners.get(eventName);
  if (!set) {
    return;
  }
  // Snapshot iteration so `.remove()` calls inside a handler don't
  // disturb the active fan-out.
  for (const listener of Array.from(set)) {
    listener(payload);
  }
}

/**
 * Reset the listener registry. Call in `afterEach` to prevent state
 * leaks between tests.
 */
export function resetListeners(): void {
  listeners.clear();
}

/**
 * Count currently-registered listeners. Optional event-name filter.
 * Useful for "no leaked subscriptions after unmount" assertions.
 */
export function listenerCount(eventName?: string): number {
  if (eventName === undefined) {
    let total = 0;
    for (const set of listeners.values()) {
      total += set.size;
    }
    return total;
  }
  return listeners.get(eventName)?.size ?? 0;
}
