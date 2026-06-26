/**
 * Tests for `useDeepLink`.
 *
 * Verifies:
 *   - `lastPushClick` starts as `null` and updates after a click emit.
 *   - `clear()` resets it back to `null`.
 *   - Subsequent clicks overwrite (only the latest is exposed).
 *   - Subscription cleans up on unmount.
 */

import { act } from '@testing-library/react-native';
import { Text } from 'react-native';

import { emitNativeEvent, listenerCount, resetAll } from './helpers/setup';
import { useDeepLink } from '../hooks/useDeepLink';
import { renderWithProvider } from './helpers/renderWithProvider';

const config = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  apiKey: 'psk_test_abc',
  environment: 'sandbox' as const,
};

beforeEach(() => {
  resetAll();
});

describe('useDeepLink', () => {
  function Probe({
    onState,
  }: {
    onState: (s: ReturnType<typeof useDeepLink>) => void;
  }) {
    const state = useDeepLink();
    onState(state);
    return <Text>{state.lastPushClick?.deepLink ?? 'none'}</Text>;
  }

  it('lastPushClick is null initially', async () => {
    // Wrapping in `.current` defeats TS's narrowing of the bare `let` —
    // the callback `(s) => (latest = s)` is a closure, and TS's
    // control-flow analysis doesn't track outer-scope mutations through
    // closures, so a bare `let latest: T | null = null` stays narrowed to
    // `null` at the `expect` line. The ref-object pattern keeps the
    // outer type stable and only narrows `.current`, which TS handles.
    const latest: { current: ReturnType<typeof useDeepLink> | null } = {
      current: null,
    };
    await renderWithProvider(
      <Probe onState={(s) => (latest.current = s)} />,
      { config }
    );
    expect(latest.current?.lastPushClick).toBeNull();
  });

  it('updates after a push:click emit', async () => {
    const latest: { current: ReturnType<typeof useDeepLink> | null } = {
      current: null,
    };
    const { findByText } = await renderWithProvider(
      <Probe onState={(s) => (latest.current = s)} />,
      { config }
    );

    await act(async () => {
      emitNativeEvent('pyrx:push:click', {
        pushLogId: 'plog_42',
        deepLink: 'myapp://products/9',
        actionId: null,
        pyrxAttrs: {},
      });
    });

    await findByText('myapp://products/9');
    expect(latest.current?.lastPushClick?.pushLogId).toBe('plog_42');
  });

  it('clear() resets lastPushClick to null', async () => {
    const latest: { current: ReturnType<typeof useDeepLink> | null } = {
      current: null,
    };
    const { findByText } = await renderWithProvider(
      <Probe onState={(s) => (latest.current = s)} />,
      { config }
    );

    await act(async () => {
      emitNativeEvent('pyrx:push:click', {
        pushLogId: 'plog_1',
        deepLink: 'myapp://home',
        actionId: null,
        pyrxAttrs: {},
      });
    });
    await findByText('myapp://home');

    await act(async () => {
      latest.current!.clear();
    });
    await findByText('none');
    expect(latest.current?.lastPushClick).toBeNull();
  });

  it('overwrites with the most recent click only', async () => {
    const latest: { current: ReturnType<typeof useDeepLink> | null } = {
      current: null,
    };
    const { findByText } = await renderWithProvider(
      <Probe onState={(s) => (latest.current = s)} />,
      { config }
    );

    await act(async () => {
      emitNativeEvent('pyrx:push:click', {
        pushLogId: 'first',
        deepLink: 'myapp://first',
        actionId: null,
        pyrxAttrs: {},
      });
    });
    await findByText('myapp://first');

    await act(async () => {
      emitNativeEvent('pyrx:push:click', {
        pushLogId: 'second',
        deepLink: 'myapp://second',
        actionId: null,
        pyrxAttrs: {},
      });
    });
    await findByText('myapp://second');
    expect(latest.current?.lastPushClick?.pushLogId).toBe('second');
  });

  it('cleans up its subscription on unmount', async () => {
    const { unmount } = await renderWithProvider(<Probe onState={() => {}} />, {
      config,
    });
    expect(listenerCount('pyrx:push:click')).toBe(1);
    await unmount();
    expect(listenerCount('pyrx:push:click')).toBe(0);
  });
});
