/**
 * `Synapse.inApp.*` — imperative in-app messaging surface (Phase 10
 * PR-2b RN). The cross-SDK symmetric contract per ADR-0009 D5.
 *
 *   import { Synapse } from '@pyrx/synapse-react-native';
 *
 *   // Register a placement render callback. Returns an unsubscribe.
 *   const unsubscribe = await Synapse.inApp.show('home_banner', (msg) => {
 *     setActiveMessage(msg); // host app renders via component state
 *   });
 *
 *   // Mark interaction when a CTA is tapped.
 *   await Synapse.inApp.markInteracted(msg.id, cta.id);
 *
 *   // Dismiss.
 *   await Synapse.inApp.dismiss(msg.id, 'user_dismissed');
 *
 * Mostly a thin transform-and-delegate layer over the TurboModule
 * spec — the same pattern `Synapse.identify` / `Synapse.track` use.
 * The transforms here:
 *
 *   1. **JS-side observer dispatch for `show()`.** The native SDKs'
 *      `Synapse.InApp.show` / `Pyrx.inApp.show` keep their own
 *      callback registries on the native side. RN is different: the
 *      native bridge already publishes `inAppMessageReceived` via the
 *      `pyrx:in-app:received` event, and that event carries the
 *      `placement_key` field — so we can wire the per-placement
 *      callback fan-out entirely in JS using the existing
 *      `NativeEventEmitter` subscription model. The native call's
 *      ONLY job is to register the placement with the native polling
 *      loop (so it knows what to fetch); the JS callback fan-out is
 *      a JS concern.
 *
 *      Trade-off considered: route everything through a single native
 *      callback registry instead. Rejected because it forces extra
 *      bridge round-trips per fan-out and complicates the bridge for
 *      no UX win.
 *
 *   2. **JSON envelope for `getActive`.** The TurboModule returns a
 *      JSON-encoded string because the codegen-typed bridge cannot
 *      describe `Record<string, unknown>` (the `custom` field). We
 *      JSON-parse on the JS side and expose typed `InAppMessage[]`.
 *
 *   3. **Input validation that fails fast.** Empty placement / empty
 *      messageId / empty ctaId reject with `SynapseError('invalid_argument', ...)`
 *      before crossing the bridge — saves a native round-trip.
 *
 *   4. **Error lifting.** Native rejections become `SynapseError`
 *      instances via `fromNativeError`, same as every other
 *      `Synapse.*` method.
 *
 * No state held in this module — the JS-side callback registry lives
 * in a single module-scoped Map keyed by subscription id, but that
 * registry IS the API surface (not "state" in the lifecycle sense).
 *
 * Subscription lifecycle (the 10 rules of PR #218 are owned by the
 * native SDKs; RN bridge surfaces them):
 *
 *   - `show()` → native registers placement → native polls if
 *     identified (rule 2) or queues for identify (rule 1)
 *   - native cache hit → fires `pyrx:in-app:received` → JS fans out
 *     to every callback registered for that placement
 *   - subscription disposal: caller invokes the unsubscribe function
 *     → JS removes its local entry → if no JS callbacks left for the
 *     placement, JS calls `inAppHideAll(subscriptionId)` so the
 *     native side can stop polling
 */

import NativePyrxSynapse from './NativePyrxSynapse';
import { SynapseError, fromNativeError } from './SynapseError';
import { synapseEvents } from './events';
import type {
  InAppDismissReason,
  InAppMessage,
  InAppRenderCallback,
} from './types/in-app';

/**
 * Per-placement JS callback registry. Keyed by subscription id (the
 * opaque integer the native side hands back from `inAppShow`). Each
 * entry holds the placement key AND the callback so the event
 * subscriber can filter by placement.
 *
 * Module-scoped because the subscription is process-wide (a
 * placement registered from one component remains active until
 * explicitly unsubscribed — same as the native SDKs' `ShowToken`
 * semantics).
 */
const subscribers = new Map<
  number,
  { placement: string; callback: InAppRenderCallback }
>();

/**
 * Lazily-installed listener on `pyrx:in-app:received` that fans out
 * to every matching placement callback. Installed on the first
 * `Synapse.inApp.show(...)` call; never removed (the lifetime of the
 * receive bridge equals the lifetime of the SDK module).
 */
let receivedSubscription: { remove: () => void } | null = null;
function ensureReceivedSubscription(): void {
  if (receivedSubscription !== null) {
    return;
  }
  receivedSubscription = synapseEvents.addListener(
    'pyrx:in-app:received',
    (message) => {
      // Snapshot iteration so that an unsubscribe inside a callback
      // (callers occasionally call `Synapse.inApp.dismiss` then
      // unsubscribe in the same tick) doesn't mutate the live map
      // during fan-out.
      const entries = Array.from(subscribers.values());
      for (const entry of entries) {
        if (entry.placement === message.placement_key) {
          entry.callback(message);
        }
      }
    }
  );
}

/** Validation helper — mirrors `requireNonEmptyString` in Synapse.ts. */
function requireNonEmptyString(
  name: string,
  value: unknown
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SynapseError(
      'invalid_argument',
      `${name} must be a non-empty string`,
      { received: value }
    );
  }
}

/** Centralised error-handling wrapper (same as Synapse.ts). */
async function bridged<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return await invoke();
  } catch (err) {
    throw fromNativeError(err);
  }
}

