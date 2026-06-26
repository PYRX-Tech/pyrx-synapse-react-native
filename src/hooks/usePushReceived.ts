/**
 * `usePushReceived(callback)` — subscribe to foreground push deliveries.
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
    const sub = synapseEvents.addListener('pyrx:push:received', (event) => {
      callbackRef.current(event);
    });
    return () => {
      sub.remove();
    };
  }, []);
}
