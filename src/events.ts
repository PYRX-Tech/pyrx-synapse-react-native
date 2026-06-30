/**
 * Native-event bridge for `@pyrx/synapse-react-native`.
 *
 * The native modules (`PyrxSynapseImpl.swift`, `PyrxSynapseModule.kt`)
 * surface five event streams to JS via React Native's
 * `NativeEventEmitter`:
 *
 *   - `pyrx:push:received`              — foreground push delivered
 *   - `pyrx:push:click`                 — user tapped a push (warm-start)
 *   - `pyrx:push:received-cold-start`   — app was launched FROM a push tap
 *                                         (cold-start; replay-buffered for
 *                                         late JS subscribers)
 *   - `pyrx:queue:drained`              — internal event queue flushed N events
 *   - `pyrx:identity:changed`           — identify / alias / logout completed
 *
 * These events fire from `Pyrx.shared.events()` (iOS AsyncStream) and
 * `Pyrx.events` (Android SharedFlow) — both APIs landed in Phase 9.2.1:
 * `PYRXSynapse 0.1.2` and `tech.pyrx.synapse:synapse-{core,push}:0.1.4`.
 *
 * Cold-start dedup
 * ----------------
 * If the same push tap caused both a cold-start launch AND a subsequent
 * warm-start delivery, the native SDKs publish `pushReceivedColdStart`
 * once and SUPPRESS the matching `pushClicked` via a 5-second LRU on
 * `push_log_id`. Consumers can rely on the invariant: a single user tap
 * generates exactly one of `pyrx:push:click` OR
 * `pyrx:push:received-cold-start`, never both.
 *
 * Late-subscriber replay
 * ----------------------
 * Both native SDKs keep a replay buffer of the most recent 4 events. A
 * JS subscription that attaches AFTER an event has already fired still
 * receives the buffered history. This handles the RN cold-start race:
 * JS mounts ~0.5-2s after the OS delivers a cold-start push, but the
 * `pushReceivedColdStart` event is still observable when the first
 * `usePushReceivedColdStart` hook subscribes.
 *
 * Important wiring note for RN 0.76+ (New Architecture):
 *
 * `NativeEventEmitter` MUST be instantiated against the TurboModule
 * itself (`new NativeEventEmitter(NativePyrxSynapse)`), NOT against a
 * string identifier. The legacy string-keyed signature was removed when
 * New Architecture became default. We pass the TurboModule handle
 * imported from `./NativePyrxSynapse` directly.
 *
 * Subscription semantics:
 *   - Multiple JS subscribers per event are supported — each gets its
 *     own listener token. Calling `.remove()` on one does not affect
 *     siblings.
 *   - The native side bookkeeps `addListener` / `removeListeners` calls
 *     so it can stop expensive sources when the last listener detaches.
 *     RN's `NativeEventEmitter` handles this automatically — we don't
 *     need to touch the TurboModule's `addListener` / `removeListeners`
 *     methods from JS.
 */

import { NativeEventEmitter, type EmitterSubscription } from 'react-native';

import NativePyrxSynapse from './NativePyrxSynapse';
import type { InAppMessage } from './types/in-app';

/**
 * Minimal shape NativeEventEmitter requires from the module it wraps.
 * The public `NativeModule` type is not re-exported from `react-native`
 * with strict-API enabled; we declare the structural subset locally so
 * the cast at construction site is explicit and reviewable.
 */
type EmitterModuleShape = {
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
};

/**
 * Payload for `pyrx:push:received`. Fires when a push is delivered to
 * the app while it is in the foreground. The data shape mirrors what
 * the native delegate decoded from APNs/FCM. The `data` map is the
 * arbitrary custom-payload portion; the `pyrxAttrs` map carries the
 * delivery metadata Synapse stamps onto every push.
 */
export type PushReceivedEvent = {
  /** APS / FCM alert title. May be empty for silent / data-only pushes. */
  title: string;
  /** APS / FCM alert body. May be empty for silent / data-only pushes. */
  body: string;
  /**
   * Synapse-issued push log row identifier; matches `push_logs.id` on
   * the backend. `null` for pushes that did not carry the `pyrx`
   * namespace (legacy / cross-vendor pushes pass through silently on
   * the telemetry side, but the observer API still surfaces them so
   * apps can react to ALL deliveries).
   */
  pushLogId: string | null;
  /**
   * Arbitrary custom data the sender attached. Stringly-typed because
   * the bridge cannot codegen arbitrary maps — JSON-decoded from the
   * native side; values are JSON primitives, arrays, or objects.
   */
  data: Record<string, unknown>;
  /**
   * Synapse-stamped metadata: `push_log_id`, `tenant_id`, `template_id`,
   * etc. `null` if the push did NOT carry a `pyrx_attrs` namespace.
   * Same JSON-decoding contract as `data`.
   */
  pyrxAttrs: Record<string, unknown> | null;
  /** ISO 8601 wall-clock instant the SDK observed the delivery (UTC). */
  receivedAt: string;
};

