/**
 * `useSynapse()` — primary hook.
 *
 * Returns a single object that combines:
 *
 *   - **Lifecycle state** from `<SynapseProvider>` (status, error,
 *     debug info snapshot).
 *   - **Imperative API methods** that mirror `Synapse.*` and
 *     additionally refresh the provider's `debugInfo` snapshot on
 *     identity-mutating operations. This keeps components that show
 *     `externalId` / `anonymousId` in sync without polling.
 *
 * SSR-safety: all React hooks below are unconditional and side-effect
 * free at render time. The methods returned are stable references
 * (memo'd against `refreshDebugInfo`) so passing them into `useEffect`
 * deps does not cause cascading re-renders.
 */

import { useCallback, useMemo } from 'react';

import {
  Synapse,
  type PushPermissionOptions,
  type PushPermissionStatus,
  type SynapseDebugInfo,
  type SynapseIdentifyResult,
  type SynapseInitConfig,
  type SynapseLogLevel,
  type SynapseProperties,
} from '../Synapse';
import type { SynapseError } from '../SynapseError';
import { useSynapseContext, type SynapseStatus } from '../SynapseProvider';

export type UseSynapseReturn = {
  // ---- Reactive lifecycle ----
  /** Lifecycle of the provider's initialize() call. */
  status: SynapseStatus;
  /** Convenience: status === 'initialized'. */
  isInitialized: boolean;
  /** Convenience: status === 'pending'. */
  isPending: boolean;
  /** Last-known initialize() error, if any. */
  error: SynapseError | null;
  /** Latest debug-info snapshot from the SDK (may be null until first fetch). */
  debugInfo: SynapseDebugInfo | null;
  /** Sugar accessors derived from the latest debugInfo snapshot. */
  anonymousId: string | null;
  externalId: string | null;
  queueDepth: number;
  /** Force-refresh the debug-info snapshot. */
  refreshDebugInfo: () => Promise<SynapseDebugInfo | null>;

  // ---- Imperative methods (1:1 with Synapse namespace) ----
  initialize: (config: SynapseInitConfig) => Promise<void>;
  setLogLevel: (level: SynapseLogLevel) => Promise<void>;
  identify: (
    externalId: string,
    traits?: SynapseProperties
  ) => Promise<SynapseIdentifyResult>;
  alias: (newExternalId: string) => Promise<SynapseIdentifyResult>;
  logout: () => Promise<void>;
  track: (eventName: string, properties?: SynapseProperties) => Promise<void>;
  screen: (screenName: string, properties?: SynapseProperties) => Promise<void>;
  requestPushPermission: (
    options?: PushPermissionOptions
  ) => Promise<PushPermissionStatus>;
  getPushPermissionStatus: () => Promise<PushPermissionStatus>;
  setTrackingEnabled: (enabled: boolean) => Promise<void>;
  deleteUser: () => Promise<void>;
};

/**
 * Primary hook. Inside React components, prefer this over importing
 * `Synapse` directly — the returned methods auto-refresh the provider's
 * debug snapshot for identity-affecting operations.
 */
export function useSynapse(): UseSynapseReturn {
  const ctx = useSynapseContext();
  const { refreshDebugInfo } = ctx;

  // Identity-affecting operations also refresh debugInfo so the
  // provider's `externalId` / `anonymousId` stays current.
  const identify = useCallback(
    async (externalId: string, traits?: SynapseProperties) => {
      const result = await Synapse.identify(externalId, traits);
      await refreshDebugInfo();
      return result;
    },
    [refreshDebugInfo]
  );

  const alias = useCallback(
    async (newExternalId: string) => {
      const result = await Synapse.alias(newExternalId);
      await refreshDebugInfo();
      return result;
    },
    [refreshDebugInfo]
  );

  const logout = useCallback(async () => {
    await Synapse.logout();
    await refreshDebugInfo();
  }, [refreshDebugInfo]);

  const deleteUser = useCallback(async () => {
    await Synapse.deleteUser();
    await refreshDebugInfo();
  }, [refreshDebugInfo]);

  // Methods that don't affect identity are stable thin wrappers around
  // the namespace — we don't recreate them per render.
  const stableMethods = useMemo(
    () => ({
      initialize: Synapse.initialize.bind(Synapse),
      setLogLevel: Synapse.setLogLevel.bind(Synapse),
      track: Synapse.track.bind(Synapse),
      screen: Synapse.screen.bind(Synapse),
      requestPushPermission: Synapse.requestPushPermission.bind(Synapse),
      getPushPermissionStatus: Synapse.getPushPermissionStatus.bind(Synapse),
      setTrackingEnabled: Synapse.setTrackingEnabled.bind(Synapse),
    }),
    []
  );

  return useMemo<UseSynapseReturn>(
    () => ({
      status: ctx.status,
      isInitialized: ctx.status === 'initialized',
      isPending: ctx.status === 'pending',
      error: ctx.error,
      debugInfo: ctx.debugInfo,
      anonymousId: ctx.debugInfo?.anonymousId ?? null,
      externalId: ctx.debugInfo?.externalId ?? null,
      queueDepth: ctx.debugInfo?.queueDepth ?? 0,
      refreshDebugInfo,
      ...stableMethods,
      identify,
      alias,
      logout,
      deleteUser,
    }),
    [
      ctx.status,
      ctx.error,
      ctx.debugInfo,
      refreshDebugInfo,
      stableMethods,
      identify,
      alias,
      logout,
      deleteUser,
    ]
  );
}
