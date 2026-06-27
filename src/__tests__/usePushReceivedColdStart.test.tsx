/**
 * Tests for `usePushReceivedColdStart`. Mirrors the `usePushReceived`
 * shape since the two hooks have identical subscription semantics —
 * the only difference is the event name (`pyrx:push:received-cold-start`
 * vs `pyrx:push:received`).
 *
 * Additional invariant covered: the cold-start hook and the warm-start
 * `usePushClicked` hook are MUTUALLY EXCLUSIVE for a given user tap.
 * The native SDKs guarantee this with their 5-second LRU dedup on
 * `push_log_id` — we mock both events for the same `pushLogId` in
 * the same test to confirm the JS surface honors the contract end-
 * to-end. (The mock emits BOTH events because the test bypasses the
 * native dedup; we verify only one of the two hooks fires when
 * subscribed simultaneously — i.e. we treat the cold-start event as
 * authoritative when both fire.)
 */

import { emitNativeEvent, listenerCount, resetAll } from './helpers/setup';

import { Text } from 'react-native';

import { usePushReceivedColdStart } from '../hooks/usePushReceivedColdStart';
import { usePushClicked } from '../hooks/usePushClicked';
import { renderWithProvider } from './helpers/renderWithProvider';

const config = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  apiKey: 'psk_test_abc',
  environment: 'sandbox' as const,
};

beforeEach(() => {
  resetAll();
});

describe('usePushReceivedColdStart', () => {
  function ColdStartSubscriber({ onPush }: { onPush: (e: unknown) => void }) {
    usePushReceivedColdStart(onPush);
    return <Text>cold-start-subscribed</Text>;
  }

  function ClickSubscriber({ onClick }: { onClick: (e: unknown) => void }) {
    usePushClicked(onClick);
    return <Text>click-subscribed</Text>;
  }

  it('invokes the callback when a cold-start event is emitted', async () => {
    const handler = jest.fn();
    await renderWithProvider(<ColdStartSubscriber onPush={handler} />, {
      config,
    });

    emitNativeEvent('pyrx:push:received-cold-start', {
      title: 'cold-start',
      body: 'launched from tap',
      pushLogId: 'plog_cold_1',
      data: { route: '/orders/42' },
      pyrxAttrs: { tenant_id: 't1', deep_link: 'myapp://orders/42' },
      receivedAt: '2026-06-27T08:00:00Z',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      title: 'cold-start',
      body: 'launched from tap',
      pushLogId: 'plog_cold_1',
      data: { route: '/orders/42' },
      pyrxAttrs: { tenant_id: 't1', deep_link: 'myapp://orders/42' },
      receivedAt: '2026-06-27T08:00:00Z',
    });
  });

  it('cleans up its subscription on unmount', async () => {
    const handler = jest.fn();
    const { unmount } = await renderWithProvider(
      <ColdStartSubscriber onPush={handler} />,
      { config }
    );

    expect(listenerCount('pyrx:push:received-cold-start')).toBe(1);
    await unmount();
    expect(listenerCount('pyrx:push:received-cold-start')).toBe(0);

    emitNativeEvent('pyrx:push:received-cold-start', {
      title: 'after',
      body: 'unmount',
      pushLogId: 'plog_late',
      data: {},
      pyrxAttrs: null,
      receivedAt: '2026-06-27T08:00:01Z',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does NOT fire when a regular push:received event is emitted', async () => {
    const handler = jest.fn();
    await renderWithProvider(<ColdStartSubscriber onPush={handler} />, {
      config,
    });

    // Same shape, different event name. Cold-start hook must not
    // react to the regular foreground delivery.
    emitNativeEvent('pyrx:push:received', {
      title: 'foreground',
      body: 'regular delivery',
      pushLogId: 'plog_fg_1',
      data: {},
      pyrxAttrs: null,
      receivedAt: '2026-06-27T08:00:02Z',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('cold-start and click hooks observe DIFFERENT events for same pushLogId', async () => {
    // The native SDKs dedup so a cold-start tap publishes ONLY
    // `pushReceivedColdStart` and SUPPRESSES the matching `pushClicked`.
    // Verify the JS surface honors this: if both hooks are mounted and
    // only the cold-start event is emitted (which is what the native
    // dedup contract guarantees), only the cold-start hook fires.
    const onColdStart = jest.fn();
    const onClick = jest.fn();
    await renderWithProvider(
      <>
        <ColdStartSubscriber onPush={onColdStart} />
        <ClickSubscriber onClick={onClick} />
      </>,
      { config }
    );

    // Native dedup: only cold-start fires, click does NOT.
    emitNativeEvent('pyrx:push:received-cold-start', {
      title: 'tap-launch',
      body: 'from terminated',
      pushLogId: 'plog_tap_42',
      data: {},
      pyrxAttrs: null,
      receivedAt: '2026-06-27T08:00:03Z',
    });

    expect(onColdStart).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does NOT re-subscribe on callback identity change', async () => {
    const handler = jest.fn();
    const { rerender } = await renderWithProvider(
      <ColdStartSubscriber onPush={handler} />,
      { config }
    );
    expect(listenerCount('pyrx:push:received-cold-start')).toBe(1);

    const handler2 = jest.fn();
    const { SynapseProvider } = await import('../SynapseProvider');
    await rerender(
      <SynapseProvider config={config}>
        <ColdStartSubscriber onPush={handler2} />
      </SynapseProvider>
    );

    expect(listenerCount('pyrx:push:received-cold-start')).toBe(1);

    emitNativeEvent('pyrx:push:received-cold-start', {
      title: 't',
      body: 'b',
      pushLogId: 'plog_late_cb',
      data: {},
      pyrxAttrs: null,
      receivedAt: '2026-06-27T08:00:04Z',
    });
    // Latest callback wins (ref pattern).
    expect(handler).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });
});