/**
 * Payload for `pyrx:push:received-cold-start`. Same shape as
 * [PushReceivedEvent] — the distinguishing signal is the event name
 * itself, NOT a payload field. Fires when the app was LAUNCHED by the
 * OS to deliver a push (or a tap of one).
 *
 * Mutually exclusive with `pyrx:push:click` for the same payload —
 * see the file-header "Cold-start dedup" note.
 */
export type PushReceivedColdStartEvent = PushReceivedEvent;

/**
 * Payload for `pyrx:push:click`. Fires once per real tap (debounced
 * native-side so cold-start + warm-start of the same notification
 * doesn't double-fire). On Android, this also fires for notification
 * actions; `actionId` will be the action's identifier in that case.
 *
 * Does NOT fire for cold-start taps — those publish
 * `pyrx:push:received-cold-start` instead.
 */
export type PushClickEvent = {
  /**
   * Synapse-issued push log row identifier; matches `push_logs.id`.
   * `null` for non-Synapse pushes (legacy passthrough).
   */
  pushLogId: string | null;
  /** Optional deep link the sender attached. `null` when no link. */
  deepLink: string | null;
  /**
   * Optional action identifier (Android notification action button or
   * iOS UNNotificationAction). `null` for plain body taps.
   */
  actionId: string | null;
  /**
   * Echo of the push's pyrxAttrs map (see PushReceivedEvent). `null`
   * if no `pyrx_attrs` namespace was present.
   */
  pyrxAttrs: Record<string, unknown> | null;
  /** ISO 8601 wall-clock instant the SDK observed the click (UTC). */
  clickedAt: string;
};

/**
 * Payload for `pyrx:queue:drained`. Debug-only — most apps will never
 * subscribe. Fires once each time the native event queue successfully
 * flushes to `/v1/events/batch`. Does NOT fire on no-op drain passes
 * (zero events to send).
 */
export type QueueDrainedEvent = {
  /** Number of events flushed in this drain cycle. Always > 0. */
  count: number;
};

/**
 * Point-in-time view of the SDK's resolved identity. Carried by
 * `pyrx:identity:changed` as both `before` and `after` (when `before`
 * exists — see [IdentityChangedEvent]).
 *
 * Matches the native iOS `IdentitySnapshot` and Android
 * `IdentitySnapshot` shapes exactly.
 *
 * Detect:
 *   - **Login**:  `before?.externalId == null && after.externalId != null`
 *   - **Logout**: `before?.externalId != null && after.externalId == null`
 *   - **Switch**: both non-null AND `before.externalId !== after.externalId`
 */
export type IdentitySnapshot = {
  /**
   * The SDK-minted anonymous device identifier (UUIDv4 generated at
   * first launch, persisted forever). Survives identify / alias /
   * logout — the anonymous id never changes over the SDK's lifetime
   * on a given install. May be `null` transiently for the very first
   * snapshot of a fresh install before storage is seeded.
   */
  anonymousId: string | null;
  /**
   * The canonical user identifier the host app called `identify(...)`
   * with, or `null` for anonymous-only sessions. Returns to `null`
   * after `logout`.
   */
  externalId: string | null;
  /** ISO 8601 wall-clock instant the snapshot was captured (UTC). */
  snapshotAt: string;
};

/**
 * Payload for `pyrx:identity:changed`. Fires when the SDK's resolved
 * identity transitions via `identify`, `alias`, or `logout`.
 *
 * `before` is `null` ONLY on the very first identify after a fresh
 * install (no prior identity state recorded). Otherwise both snapshots
 * are non-null.
 *
 * Dashboard-style RN apps use this to refetch user data on login state
 * change without polling `useIdentify` in a `useEffect`.
 */
export type IdentityChangedEvent = {
  /** Prior identity state. `null` only on the very first identify. */
  before: IdentitySnapshot | null;
  /** Resolved identity state after the transition. Always non-null. */
  after: IdentitySnapshot;
};

