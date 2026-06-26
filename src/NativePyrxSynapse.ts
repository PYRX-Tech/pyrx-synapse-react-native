/**
 * NativePyrxSynapse — TurboModule spec for the PYRX Synapse RN wrapper.
 *
 * This file is the single source of truth that drives RN's New Architecture
 * codegen. Every method declared here gets generated bindings on both
 * platforms: a `NativePyrxSynapseSpec` Kotlin abstract class (Android)
 * and a `NativePyrxSynapseSpec` ObjC++ protocol (iOS). The platform-side
 * implementations (`PyrxSynapseModule.kt` / `PyrxSynapseModule.mm` +
 * `PyrxSynapseImpl.swift`) wrap the corresponding `Pyrx` calls in the
 * underlying native SDKs (`tech.pyrx.synapse:synapse-{core,push}` +
 * `PYRXSynapse`).
 *
 * Type discipline
 * ---------------
 * RN's codegen only supports a constrained type system across the bridge.
 * The constraints we MUST live within:
 *   - Primitives: `string`, `number`, `boolean`.
 *   - Objects: plain literal types `{ a: T1; b: T2 }` — NO `Record<K, V>`,
 *     NO `Map`, NO generics, NO union-typed properties (codegen does NOT
 *     emit valid C++/Kotlin for `string | number` properties).
 *   - Arrays: must be typed (`string[]`, `number[]`, etc.).
 *   - Promises: every async-ish call returns `Promise<T>`; the native side
 *     resolves on success or rejects with an Error carrying a typed code.
 *
 * Because of that constraint, `properties` / `traits` (which are
 * arbitrarily-shaped JSON in the native SDKs) cross the bridge as JSON
 * strings — the JS surface in `src/index.ts` JSON-encodes before calling
 * and the native side JSON-decodes once. This is the same compromise the
 * official @react-native-firebase libraries make for the same reason.
 *
 * Error contract
 * --------------
 * Every promise rejects with an Error whose `code` property is one of:
 *   - "not_initialized"     — Synapse.initialize() not called yet
 *   - "permission_denied"   — push permission rejected by user/OS
 *   - "network_error"       — transport failure or 5xx from backend
 *   - "invalid_argument"    — caller supplied bad input (empty externalId, etc.)
 *   - "internal_error"      — unexpected SDK-side error; see message
 * The JS surface translates these into a typed `SynapseError` (PR-2).
 *
 * What is NOT exposed to JS
 * -------------------------
 * - `handleDeviceToken` — fired automatically by `PYRXSynapseAppDelegate`
 *   (iOS) and `PyrxMessagingService` (Android). The JS layer never sees
 *   the token; the device registration happens entirely native-side.
 * - Cold-start push attribution — captured natively before JS is alive.
 * - `handleNotificationResponse` / `handleNotificationTap` — fired
 *   natively; the resulting `pyrx:push:click` event is surfaced to JS via
 *   the NativeEventEmitter (wired in PR-2, declared here as part of the
 *   `addListener` / `removeListeners` TurboModule pair for symmetry).
 */

import { TurboModuleRegistry, type TurboModule } from 'react-native';

/**
 * Configuration shape — mirror of `PyrxConfig` (Swift) / `PyrxConfig`
 * (Kotlin). The native side validates each field; invalid configs reject
 * with `code = "invalid_argument"`.
 *
 * - workspaceId: UUID v4 string (e.g. "550e8400-e29b-41d4-a716-446655440000").
 * - apiKey:      "psk_{env}_{hex32}" — the public ingestion key.
 * - environment: "production" | "sandbox". The native SDKs translate this
 *                to the wire-level "live" / "test" discriminator.
 * - baseUrl:     optional override; defaults to the production endpoint
 *                ("https://synapse-events.pyrx.tech") native-side.
 * - logLevel:    optional verbosity; defaults to "info" native-side.
 * - maxQueueSize: optional offline-queue bound; defaults to 1000.
 */
export type SynapseInitConfig = {
  workspaceId: string;
  apiKey: string;
  environment: string; // "production" | "sandbox" — codegen forbids unions
  baseUrl?: string;
  logLevel?: string; // "debug" | "info" | "warning" | "error" | "none"
  maxQueueSize?: number;
};

/**
 * Snapshot returned by `debugInfo()` — mirror of `PyrxDebugInfo` (Swift)
 * / `PyrxDebugInfo` (Kotlin). Surface here mirrors the union of fields
 * the two native SDKs expose; missing optional fields come back as `null`
 * rather than absent so the JS side can rely on the shape.
 */
export type SynapseDebugInfo = {
  initialized: boolean;
  anonymousId: string | null;
  externalId: string | null;
  hasDeviceToken: boolean;
  queueDepth: number;
  sdkVersion: string;
  sdkPlatform: string; // e.g. "ios+rn" / "android+rn"
  trackingEnabled: boolean;
};

/**
 * Identify result — mirror of `IdentityResult` (iOS) / `IdentityResult`
 * (Android). Tells the caller which server-side merge path fired and
 * what happened to prior anonymous activity.
 */
export type SynapseIdentifyResult = {
  /** Canonical contact UUID after the merge. */
  contactId: string;
  /**
   * Merge discriminator. One of:
   *   - "known_exists"   — both anonymous + canonical existed; server merged
   *   - "first_sighting" — only the anonymous contact existed; renamed
   *   - "no_anonymous"   — no anonymous contact; plain upsert
   */
  path: string;
  /** For `alias` results, the prior external_id that was merged in. */
  aliasedExternalId: string | null;
  /** Count of events the server re-attributed to the canonical contact. */
  eventsReattributed: number;
  /** Count of devices the server re-attributed. */
  devicesReattributed: number;
  /** Whether the prior anonymous contact row was tombstoned. */
  anonymousContactTombstoned: boolean;
};

