/**
 * `usePushClicked(callback)` — subscribe to push-tap events.
 *
 * ⚠️ **NOT WIRED IN 0.1.x.** Same caveat as `usePushReceived` — the
 * native emission layer is not implemented in v0.1.x. Subscribing
 * today registers a listener but the callback will never fire.
 * Wiring is planned for v0.2.0, blocked on Phase 9.2.1 observer APIs
 * in PYRXSynapse 0.1.2 / tech.pyrx.synapse 0.1.4.
 *
 * **Workaround until 0.2.0**: capture the tap in your AppDelegate
 * (`userNotificationCenter(_:didReceive:)`) on iOS / MainActivity
 * `onNewIntent` on Android and route to your own React state.
 *
 * Tracking issue:
 * https://github.com/PYRX-Tech/pyrx-synapse-react-native/issues/5
 *
 * ---
 *
 * Intended behaviour (when wired in 0.2.0):
 *
 * Fires the callback every time the user taps a push notification (or
 * an Android notification action). Bridges the native
 * `pyrx:push:click` event into a React subscription with the same
 * "ref-the-callback so we subscribe once per mount" pattern as
 * `usePushReceived`.
 *
 * For deep-link routing UX, prefer `useDeepLink()` which provides a
 * stateful `lastPushClick` snapshot that survives re-renders without
 * needing the caller to manage a state slot.
 */

import { useEffect, useRef } from 'react';

import { synapseEvents, type PushClickEvent } from '../events';
import { warnStubbedHook } from './__hookStubWarning';

export function usePushClicked(
  callback: (event: PushClickEvent) => void
): void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    warnStubbedHook('usePushClicked');
    const sub = synapseEvents.addListener('pyrx:push:click', (event) => {
      callbackRef.current(event);
    });
    return () => {
      sub.remove();
    };
  }, []);
}
