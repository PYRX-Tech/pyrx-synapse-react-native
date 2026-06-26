/**
 * `usePushClicked(callback)` — subscribe to push-tap events.
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
