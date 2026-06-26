/**
 * `useIdentify()` — call `Synapse.identify` when the user's id changes.
 *
 * Two return shapes are supported via overloads:
 *
 *   1. **Imperative shape**: `const { identify, isIdentified, externalId } = useIdentify()`.
 *      The hook returns an `identify(...)` callback; the caller decides
 *      when to call it. Useful when identity changes are triggered by
 *      explicit events (sign-in / sign-up).
 *
 *   2. **Auto-identify shape**: `useIdentify(userId, traits?)`. The hook
 *      calls `Synapse.identify(userId, traits)` automatically whenever
 *      `userId` changes (and once on first non-null mount). `traits`
 *      changes are detected via a JSON.stringify dep — fine for the
 *      small bags (<20 keys) typical of identity trait sets, expensive
 *      for huge objects (don't pass those).
 *
 * Skipped scenarios:
 *   - Initial mount with `userId === null` / `undefined` — no call.
 *   - `userId` changes from "alice" to "alice" — no call (referentially
 *     equal).
 *   - SDK is not initialized yet — the call is queued in the native
 *     SDK's identity manager (the native SDKs already buffer this).
 *
 * Errors from `identify` are surfaced via the optional `onError`
 * callback; if no callback is provided, errors are silently swallowed
 * to avoid uncaught-promise warnings in dev (the call is fire-and-forget
 * by design when the caller didn't ask for the result).
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  Synapse,
  type SynapseProperties,
  type SynapseIdentifyResult,
} from '../Synapse';
import { SynapseError } from '../SynapseError';
import { useSynapse } from './useSynapse';

export type UseIdentifyOptions = {
  /** Fired when the hook's auto-identify call rejects. Optional. */
  onError?: (err: SynapseError) => void;
};

export type UseIdentifyReturn = {
  /**
   * Imperatively call `identify`. Mirrors `Synapse.identify` plus the
   * provider's debug-info refresh (see `useSynapse`).
   */
  identify: (
    externalId: string,
    traits?: SynapseProperties
  ) => Promise<SynapseIdentifyResult>;
  /** Whether the SDK currently has a known external identity. */
  isIdentified: boolean;
  /** The current external identity, or `null`. */
  externalId: string | null;
  /** The current anonymous identity. */
  anonymousId: string | null;
};

/**
 * Imperative form — caller controls when to identify.
 */
export function useIdentify(): UseIdentifyReturn;
/**
 * Auto-identify form — hook calls `identify` when `userId` changes.
 * Passing `userId = null` skips the call (e.g. signed-out state).
 */
export function useIdentify(
  userId: string | null | undefined,
  traits?: SynapseProperties,
  options?: UseIdentifyOptions
): UseIdentifyReturn;
export function useIdentify(
  userId?: string | null,
  traits?: SynapseProperties,
  options?: UseIdentifyOptions
): UseIdentifyReturn {
  const synapse = useSynapse();

  // Auto-identify behaviour: fire identify() when userId or traits change.
  // Compare against a ref of the last call so we don't re-emit on every
  // render. Traits dep tracked via JSON.stringify; acceptable for the
  // typical small trait bag, documented in the hook header.
  const lastCalledRef = useRef<{ userId: string; traitsKey: string } | null>(
    null
  );
  const onErrorRef = useRef(options?.onError);
  useEffect(() => {
    onErrorRef.current = options?.onError;
  }, [options?.onError]);

  // Mirror the latest refreshDebugInfo into a ref so the auto-identify
  // effect can call it without depending on the provider's identity-
  // unstable return object.
  const refreshDebugInfoRef = useRef(synapse.refreshDebugInfo);
  useEffect(() => {
    refreshDebugInfoRef.current = synapse.refreshDebugInfo;
  }, [synapse.refreshDebugInfo]);

  const traitsKey = useMemo(() => {
    if (traits === undefined) {
      return '';
    }
    try {
      return JSON.stringify(traits);
    } catch {
      return '__unserializable__';
    }
  }, [traits]);

  useEffect(() => {
    // Skip auto-call when in imperative-form (userId omitted entirely).
    if (userId === undefined) {
      return;
    }
    if (userId === null || userId === '') {
      // Explicit signed-out state — clear the last-call memory so a
      // subsequent transition back to a real id triggers the call.
      lastCalledRef.current = null;
      return;
    }

    const last = lastCalledRef.current;
    if (last && last.userId === userId && last.traitsKey === traitsKey) {
      return;
    }

    lastCalledRef.current = { userId, traitsKey };

    // Fire-and-forget — caller didn't ask for the result and we route
    // errors through onError. The `void` discards the promise.
    //
    // We bind directly to `Synapse.identify` (not `synapse.identify`)
    // so the effect dep list stays stable — `useSynapse()` returns a
    // fresh object identity each render, which would otherwise force
    // an extra dep entry that re-fires identify on every parent
    // re-render. The trade-off: we don't get the `useSynapse`
    // auto-refresh of debugInfo from this code path. We refresh
    // manually below to compensate.
    // eslint-disable-next-line no-void
    void Synapse.identify(userId, traits)
      .then(() => {
        // Mirror useSynapse's post-identify refresh so consumers of
        // this hook still see fresh externalId / anonymousId.
        return refreshDebugInfoRef.current();
      })
      .catch((err) => {
        const synapseErr =
          err instanceof SynapseError
            ? err
            : new SynapseError('internal_error', String(err));
        onErrorRef.current?.(synapseErr);
      });
    // We intentionally omit `traits` from the deps — `traitsKey` is
    // the stable hash that represents it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, traitsKey]);

  // Bind the imperative `identify` to the useSynapse-wrapped one so
  // explicit imperative calls (caller-driven sign-in flows) still get
  // the auto-refresh side effect.
  const identify = useCallback(
    (externalId: string, identifyTraits?: SynapseProperties) =>
      synapse.identify(externalId, identifyTraits),
    [synapse]
  );

  return {
    identify,
    isIdentified: synapse.externalId !== null && synapse.externalId !== '',
    externalId: synapse.externalId,
    anonymousId: synapse.anonymousId,
  };
}
