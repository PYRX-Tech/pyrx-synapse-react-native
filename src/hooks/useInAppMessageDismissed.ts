/**
 * `useInAppMessageDismissed(handler)` — observer for in-app
 * dismissals.
 *
 * Fires the handler when `Synapse.inApp.dismiss(messageId, reason?)`
 * is called — host-initiated OR (in future SDK versions) automatic
 * (expiry-driven). The handler receives the assignment id and the
 * host-supplied reason (or `null` if none was provided).
 *
 * Why this hook exists
 * --------------------
 * Same rationale as the browser SDK's `inAppMessageDismissed`
 * observer event: analytics middleware that wants to track every
 * in-app dismissal (regardless of which component issued the
 * `dismiss(...)` call) needs a single subscription point. Without
 * this hook you'd have to intercept every `Synapse.inApp.dismiss(...)`
 * call site, which is brittle.
 *
 * Subscription lifecycle:
 *   - Subscribes on mount; unsubscribes on unmount.
 *   - Callback identity changes do NOT trigger re-subscription.
 *
 * Multiple components calling `useInAppMessageDismissed` each get
 * their own listener token.
 *
 * Per ADR-0008 D2 the `reason` is observer-only — it does NOT cross
 * the wire on the backend `/v1/in-app/log` POST.
 *
 * Available since 0.3.0.
 *
 * @example
 *   useInAppMessageDismissed((messageId, reason) => {
 *     analytics.track('in_app_dismissed', { messageId, reason });
 *   });
 */

import { useEffect, useRef } from 'react';

import { synapseEvents } from '../events';

export function useInAppMessageDismissed(
  handler: (messageId: string, reason: string | null) => void
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const sub = synapseEvents.addListener(
      'pyrx:in-app:dismissed',
      (payload) => {
        handlerRef.current(payload.messageId, payload.reason);
      }
    );
    return () => {
      sub.remove();
    };
  }, []);
}
