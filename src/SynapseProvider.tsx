/**
 * `<SynapseProvider>` — React context that wires the SDK into the app.
 *
 * Two responsibilities:
 *
 *   1. **Lifecycle.** Call `Synapse.initialize(config)` once when the
 *      provider mounts. Surfaces the init state (`pending` →
 *      `initialized` | `error`) so descendant hooks can react.
 *
 *   2. **Reactive identity snapshot.** Subscribes to internal init
 *      lifecycle so `useSynapse()` consumers re-render when identity
 *      changes. The provider does NOT poll — it relies on hooks
 *      refreshing via `refreshDebugInfo()` and re-reads after every
 *      mutation that affects identity (`identify`, `alias`, `logout`,
 *      `deleteUser`).
 *
 * SSR safety: the provider does NOT touch native modules at module load
 * time. The first call to `Synapse.initialize` runs inside `useEffect`,
 * which only runs client-side. Hosts that pre-render with React Server
 * Components or Next.js SSR can render the provider tree without
 * crashing on a missing TurboModule.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  Synapse,
  type SynapseInitConfig,
  type SynapseDebugInfo,
} from './Synapse';
import { SynapseError } from './SynapseError';

/**
 * Discriminator for the SDK lifecycle as observed from React.
 *
 *   - 'pending'      — initialize() in flight or not started yet
 *   - 'initialized'  — initialize() resolved; SDK is usable
 *   - 'error'        — initialize() rejected; `error` carries the reason
 */
export type SynapseStatus = 'pending' | 'initialized' | 'error';

/**
 * Snapshot value exposed by the context. Hooks read this and re-render
 * when any field changes (React handles that natively because we pass
 * a new object on every `setState`).
 */
export type SynapseContextValue = {
  /** Lifecycle status. */
  status: SynapseStatus;
  /** When `status === 'error'`, the reason. Always a `SynapseError`. */
  error: SynapseError | null;
  /** Latest debug-info snapshot, or `null` before the first read. */
  debugInfo: SynapseDebugInfo | null;
  /**
   * Re-fetch `Synapse.debugInfo()` and update `debugInfo`. Hooks call
   * this after identity-mutating operations so consumers see fresh
   * `externalId` / `anonymousId` values without polling.
   */
  refreshDebugInfo: () => Promise<SynapseDebugInfo | null>;
};

const DEFAULT_CONTEXT: SynapseContextValue = {
  status: 'pending',
  error: null,
  debugInfo: null,
  // The default refreshDebugInfo is a no-op so hooks called outside a
  // <SynapseProvider> don't crash — they get a quiet null instead.
  refreshDebugInfo: async () => null,
};

const SynapseContext = createContext<SynapseContextValue>(DEFAULT_CONTEXT);

/**
 * Hook to read the raw context. Most callers want the higher-level
 * `useSynapse()` from `./hooks/useSynapse` which merges this with the
 * imperative API; this hook is exported for advanced consumers that
 * only want lifecycle visibility.
 */
export function useSynapseContext(): SynapseContextValue {
  return useContext(SynapseContext);
}

export type SynapseProviderProps = {
  /** Initialization config; passed through to `Synapse.initialize`. */
  config: SynapseInitConfig;
  /**
   * Optional callback fired when initialization rejects. Useful for
   * routing the error to Sentry / Bugsnag / a toast. Defaults to a
   * `console.warn` so silent failures don't go unnoticed.
   */
  onError?: (err: SynapseError) => void;
  /**
   * Optional callback fired exactly once on successful initialization.
   * Customers commonly use this to run a "first-launch" `track('app.launched')`.
   */
  onInitialized?: () => void;
  children: ReactNode;
};

/**
 * The provider. Wrap your root with this:
 *
 *   <SynapseProvider config={{ workspaceId, apiKey, environment: 'production' }}>
 *     <App />
 *   </SynapseProvider>
 */
export function SynapseProvider({
  config,
  onError,
  onInitialized,
  children,
}: SynapseProviderProps): React.ReactElement {
  const [status, setStatus] = useState<SynapseStatus>('pending');
  const [error, setError] = useState<SynapseError | null>(null);
  const [debugInfo, setDebugInfo] = useState<SynapseDebugInfo | null>(null);

  // Track whether we've initialized in this provider instance so that
  // strict-mode double-invocation doesn't double-call initialize().
  // The native SDK is itself idempotent on identical configs, but
  // avoiding a redundant round-trip keeps the JS lifecycle clean.
  const initStartedRef = useRef(false);
  const isMountedRef = useRef(true);

  // Mirror the latest callbacks into refs so the init effect doesn't
  // re-run when callers pass inline closures. Re-running the effect
  // would re-trigger initialize() with the same config and re-fetch
  // debug info — wasteful, and noisier than necessary in logs.
  const onErrorRef = useRef(onError);
  const onInitializedRef = useRef(onInitialized);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    onInitializedRef.current = onInitialized;
  }, [onInitialized]);

  const refreshDebugInfo =
    useCallback(async (): Promise<SynapseDebugInfo | null> => {
      try {
        const info = await Synapse.debugInfo();
        if (isMountedRef.current) {
          setDebugInfo(info);
        }
        return info;
      } catch {
        // Failures here are non-fatal — debugInfo is observational.
        return null;
      }
    }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Run initialize() exactly once per provider instance. We deliberately
  // hash the config into the effect dep array so consumers who swap
  // workspaces (rare but supported) get a fresh init lifecycle.
  const configKey = useMemo(
    () =>
      `${config.workspaceId}|${config.apiKey}|${config.environment}|${config.baseUrl ?? ''}`,
    [config.workspaceId, config.apiKey, config.environment, config.baseUrl]
  );

  useEffect(() => {
    if (initStartedRef.current) {
      // Strict-mode re-invocation; bail.
      return;
    }
    initStartedRef.current = true;
    let cancelled = false;

    setStatus('pending');
    setError(null);

    (async () => {
      try {
        await Synapse.initialize(config);
        if (cancelled || !isMountedRef.current) {
          return;
        }
        setStatus('initialized');
        // Fire-and-forget the first debugInfo fetch so consumers have
        // anonymousId/externalId immediately after the provider settles.
        await refreshDebugInfo();
        if (cancelled || !isMountedRef.current) {
          return;
        }
        onInitializedRef.current?.();
      } catch (err) {
        if (cancelled || !isMountedRef.current) {
          return;
        }
        const synapseErr =
          err instanceof SynapseError
            ? err
            : new SynapseError('internal_error', String(err));
        setError(synapseErr);
        setStatus('error');
        if (onErrorRef.current) {
          onErrorRef.current(synapseErr);
        } else if (typeof console !== 'undefined') {
          console.warn(
            '[SynapseProvider] initialize() failed:',
            synapseErr.code,
            synapseErr.message
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      // Allow re-init when configKey changes — the next effect run
      // sees `initStartedRef.current === true` only because we set it;
      // we reset it here so a fresh dep run can start over.
      initStartedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- configKey covers the relevant config fields
  }, [configKey, refreshDebugInfo]);

  const value = useMemo<SynapseContextValue>(
    () => ({ status, error, debugInfo, refreshDebugInfo }),
    [status, error, debugInfo, refreshDebugInfo]
  );

  return (
    <SynapseContext.Provider value={value}>{children}</SynapseContext.Provider>
  );
}

/**
 * Internal export for hooks under `./hooks/`. Not part of the public
 * surface — hooks consume this directly to avoid re-entering the
 * `useSynapseContext` indirection layer.
 *
 * @internal
 */
export { SynapseContext };
