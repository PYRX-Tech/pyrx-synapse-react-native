/**
 * `useDeepLink()` — stateful snapshot of the most recent push click.
 *
 * ⚠️ **NOT WIRED IN 0.1.x.** Built on `usePushClicked`, which itself
 * is stubbed in v0.1.x — `lastPushClick` will never update because no
 * `pyrx:push:click` event ever fires. Wiring is planned for v0.2.0,
 * blocked on Phase 9.2.1 observer APIs in the native SDKs.
 *
 * Tracking issue:
 * https://github.com/PYRX-Tech/pyrx-synapse-react-native/issues/5
 *
 * ---
 *
 * Intended behaviour (when wired in 0.2.0):
 *
 * Subscribes to `pyrx:push:click` and exposes the latest event as
 * `lastPushClick`. Use this in your navigation root to react to taps
 * via a `useEffect` dep on `lastPushClick`:
 *
 *   const { lastPushClick } = useDeepLink();
 *   useEffect(() => {
 *     if (lastPushClick?.deepLink) {
 *       Linking.openURL(lastPushClick.deepLink);
 *     }
 *   }, [lastPushClick]);
 *
 * The hook does NOT call `Linking.openURL` itself — customers commonly
 * want to validate the URL, filter to in-app routes, or thread the
 * link through their own state machine first. Plan §D5 spells this out
 * as the documented contract.
 *
 * `clear()` resets `lastPushClick` to `null`; call it after handling a
 * click so the same click doesn't re-fire your routing effect when the
 * component re-renders.
 */

import { useCallback, useState } from 'react';

import type { PushClickEvent } from '../events';
import { usePushClicked } from './usePushClicked';

export type UseDeepLinkReturn = {
  /** Most recent push click event, or `null` if none seen this session. */
  lastPushClick: PushClickEvent | null;
  /** Reset `lastPushClick` to `null` after handling it. */
  clear: () => void;
};

export function useDeepLink(): UseDeepLinkReturn {
  const [lastPushClick, setLastPushClick] = useState<PushClickEvent | null>(
    null
  );

  usePushClicked((event) => {
    setLastPushClick(event);
  });

  const clear = useCallback(() => {
    setLastPushClick(null);
  }, []);

  return { lastPushClick, clear };
}
