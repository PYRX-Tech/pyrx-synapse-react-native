/**
 * @pyrx/synapse-react-native — PR-1 minimal JS entry.
 *
 * PR-1 ships the TurboModule bridge plumbing. The opinionated public
 * surface — `Synapse` namespace, React hooks, `<SynapseProvider>`, and
 * the `SynapseError` class — lands in PR-2 (see Phase 9.2 plan §2.2).
 *
 * For now we expose only the raw TurboModule + its types so the bridge
 * can be exercised end-to-end (sample app smoke test, unit tests).
 * Customers should NOT consume this surface directly past 0.1.0 — it
 * exists for PR-1 quality gates and will be wrapped by `Synapse` in
 * PR-2.
 */

import NativePyrxSynapse from './NativePyrxSynapse';

export type {
  Spec as PyrxSynapseSpec,
  SynapseInitConfig,
  SynapseDebugInfo,
  SynapseIdentifyResult,
  PushPermissionStatus,
  PushPermissionOptions,
} from './NativePyrxSynapse';

/**
 * Direct TurboModule handle. Prefer the wrappers shipped in PR-2
 * (`Synapse.initialize(...)` / `useSynapse()` / etc.) — this is the
 * bridge primitive, exposed for PR-1 smoke testing only.
 */
export default NativePyrxSynapse;
