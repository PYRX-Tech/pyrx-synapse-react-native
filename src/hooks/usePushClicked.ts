/**
 * `usePushClicked(callback)` — subscribe to push-tap events.
 *
 * Fires the callback every time the user taps a push notification (or
 * an Android notification action) while the app is alive. Bridges the
 * native `pyrx:push:click` event into a React subscription with the
 * same "ref-the-callback so we subscribe once per mount" pattern as
 * `usePushReceived`.
 *
 * Cold-start mutual exclusion
 * ---------------------------
 * Does NOT fire when the tap LAUNCHED the app from terminated state —
 * those publish `pyrx:push:received-cold-start` instead. The native
 * SDKs debounce by `push_log_id` over a 5-second window so warm-start
 * delivery of a cold-started push doesn't double-fire as both.
 * Use `usePushReceivedColdStart` to handle that case.
 *
 * For deep-link routing UX, prefer `useDeepLink()` which provides a
 * stateful `lastPushClick` snapshot that survives re-renders without
 * needing the caller to manage a state slot.
 *
 * Available since 0.2.0. In 0.1.x this hook registered a listener but
 * the callback never fired; in 0.2.0 it works as documented.
 */

import { useEffect, useRef } from 'react';

import { synapseEvents, type PushClickEvent } from '../events';

export function usePushClicked(
  callback: (event: PushClickEvent) => void
): void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const sub = synapseEvents.addListener('pyrx:push:click', (event) => {
      callbackRef.current(event);
    });
    return () => {
      sub.remove();
    };
  }, []);
}
