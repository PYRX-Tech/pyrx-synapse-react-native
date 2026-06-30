/**
 * `useInAppMessageReceived(callback)` — global observer for fresh
 * in-app messages.
 *
 * Fires the callback every time the native SDK publishes a NEW
 * in-app message, REGARDLESS of which placement matched. Use this
 * for cross-cutting concerns that need to react to every in-app
 * delivery (analytics middleware, debug overlays, RUM-style logging)
 * without registering a per-placement render callback.
 *
 * Distinct from `useInAppMessage`:
 *
 *   - `useInAppMessage(placement, cb)` — placement-scoped; the
 *     callback fires for ONE placement's messages. The native side
 *     uses the registration to gate polling per lifecycle rule 1+2.
 *
 *   - `useInAppMessageReceived(cb)` — global; fires for EVERY new
 *     message globally. Does NOT register any placement with the
 *     native polling loop (so a tree that only uses this hook
 *     receives nothing — at least one `useInAppMessage(...)` or
 *     `Synapse.inApp.show(...)` must be active for the SDK to poll).
 *
 * Subscription lifecycle:
 *   - Subscribes on mount; unsubscribes on unmount.
 *   - Callback identity changes do NOT trigger re-subscription — the
 *     hook holds the latest callback in a ref.
 *
 * Multiple components calling `useInAppMessageReceived` each get
 * their own listener token. Removing one does not affect siblings.
 *
 * Available since 0.3.0.
 */

import { useEffect, useRef } from 'react';

import { synapseEvents, type InAppMessageReceivedEvent } from '../events';

export function useInAppMessageReceived(
  callback: (message: InAppMessageReceivedEvent) => void
): void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const sub = synapseEvents.addListener('pyrx:in-app:received', (message) => {
      callbackRef.current(message);
    });
    return () => {
      sub.remove();
    };
  }, []);
}
