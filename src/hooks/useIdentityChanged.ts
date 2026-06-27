/**
 * `useIdentityChanged(callback)` — subscribe to identity transitions.
 *
 * Fires the callback when the SDK's resolved identity changes via
 * `identify`, `alias`, or `logout`. The payload carries `before` and
 * `after` snapshots so consumers can detect the kind of transition:
 *
 *   - **Login**:  `before?.externalId == null && after.externalId != null`
 *   - **Logout**: `before?.externalId != null && after.externalId == null`
 *   - **Switch**: both non-null AND different `externalId`s (rare —
 *                  usual pattern is logout-then-identify, not direct
 *                  switch).
 *
 * `before` is `null` ONLY on the very first identify after a fresh
 * install (no prior identity state recorded). Otherwise both snapshots
 * are always non-null.
 *
 * Why this hook exists
 * --------------------
 * Dashboard-style apps need to refetch user data on login state change.
 * Without this hook, you'd poll `useIdentify` in a `useEffect`:
 *
 *   const { isIdentified, externalId } = useIdentify();
 *   useEffect(() => {
 *     if (isIdentified) refetchUserProfile(externalId);
 *   }, [isIdentified, externalId]);
 *
 * That works but couples the side effect to render frequency. With
 * `useIdentityChanged` you react ONLY to actual transitions, not to
 * re-renders that happen to recompute the same `useIdentify` shape:
 *
 *   useIdentityChanged(({ before, after }) => {
 *     if (before?.externalId !== after.externalId) {
 *       refetchUserProfile(after.externalId);
 *     }
 *   });
 *
 * Subscription lifecycle
 * ----------------------
 * Subscribes on mount; unsubscribes on unmount. The callback identity
 * may change between renders — we hold the latest in a ref so the
 * native subscription is established exactly once per mount.
 *
 * Multiple components calling `useIdentityChanged` simultaneously each
 * get their own listener token.
 *
 * Available since 0.2.0. Did not exist in 0.1.x.
 */

import { useEffect, useRef } from 'react';

import { synapseEvents, type IdentityChangedEvent } from '../events';

export function useIdentityChanged(
  callback: (event: IdentityChangedEvent) => void
): void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const sub = synapseEvents.addListener('pyrx:identity:changed', (event) => {
      callbackRef.current(event);
    });
    return () => {
      sub.remove();
    };
  }, []);
}
