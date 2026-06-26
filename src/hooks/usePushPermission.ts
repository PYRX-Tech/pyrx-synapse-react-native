/**
 * `usePushPermission()` — read + request push permission.
 *
 * Returns the current OS push permission state plus a `request()` method
 * that triggers the OS prompt. Auto-refreshes the status after a
 * successful `request()` call so the rendered UI doesn't lag behind
 * what the OS already knows.
 *
 * On mount, the hook reads `getPushPermissionStatus()` (a non-prompting
 * read). The initial value is `'notDetermined'` so first paint doesn't
 * crash on `undefined`; it settles to the real value when the async
 * read resolves.
 *
 * Re-mounts are safe — the read is fire-and-forget, scoped to the
 * mounted state via a ref, and double-invocation under strict mode is
 * harmless (the read is idempotent).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Synapse,
  type PushPermissionOptions,
  type PushPermissionStatus,
} from '../Synapse';

export type UsePushPermissionReturn = {
  /** Current OS permission state. Defaults to `'notDetermined'` until the first read. */
  status: PushPermissionStatus;
  /** `true` while a read or request is in flight. */
  isPending: boolean;
  /** Trigger the OS push permission dialog. */
  request: (options?: PushPermissionOptions) => Promise<PushPermissionStatus>;
  /** Re-read the OS permission state without prompting. */
  refresh: () => Promise<PushPermissionStatus>;
};

export function usePushPermission(): UsePushPermissionReturn {
  const [status, setStatus] = useState<PushPermissionStatus>('notDetermined');
  const [isPending, setIsPending] = useState(true);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Calls bind directly to the `Synapse` namespace. We deliberately do
  // NOT depend on `useSynapse()` here because that hook's return is
  // identity-unstable across provider re-renders — and our `refresh`
  // effect would re-fire on every identity change, producing wasteful
  // double-reads of the OS permission state.
  const refresh = useCallback(async () => {
    setIsPending(true);
    try {
      const next = await Synapse.getPushPermissionStatus();
      if (isMountedRef.current) {
        setStatus(next);
      }
      return next;
    } finally {
      if (isMountedRef.current) {
        setIsPending(false);
      }
    }
  }, []);

  const request = useCallback(async (options?: PushPermissionOptions) => {
    setIsPending(true);
    try {
      const next = await Synapse.requestPushPermission(options);
      if (isMountedRef.current) {
        setStatus(next);
      }
      return next;
    } finally {
      if (isMountedRef.current) {
        setIsPending(false);
      }
    }
  }, []);

  // First-mount read. We deliberately don't depend on `refresh` here;
  // refresh's identity is stable across renders.
  useEffect(() => {
    // Fire-and-forget — `refresh` already handles errors internally
    // (status stays 'notDetermined' on failure). The `void` discards
    // the promise so React doesn't see a stale return value.
    // eslint-disable-next-line no-void
    void refresh();
  }, [refresh]);

  return { status, isPending, request, refresh };
}