/**
 * Permission outcome — mirror of `requestPushPermission()` on both natives.
 * The "provisional" case applies only to iOS (UNAuthorizationOptions
 * .provisional, iOS 12+); Android always returns "granted" | "denied" |
 * "notDetermined".
 */
export type PushPermissionStatus =
  | 'granted'
  | 'denied'
  | 'provisional'
  | 'notDetermined';

/**
 * Options forwarded to `requestPushPermission()`. All three flags default
 * to `true` if omitted — matching the iOS SDK default and the typical
 * Android FCM flow.
 */
export type PushPermissionOptions = {
  alert?: boolean;
  sound?: boolean;
  badge?: boolean;
};

export interface Spec extends TurboModule {
  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * Initialize the SDK. Idempotent: re-calling with the same config is a
   * no-op; differing config rejects with `"invalid_argument"` (the
   * native SDKs throw `AlreadyInitialized`).
   *
   * The JS surface in `src/index.ts` JSON-encodes any non-primitive
   * inside the config (currently none) before calling this; the native
   * side decodes back. See file-header for the type-discipline reason.
   */
  initialize(config: SynapseInitConfig): Promise<void>;

  /** Mutate runtime verbosity. Mirrors `Pyrx.setLogLevel`. */
  setLogLevel(level: string): Promise<void>;

  /** Returns diagnostic state — useful for debug menus + bug reports. */
  debugInfo(): Promise<SynapseDebugInfo>;

  // ---------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------

  /**
   * Bind the current device to an external identity.
   *
   * `traitsJson` is a JSON-encoded object payload (string-keyed,
   * primitive-or-null values, no nested objects). Cross-bridge type
   * discipline forces the JSON envelope — see file-header. Pass `null`
   * (or omit, which the JS surface translates to `null`) when no traits.
   */
  identify(
    externalId: string,
    traitsJson: string | null
  ): Promise<SynapseIdentifyResult>;

  /**
   * Rename the active identity. Mirrors `Pyrx.alias`. Returns the same
   * shape as `identify` so callers can branch on `path`.
   */
  alias(newExternalId: string): Promise<SynapseIdentifyResult>;

  /**
   * Drop the current identity and roll a fresh anonymousId. The on-disk
   * queue, device token, and push subscription are preserved per the
   * native SDK contract.
   */
  logout(): Promise<void>;

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------

  /**
   * Track an event. `propertiesJson` is JSON-encoded for the same
   * type-discipline reason as `identify`. Returns once the event is
   * enqueued — NOT once it has been delivered (the native queue handles
   * delivery / retry / drop).
   */
  track(eventName: string, propertiesJson: string | null): Promise<void>;

  /** Track a screen view. Same payload shape rules as `track`. */
  screen(screenName: string, propertiesJson: string | null): Promise<void>;

  // ---------------------------------------------------------------------
  // Push — registration
  // ---------------------------------------------------------------------

  /**
   * Ask the OS for permission to send push notifications, then register
   * for remote notifications (APNs on iOS; FCM on Android — Android 13+
   * surfaces the OS-level dialog, older versions are auto-granted).
   *
   * On iOS, the AppDelegate base class `PYRXSynapseAppDelegate` (D7)
   * captures the resulting APNs token and calls
   * `Pyrx.shared.handleDeviceToken` automatically — the JS layer never
   * sees the token.
   *
   * On Android, the FCM `PyrxMessagingService` (from synapse-push)
   * captures the token and routes it through `Pyrx.handleDeviceToken`
   * automatically.
   *
   * Returns the OS permission state. `provisional` is iOS-only.
   */
  requestPushPermission(
    options: PushPermissionOptions
  ): Promise<PushPermissionStatus>;

  /**
   * Read-only — current push permission state without prompting.
   * Useful for "should I show the soft-ask UI?" decisions before
   * triggering the OS dialog.
   */
  getPushPermissionStatus(): Promise<PushPermissionStatus>;

  // ---------------------------------------------------------------------
  // Privacy / kill switch
  // ---------------------------------------------------------------------

  /**
   * Toggle the SDK's tracking gate. `false` drains the queue, disables
   * future event capture, but leaves identity intact. Mirrors
   * `Pyrx.setTrackingEnabled`.
   */
  setTrackingEnabled(enabled: boolean): Promise<void>;

  /**
   * GDPR delete — drops local identity, wipes the encrypted store, drains
   * the queue, and POSTs `/v1/contacts/{id}/delete` to ask the backend
   * to forget the contact. Irreversible.
   */
  deleteUser(): Promise<void>;

  // ---------------------------------------------------------------------
  // Event emitter symmetry (required by RN's NativeEventEmitter on TurboModules)
  // ---------------------------------------------------------------------

  /**
   * Required by RN's NativeEventEmitter on TurboModules — receiving the
   * count tells the native side it can stop bookkeeping when the last
   * listener detaches. Implementations are usually empty bodies (the
   * native side bookkeeps via the NativeEventEmitter's own machinery).
   *
   * Events emitted on this module:
   *   - "pyrx:push:received" — foreground push delivered
   *   - "pyrx:push:click"    — push tapped (foreground / background)
   *   - "pyrx:queue:drained" — internal queue flushed (debug-only)
   */
  addListener(eventType: string): void;

  /** Counterpart to `addListener`. See `addListener` for details. */
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('PyrxSynapse');
