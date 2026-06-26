/**
 * Jest globals for `@pyrx/synapse-react-native` tests.
 *
 * Wires the two mocks every test in this suite relies on:
 *   1. The TurboModule at `../NativePyrxSynapse` is replaced with a
 *      jest-mock-backed fake (`createMockNative`).
 *   2. `react-native`'s `NativeEventEmitter` is replaced with our
 *      `MockNativeEventEmitter` which routes subscriptions through the
 *      shared listener registry.
 *
 * Both mocks are referenced by Jest's hoisted `jest.mock(...)` so the
 * test files do not need to set anything else up — they `import { ... }`
 * the production module and get the wired-mock surface for free.
 *
 * Per-test reset:
 *   - `mockNative` keeps its identity across tests; `resetAll()` swaps
 *     every method back to a fresh jest.fn with default behaviour so
 *     mock state (calls, queued resolutions) does NOT leak between
 *     tests. Production code observes the mutation because it imports
 *     the live default reference at module load.
 *   - The listener registry is cleared so subscriptions don't leak.
 */

import {
  createMockNative,
  emitNativeEvent,
  listenerCount,
  MockNativeEventEmitter,
  resetListeners,
  type MockNativeModule,
} from './mockNativeModule';

// Re-export helpers test files commonly need so they only have to
// import from one place.
export { emitNativeEvent, listenerCount };

/**
 * Singleton mocked TurboModule. Exposed for tests that need to inspect
 * call args directly: `expect(mockNative.identify).toHaveBeenCalledWith(...)`.
 *
 * The reference is stable; `resetAll()` mutates its methods in place.
 */
export const mockNative: MockNativeModule = createMockNative();

/**
 * Wires the TurboModule mock + the NativeEventEmitter mock at the
 * module-resolution level. Hoisted by Jest above all `import` statements
 * in any test file that imports from this helper.
 */
jest.mock('../../NativePyrxSynapse', () => ({
  __esModule: true,
  default: mockNative,
}));

// Replace the NativeEventEmitter constructor at its source path so the
// production `events.ts` (which does `import { NativeEventEmitter } from
// 'react-native'`) sees our mock. RN's top-level `index.js` re-exports
// this module's default, so the mock propagates without us having to
// patch the full `react-native` surface (which would crash on missing
// TurboModules like `DevMenu` in a Jest environment).
jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter', () => ({
  __esModule: true,
  default: MockNativeEventEmitter,
}));

/**
 * Re-bind every method on the singleton mock to a fresh `jest.fn` with
 * default behaviour, and clear all event listeners. Call from
 * `beforeEach` to keep tests independent.
 */
export function resetAll(): void {
  const fresh = createMockNative();
  const target = mockNative as unknown as Record<string, jest.Mock>;
  const source = fresh as unknown as Record<string, jest.Mock>;
  for (const key of Object.keys(fresh)) {
    const next = source[key];
    if (next !== undefined) {
      target[key] = next;
    }
  }
  resetListeners();
}
