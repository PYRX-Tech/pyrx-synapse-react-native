/**
 * `@pyrx/synapse-react-native` — public entry.
 *
 * What's exported here is the supported public surface; everything else
 * is internal. PR-2 adds the opinionated `Synapse` namespace, the
 * `SynapseError` typed error, the React hooks, and the
 * `<SynapseProvider>` context. PR-3 will layer the Expo config plugin
 * and the sample app on top — neither requires changes to this file.
 *
 * Notably NOT exported:
 *   - The raw `NativePyrxSynapse` TurboModule handle. Customers should
 *     never reach across the bridge directly; the namespace is the
 *     contract.
 *   - The `SynapseContext` instance. Hooks consume it internally; the
 *     `useSynapseContext` hook is the public lifecycle-only surface.
 *   - Internal event-emitter machinery. The typed `synapseEvents`
 *     singleton is exported instead, and the hooks wrap that for
 *     React-shaped consumption.
 */

// ---- Imperative API ----
export { Synapse } from './Synapse';
export type {
  PushPermissionOptions,
  PushPermissionStatus,
  SynapseAPI,
  SynapseDebugInfo,
  SynapseEnvironment,
  SynapseIdentifyResult,
  SynapseInitConfig,
  SynapseLogLevel,
  SynapseProperties,
  SynapsePropertyValue,
} from './Synapse';

// ---- Typed error ----
export { SynapseError } from './SynapseError';
export type { SynapseErrorCode } from './SynapseError';

// ---- React context + provider ----
export { SynapseProvider, useSynapseContext } from './SynapseProvider';
export type {
  SynapseContextValue,
  SynapseProviderProps,
  SynapseStatus,
} from './SynapseProvider';

// ---- Hooks ----
export {
  useDeepLink,
  useIdentify,
  useIdentityChanged,
  useInAppMessage,
  useInAppMessageDismissed,
  useInAppMessageReceived,
  usePushClicked,
  usePushPermission,
  usePushReceived,
  usePushReceivedColdStart,
  useSynapse,
} from './hooks';
export type {
  UseDeepLinkReturn,
  UseIdentifyOptions,
  UseIdentifyReturn,
  UsePushPermissionReturn,
  UseSynapseReturn,
} from './hooks';

// ---- In-App Messaging types ----
export type {
  InAppCta,
  InAppCtaActionType,
  InAppDismissReason,
  InAppMessage,
  InAppMessageDismissedHandler,
  InAppMessageReceivedHandler,
  InAppRenderCallback,
} from './types/in-app';

// ---- Event emitter (typed wrapper) ----
export { synapseEvents } from './events';
export type {
  IdentityChangedEvent,
  IdentitySnapshot,
  InAppMessageDismissedEvent,
  InAppMessageReceivedEvent,
  PushClickEvent,
  PushReceivedColdStartEvent,
  PushReceivedEvent,
  QueueDrainedEvent,
  SynapseEventMap,
  SynapseEventName,
} from './events';
