/**
 * `usePushReceivedColdStart(callback)` — subscribe to cold-start push
 * launches.
 *
 * Fires the callback when the app was launched by the OS to deliver a
 * tapped notification (cold-start path). This is distinct from
 * `usePushClicked` so consumer routing logic can branch on "did we
 * come from a push tap" vs "the app was already alive and got a push
 * tap".
 *
 * Mutual exclusion with `usePushClicked`
 * --------------------------------------
 * The native SDKs publish ONE of these events per user tap, never both:
 *   - Cold-start tap (OS launched the app)  → `pushReceivedColdStart`
 *   - Warm-start tap (app already alive)    → `pushClicked`
 *
 * The mutual exclusion is enforced via a 5-second LRU on `push_log_id`
 * in the native push handlers. Consumers can rely on the invariant
 * without writing their own dedup.
 *
 * Cold-start race + replay buffer
 * -------------------------------
 * On a cold-start launch, the native event fires AFTER `Pyrx.initialize`
 * completes — which is typically ~200ms after process launch. The JS
 * RN bridge usually mounts within 1-2s of process launch and the first
 * `usePushReceivedColdStart` subscribe arrives shortly after. Either
 * order is OK: the native SDKs keep a replay buffer of the most-recent
 * 4 events, so a late JS subscriber still receives the buffered cold-
 * start event.
 *
 * Subscribe at the EARLIEST point in your component tree (e.g., your
 * `App.tsx` or your navigation root, NOT inside a deferred screen) to
 * minimize the race window.
 *
 * Payload shape is identical to `pyrx:push:received` —
 * [PushReceivedEvent] / [PushReceivedColdStartEvent]. The
 * distinguishing signal is the EVENT NAME, not a payload field. To
 * route, inspect the `pyrxAttrs.deep_link` field on the event payload.
 *
 * Available since 0.2.0. Did not exist in 0.1.x.
 */

import { useEffect, useRef } from 'react';

import { synapseEvents, type PushReceivedColdStartEvent } from '../events';

export function usePushReceivedColdStart(
  callback: (event: PushReceivedColdStartEvent) => void
): void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const sub = synapseEvents.addListener(
      'pyrx:push:received-cold-start',
      (event) => {
        callbackRef.current(event);
      }
    );
    return () => {
      sub.remove();
    };
  }, []);
}
