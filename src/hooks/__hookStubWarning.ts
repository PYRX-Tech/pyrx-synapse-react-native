/**
 * @internal
 *
 * One-time `console.warn` helper for hooks whose native side isn't yet
 * wired. Logs at most once per hook name per process so customers see
 * the warning at integration time without console spam on every render.
 *
 * Tracking: https://github.com/PYRX-Tech/pyrx-synapse-react-native/issues/5
 * — see the "Wire native push event emission (Phase 9.2.1)" issue for the
 * implementation tracker.
 */

const warned = new Set<string>();

export function warnStubbedHook(hookName: string): void {
  if (warned.has(hookName)) return;
  warned.add(hookName);
  if (typeof console === 'undefined') return;
  console.warn(
    `[@pyrx/synapse-react-native] ${hookName} is NOT WIRED in 0.1.x. ` +
      'Subscribing registers a listener but the callback will never fire ' +
      'until 0.2.0 ships native push-event emission. ' +
      'See https://github.com/PYRX-Tech/pyrx-synapse-react-native/issues/5 for tracking.'
  );
}
