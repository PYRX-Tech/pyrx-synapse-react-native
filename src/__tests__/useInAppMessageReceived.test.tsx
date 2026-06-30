/**
 * Tests for `useInAppMessageReceived(callback)` (Phase 10 PR-2b —
 * 0.3.0).
 *
 * Verifies:
 *   - The callback fires for each native `pyrx:in-app:received`
 *     emit regardless of placement.
 *   - Unmount removes the subscription.
 *   - Multiple subscribers each get every emit.
 *   - Callback identity change does NOT trigger re-subscription.
 */

import { Text } from 'react-native';

import { emitNativeEvent, listenerCount, resetAll } from './helpers/setup';
import { useInAppMessageReceived } from '../hooks/useInAppMessageReceived';
import { renderWithProvider } from './helpers/renderWithProvider';
import { __resetInAppForTests } from '../inApp';
import type { InAppMessage } from '../types/in-app';

const config = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  apiKey: 'psk_test_abc',
  environment: 'sandbox' as const,
};

beforeEach(() => {
  resetAll();
  __resetInAppForTests();
});

function makeMessage(overrides: Partial<InAppMessage> = {}): InAppMessage {
  return {
    id: 'assignment-1',
    message_id: 'msg-1',
    placement_key: 'home_banner',
    title: 'Hello',
    body: 'World',
    image_url: null,
    ctas: [],
    custom: {},
    expires_at: null,
    priority: 0,
    ...overrides,
  };
}

describe('useInAppMessageReceived', () => {
  function Subscriber({
    onMessage,
  }: {
    onMessage: (msg: InAppMessage) => void;
  }) {
    useInAppMessageReceived(onMessage);
    return <Text>received-subscribed</Text>;
  }

  it('fires for every in-app message emit regardless of placement', async () => {
    const cb = jest.fn();
    await renderWithProvider(<Subscriber onMessage={cb} />, { config });

    emitNativeEvent(
      'pyrx:in-app:received',
      makeMessage({ placement_key: 'home_banner', id: 'a' })
    );
    emitNativeEvent(
      'pyrx:in-app:received',
      makeMessage({ placement_key: 'settings_modal', id: 'b' })
    );

    expect(cb).toHaveBeenCalledTimes(2);
    expect((cb.mock.calls[0]![0] as InAppMessage).id).toBe('a');
    expect((cb.mock.calls[1]![0] as InAppMessage).id).toBe('b');
  });

  it('cleans up the subscription on unmount', async () => {
    const cb = jest.fn();
    const { unmount } = await renderWithProvider(
      <Subscriber onMessage={cb} />,
      {
        config,
      }
    );

    expect(listenerCount('pyrx:in-app:received')).toBe(1);
    await unmount();
    expect(listenerCount('pyrx:in-app:received')).toBe(0);

    emitNativeEvent('pyrx:in-app:received', makeMessage());
    expect(cb).not.toHaveBeenCalled();
  });

  it('supports multiple parallel subscribers', async () => {
    const a = jest.fn();
    const b = jest.fn();
    await renderWithProvider(
      <>
        <Subscriber onMessage={a} />
        <Subscriber onMessage={b} />
      </>,
      { config }
    );

    emitNativeEvent('pyrx:in-app:received', makeMessage());

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-subscribe on callback identity change', async () => {
    const cb1 = jest.fn();
    const { rerender } = await renderWithProvider(
      <Subscriber onMessage={cb1} />,
      { config }
    );
    expect(listenerCount('pyrx:in-app:received')).toBe(1);

    const cb2 = jest.fn();
    const { SynapseProvider } = await import('../SynapseProvider');
    await rerender(
      <SynapseProvider config={config}>
        <Subscriber onMessage={cb2} />
      </SynapseProvider>
    );
    expect(listenerCount('pyrx:in-app:received')).toBe(1);

    emitNativeEvent('pyrx:in-app:received', makeMessage());
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
