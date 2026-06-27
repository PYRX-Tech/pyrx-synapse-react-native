/**
 * Native-event bridge for `@pyrx/synapse-react-native`.
 *
 * ⚠️ **EVENTS NOT FIRING IN 0.1.x.** This module wires the JS-side
 * `NativeEventEmitter` consumer, but the native producer side
 * (`PyrxSynapseImpl.swift`, `PyrxSynapseModule.kt`) does not yet emit
 * any of these events — both files contain only `addListener` /
 * `removeListeners` count-tracking stubs. Reason: the published
 * `PYRXSynapse` (iOS) and `tech.pyrx.synapse` (Android) SDKs expose
 * no observer / delegate / Combine / Flow surface for an external
 * subscriber to attach to. Wiring is planned for v0.2.0 once Phase
 * 9.2.1 adds observer APIs to PYRXSynapse 0.1.2 and
 * tech.pyrx.synapse:synapse-{core,push}:0.1.4.
 *
 * Tracking:
 * https://github.com/PYRX-Tech/pyrx-synapse-react-native/issues/5
 *
 * ---
 *
 * Intended behaviour (when wired in 0.2.0):
 *
 * The native modules (`PyrxSynapseImpl.swift`, `PyrxSynapseModule.kt`)
 * surface three event streams to JS via React Native's
 * `NativeEventEmitter`:
 *
 *   - `pyrx:push:received`  — foreground push delivered to the app
 *   - `pyrx:push:click`     — user tapped a push (foreground OR background)
 *   - `pyrx:queue:drained`  — internal event queue successfully flushed
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
   * Arbitrary custom data the sender attached. Stringly-typed because
   * the bridge cannot codegen arbitrary maps — JSON-decoded from the
   * native side; values are JSON primitives, arrays, or objects.
   */
  data: Record<string, unknown>;
  /**
   * Synapse-stamped metadata: `push_log_id`, `tenant_id`, `template_id`,
   * etc. Always present. Same JSON-decoding contract as `data`.
   */
  pyrxAttrs: Record<string, unknown>;
};

/**
 * Payload for `pyrx:push:click`. Fires once per real tap (debounced
 * native-side so cold-start + warm-start of the same notification
 * doesn't double-fire). On Android, this also fires for notification
 * actions; `actionId` will be the action's identifier in that case.
 */
export type PushClickEvent = {
  /** Synapse-issued push log row identifier; matches `push_logs.id`. */
  pushLogId: string;
  /** Optional deep link the sender attached. `null` when no link. */
  deepLink: string | null;
  /**
   * Optional action identifier (Android notification action button or
   * iOS UNNotificationAction). `null` for plain body taps.
   */
  actionId: string | null;
  /** Echo of the push's pyrxAttrs map. See PushReceivedEvent. */
  pyrxAttrs: Record<string, unknown>;
};

/**
 * Payload for `pyrx:queue:drained`. Debug-only — most apps will never
 * subscribe. Fires once each time the native event queue successfully
 * flushes to `/v1/events/batch`.
 */
export type QueueDrainedEvent = {
  /** Number of events flushed in this drain cycle. */
  count: number;
  /** Server-acknowledged batch id (for matching to dashboard logs). */
  batchId: string;
};

/**
 * Discriminator → payload map. Used for type-safe `addListener`.
 */
export type SynapseEventMap = {
  'pyrx:push:received': PushReceivedEvent;
  'pyrx:push:click': PushClickEvent;
  'pyrx:queue:drained': QueueDrainedEvent;
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
 * prefer the `usePushReceived` / `usePushClicked` / `useDeepLink` hooks.
 */
export const synapseEvents = new SynapseEvents();
