/**
 * `usePushReceived(callback)` — subscribe to foreground push deliveries.
 *
 * ⚠️ **NOT WIRED IN 0.1.x.** The native push event emission layer is
 * not yet implemented. Subscribing today registers a listener but the
 * callback will never fire. The native iOS + Android SDKs currently
 * expose only imperative `handle*` methods for push processing — no
 * observer / delegate / Combine / Flow surface for an external
 * subscriber to attach to. Wiring is planned for v0.2.0, blocked on
 * Phase 9.2.1 which adds observer APIs to `PYRXSynapse 0.1.2` and
 * `tech.pyrx.synapse:synapse-{core,push}:0.1.4`.
 *
 * **Workaround until 0.2.0**: capture push events in your AppDelegate
 * (iOS) / MainActivity + FirebaseMessagingService (Android) directly
 * and route them to your own React state. See `docs/INSTALL-BARE.md`
 * for the native-level hook points.
 *
 * Tracking issue:
 * https://github.com/PYRX-Tech/pyrx-synapse-react-native/issues/5
 *
 * ---
 *
 * Intended behaviour (when wired in 0.2.0):
 *
 * Fires the callback every time the native side emits `pyrx:push:received`,
 * which happens when a push is delivered to the app while it is in the
 * foreground. (Background pushes are processed natively and do not
 * surface to JS — they only show up as `pyrx:push:click` events when
 * the user taps them.)
 *
 * Subscription lifecycle:
 *   - Subscribes on mount; unsubscribes on unmount.
 *   - Re-subscribes if the callback identity changes — but because we
 *     hold the latest callback in a ref, the actual native subscription
 *     is established exactly once per mount. This avoids the
 *     "re-subscribe storm" some hook designs cause when callers pass
 *     inline arrow functions.
 *
 * Multiple components calling `usePushReceived` simultaneously each get
 * their own listener token. Removing one does not affect siblings.
 */

import { useEffect, useRef } from 'react';

import { synapseEvents, type PushReceivedEvent } from '../events';
import { warnStubbedHook } from './__hookStubWarning';

export function usePushReceived(
  callback: (event: PushReceivedEvent) => void
): void {
  // Hold the latest callback in a ref so the native subscription is
  // established only once per mount; new callback references don't
  // trigger re-subscription.
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    warnStubbedHook('usePushReceived');
    const sub = synapseEvents.addListener('pyrx:push:received', (event) => {
      callbackRef.current(event);
    });
    return () => {
      sub.remove();
    };
  }, []);
}
