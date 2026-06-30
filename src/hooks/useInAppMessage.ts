/**
 * `useInAppMessage(placement, callback)` — subscribe to fresh in-app
 * messages for a placement.
 *
 * Fires the callback every time the native SDK publishes a NEW
 * in-app message whose `placement_key` matches `placement`. The
 * native side handles fetch, cache, dedupe, and the 10 lifecycle
 * rules of PR #218 — the hook is a thin lifecycle-aware wrapper
 * around `Synapse.inApp.show(...)`.
 *
 * Subscription lifecycle:
 *   - Registers on mount; unregisters on unmount.
 *   - Re-registers when `placement` changes (e.g., a tab switch
 *     between two placements). The previous subscription is dropped
 *     before the new one is established.
 *   - Callback identity changes do NOT trigger re-registration — the
 *     hook holds the latest callback in a ref. This avoids
 *     "re-subscribe storms" when callers pass inline arrow functions.
 *
 * Multiple components calling `useInAppMessage` with the SAME
 * placement each get their own callback fired. Multiple placements
 * across the tree each get registered independently — the native
 * side polls the union of registered placements per the SDK
 * contract.
 *
 * Note on placement gating: this hook does not enforce that
 * `placement` is non-empty at type-level (the runtime call into
 * `Synapse.inApp.show` rejects with `invalid_argument` if so). Empty
 * placement rejects the promise inside the effect; the resulting
 * `SynapseError` is unhandled by default — wire up an error boundary
 * or use the imperative `Synapse.inApp.show(...)` if you need to
 * react to that error.
 *
 * Available since 0.3.0. Did not exist in 0.2.x.
 *
 * @example
 *   function HomeScreen() {
 *     const [activeMessage, setActiveMessage] = useState<InAppMessage | null>(null);
 *     useInAppMessage('home_banner', setActiveMessage);
 *     return (
 *       <View>
 *         {activeMessage && (
 *           <BannerView
 *             message={activeMessage}
 *             onDismiss={() => {
 *               Synapse.inApp.dismiss(activeMessage.id, 'user_dismissed');
 *               setActiveMessage(null);
 *             }}
 *           />
 *         )}
 *       </View>
 *     );
 *   }
 */

import { useEffect, useRef } from 'react';

import { Synapse } from '../Synapse';
import type { InAppMessage, InAppRenderCallback } from '../types/in-app';

export function useInAppMessage(
  placement: string,
  callback: (message: InAppMessage) => void
): void {
  // Hold the latest callback in a ref so the native subscription is
  // established only once per (mount × placement); new callback
  // references don't trigger re-subscription.
  const callbackRef = useRef<InAppRenderCallback>(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const dispose = await Synapse.inApp.show(placement, (message) => {
          // Indirect through the ref so callers benefit from the
          // latest callback identity without re-subscribing.
          callbackRef.current(message);
        });
        if (cancelled) {
          // The component unmounted (or placement changed) before
          // the bridge resolved — clean up immediately.
          dispose();
          return;
        }
        unsubscribe = dispose;
      } catch {
        // Initialization errors are surfaced via the SynapseProvider
        // `onError` callback (which already wires to console.warn by
        // default). Silently swallowing here keeps unmounts clean —
        // the host app's general error reporter sees it elsewhere.
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribe !== null) {
        unsubscribe();
      }
    };
  }, [placement]);
}