/**
 * Payload for `pyrx:in-app:received`. Fires once per fresh in-app
 * message landed in the SDK's cache, after the SDK's own dedupe by
 * assignment id (lifecycle rule 6 of PR #218). Symmetric with the
 * native SDKs' `inAppMessageReceived` case on `Pyrx.events`.
 *
 * The payload IS the wire-shaped [InAppMessage]. The SDK uses the
 * same shape across browser / iOS / Android / RN / Flutter per
 * ADR-0009 D5, so the same documentation snippets translate.
 *
 * This event fires for EVERY new message regardless of which
 * placement matched — host apps that only care about a specific
 * placement should use the `useInAppMessage(placement, callback)`
 * hook instead (it filters server-side via the registration).
 *
 * Available since 0.3.0.
 */
export type InAppMessageReceivedEvent = InAppMessage;

/**
 * Payload for `pyrx:in-app:dismissed`. Fires when `Synapse.inApp.dismiss(...)`
 * is called (host-initiated). `reason` is the host-supplied free-form
 * string (`'user_dismissed'`, `'cta_dismissed'`, `'expired'`, …), or
 * `null` if the caller did not provide one.
 *
 * Per ADR-0008 D2 the reason is observer-only — it does NOT cross
 * the wire on the backend `/v1/in-app/log` POST. Reserved for
 * forward-compat with future expiry-driven auto-dismiss.
 *
 * Available since 0.3.0.
 */
export type InAppMessageDismissedEvent = {
  /** Assignment id of the dismissed message (`InAppMessage.id`). */
  messageId: string;
  /** Host-supplied reason from `dismiss(messageId, reason)`. */
  reason: string | null;
};

/**
 * Discriminator → payload map. Used for type-safe `addListener`.
 */
export type SynapseEventMap = {
  'pyrx:push:received': PushReceivedEvent;
  'pyrx:push:click': PushClickEvent;
  'pyrx:push:received-cold-start': PushReceivedColdStartEvent;
  'pyrx:queue:drained': QueueDrainedEvent;
  'pyrx:identity:changed': IdentityChangedEvent;
  'pyrx:in-app:received': InAppMessageReceivedEvent;
  'pyrx:in-app:dismissed': InAppMessageDismissedEvent;
};

export type SynapseEventName = keyof SynapseEventMap;

/**
 * Public typed wrapper around the raw `NativeEventEmitter`. The wrapper
 * exists for two reasons:
 *
 *   1. Type the `eventName → payload` map. The bare emitter is
 *      stringly-typed; consumers would have to cast.
 *   2. Hide the underlying TurboModule handle from consumers. They
 *      never need to import `NativePyrxSynapse` directly.
 */
class SynapseEvents {
  private readonly emitter: NativeEventEmitter;

  constructor() {
    // NativeEventEmitter on TurboModules in RN 0.76+ requires the
    // module handle, not a string. See file-header.
    this.emitter = new NativeEventEmitter(
      // Cast: NativeEventEmitter's constructor signature pre-dates
      // TurboModules; the runtime accepts a TurboModule but the .d.ts
      // expects `NativeModule`. They share the addListener/removeListeners
      // shape so the cast is safe.
      NativePyrxSynapse as unknown as EmitterModuleShape
    );
  }

  /**
   * Subscribe to a typed Synapse event. The returned subscription has
   * `.remove()`; call it during component unmount (or whenever the
   * subscription should end).
   */
  addListener<K extends SynapseEventName>(
    eventName: K,
    listener: (payload: SynapseEventMap[K]) => void
  ): EmitterSubscription {
    // Cast: NativeEventEmitter types the listener arg as `Object` (the
    // legacy untyped shape). We constrain to our typed event payloads
    // and trust the native emitter to hand us the right shape — the
    // contract is enforced by the Swift / Kotlin emitter calls.
    return this.emitter.addListener(
      eventName,
      listener as (payload: object) => void
    );
  }

  /**
   * Drop all listeners for an event. Rarely needed — prefer holding the
   * subscription from `addListener` and calling `.remove()` on it.
   */
  removeAllListeners(eventName: SynapseEventName): void {
    this.emitter.removeAllListeners(eventName);
  }
}

/**
 * Singleton instance. Importing this and `synapseEvents.addListener(...)`
 * is the right escape hatch for non-component callers (Redux middleware,
 * background tasks, plain utility modules). Inside React components,
 * prefer the `usePushReceived` / `usePushClicked` / `useDeepLink` /
 * `usePushReceivedColdStart` / `useIdentityChanged` hooks.
 */
export const synapseEvents = new SynapseEvents();
