/**
 * `useDeepLink()` — stateful snapshot of the most recent push click.
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
 * link through their own state machine first.
 *
 * `clear()` resets `lastPushClick` to `null`; call it after handling a
 * click so the same click doesn't re-fire your routing effect when the
 * component re-renders.
 *
 * Cold-start note
 * ---------------
 * `useDeepLink` only surfaces warm-start taps. For cold-start launches
 * (the OS started the app to deliver the tap), subscribe to
 * `usePushReceivedColdStart` and route based on its
 * `pyrxAttrs.deep_link` or by pairing it with `usePushClicked` — but
 * the latter intentionally does NOT fire for the cold-start payload
 * because the native SDKs publish `pushReceivedColdStart` instead.
 *
 * Available since 0.2.0. In 0.1.x `lastPushClick` never updated
 * because the underlying click event never fired; in 0.2.0 it works
 * as documented.
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