/**
 * In-app messaging API. Available as `Synapse.inApp` from
 * `@pyrx/synapse-react-native`. Same five methods on every SDK per
 * ADR-0009 D5.
 *
 * Inside React components, prefer the hooks in `./hooks/` (
 * `useInAppMessage`, `useInAppMessageReceived`,
 * `useInAppMessageDismissed`) for subscription lifecycle ergonomics;
 * use `Synapse.inApp.*` from non-component callers (Redux
 * middleware, sagas, plain utility modules).
 */
export const inApp = {
  /**
   * Register a render callback for a placement.
   *
   * The SDK invokes `callback` once per fresh message whose
   * `placement_key` matches `placement`. Returns an unsubscribe
   * function — call it to drop the registration.
   *
   * Triggers an immediate poll under the hood (lifecycle rule 2 of
   * PR #218) if the SDK is already identified — otherwise the poll
   * waits for the next identify (rule 1).
   *
   * Both an imperative call AND any number of `useInAppMessage(...)`
   * hooks for the SAME placement can coexist — the JS fan-out sees
   * every callback regardless of registration source.
   *
   * @example
   *   const unsubscribe = await Synapse.inApp.show('home_banner', (msg) => {
   *     setActiveMessage(msg);
   *   });
   *   // later, on unmount:
   *   unsubscribe();
   *
   * @returns A function that unregisters the callback. Safe to call
   *   multiple times — second + later calls are silent no-ops.
   */
  async show(
    placement: string,
    callback: InAppRenderCallback
  ): Promise<() => void> {
    requireNonEmptyString('placement', placement);
    if (typeof callback !== 'function') {
      throw new SynapseError(
        'invalid_argument',
        'callback must be a function',
        { received: typeof callback }
      );
    }

    ensureReceivedSubscription();

    const subscriptionId = await bridged(() =>
      NativePyrxSynapse.inAppShow(placement)
    );
    subscribers.set(subscriptionId, { placement, callback });

    let cancelled = false;
    return () => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      subscribers.delete(subscriptionId);
      // Fire-and-forget — the unsubscribe contract is sync, but the
      // native side does async cleanup. If the host process is
      // shutting down the rejection is harmless.
      NativePyrxSynapse.inAppHideAll(subscriptionId).catch(() => {
        /* swallow — already disposed */
      });
    };
  },

  /**
   * Sync-style read of currently-active messages from the in-memory
   * cache. Does NOT trigger a poll.
   *
   * Returns a copy sorted priority desc, then expiry asc — same
   * order across all SDKs.
   *
   * @param placement Optional placement filter. Omit (or pass
   *   `undefined`) to return every cached message.
   */
  async getActive(placement?: string): Promise<InAppMessage[]> {
    const filter = placement !== undefined ? placement : null;
    if (filter !== null) {
      requireNonEmptyString('placement', filter);
    }
    const raw = await bridged(() => NativePyrxSynapse.inAppGetActive(filter));
    if (typeof raw !== 'string' || raw.length === 0) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed as InAppMessage[];
    } catch (err) {
      throw new SynapseError(
        'internal_error',
        'inAppGetActive returned non-JSON payload',
        { cause: String(err), raw }
      );
    }
  },

  /**
   * Mark a message dismissed.
   *
   * Evicts the message from the in-memory cache, fires
   * `pyrx:in-app:dismissed` on the observer event stream, and POSTs
   * `/v1/in-app/log` with `event="dismissed"`. The `reason` is
   * observer-only — it does NOT cross the wire (per ADR-0008 D2).
   *
   * Safe to call with an unknown id.
   */
  async dismiss(messageId: string, reason?: InAppDismissReason): Promise<void> {
    requireNonEmptyString('messageId', messageId);
    // `reason` is optional — empty string is treated as `null` so the
    // bridge sees a uniform `null` envelope across the iOS / Android
    // sides.
    const reasonOrNull: string | null =
      reason !== undefined && reason !== '' ? reason : null;
    return bridged(() =>
      NativePyrxSynapse.inAppDismiss(messageId, reasonOrNull)
    );
  },

  /**
   * Mark a message interacted (a CTA was tapped).
   *
   * POSTs `/v1/in-app/log` with `event="interacted"` and
   * `cta_id=ctaId`. Does NOT evict from cache — the host decides
   * whether interaction implies dismissal (a DISMISS-type CTA would
   * call `dismiss(...)` separately).
   */
  async markInteracted(messageId: string, ctaId: string): Promise<void> {
    requireNonEmptyString('messageId', messageId);
    requireNonEmptyString('ctaId', ctaId);
    return bridged(() =>
      NativePyrxSynapse.inAppMarkInteracted(messageId, ctaId)
    );
  },

  /**
   * Explicit poll trigger. Coalesces with any in-flight poll
   * (lifecycle rule 4 of PR #218).
   *
   * Use cases: pull-to-refresh on a screen that hosts an in-app
   * banner, foreground-resume hook (`AppState` change to `active`).
   * The background poll timer (60s default, doubled on
   * `soft_degraded` per rule 8) covers most cases without needing
   * explicit refresh.
   */
  async refresh(): Promise<void> {
    return bridged(() => NativePyrxSynapse.inAppRefresh());
  },
} as const;

/**
 * Test-only — reset the JS-side subscriber registry. Used by the
 * Jest suite to keep tests independent. Not part of the public API.
 *
 * @internal
 */
export function __resetInAppForTests(): void {
  subscribers.clear();
  if (receivedSubscription !== null) {
    receivedSubscription.remove();
    receivedSubscription = null;
  }
}
