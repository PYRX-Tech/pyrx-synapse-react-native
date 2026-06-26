/**
 * Tests for `usePushReceived`.
 *
 * Verifies:
 *   - The callback fires for each native `pyrx:push:received` emit.
 *   - Unmount removes the subscription (no further callbacks after).
 *   - Multiple components subscribing each get every emit.
 *   - A changed callback identity does NOT trigger re-subscription
 *     storms (the implementation uses a ref to keep the native
 *     subscription stable for the component's lifetime).
 */

import { emitNativeEvent, listenerCount, resetAll } from './helpers/setup';

import { Text } from 'react-native';

import { usePushReceived } from '../hooks/usePushReceived';
import { renderWithProvider } from './helpers/renderWithProvider';

const config = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  apiKey: 'psk_test_abc',
  environment: 'sandbox' as const,
};

beforeEach(() => {
  resetAll();
});

describe('usePushReceived', () => {
  function Subscriber({ onPush }: { onPush: (e: unknown) => void }) {
    usePushReceived(onPush);
    return <Text>subscribed</Text>;
  }

  it('invokes the callback when a foreground push is emitted', async () => {
    const handler = jest.fn();
    await renderWithProvider(<Subscriber onPush={handler} />, { config });

    emitNativeEvent('pyrx:push:received', {
      title: 't',
      body: 'b',
      data: {},
      pyrxAttrs: { tenant_id: 't1' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      title: 't',
      body: 'b',
      data: {},
      pyrxAttrs: { tenant_id: 't1' },
    });
  });

  it('cleans up its subscription on unmount', async () => {
    const handler = jest.fn();
    const { unmount } = await renderWithProvider(
      <Subscriber onPush={handler} />,
      { config }
    );

    expect(listenerCount('pyrx:push:received')).toBe(1);
    await unmount();
    expect(listenerCount('pyrx:push:received')).toBe(0);

    emitNativeEvent('pyrx:push:received', {
      title: 'after',
      body: 'unmount',
      data: {},
      pyrxAttrs: {},
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple parallel subscribers', async () => {
    const a = jest.fn();
    const b = jest.fn();
    await renderWithProvider(
      <>
        <Subscriber onPush={a} />
        <Subscriber onPush={b} />
      </>,
      { config }
    );

    emitNativeEvent('pyrx:push:received', {
      title: 't',
      body: 'b',
      data: {},
      pyrxAttrs: {},
    });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-subscribe on callback identity change', async () => {
    const handler = jest.fn();
    const { rerender } = await renderWithProvider(
      <Subscriber onPush={handler} />,
      { config }
    );
    expect(listenerCount('pyrx:push:received')).toBe(1);

    // Pass a different callback ref but keep the rendering tree intact
    // so React reuses the same component instance.
    const handler2 = jest.fn();
    const { SynapseProvider } = await import('../SynapseProvider');
    await rerender(
      <SynapseProvider config={config}>
        <Subscriber onPush={handler2} />
      </SynapseProvider>
    );

    // Still exactly one subscription.
    expect(listenerCount('pyrx:push:received')).toBe(1);

    emitNativeEvent('pyrx:push:received', {
      title: 't',
      body: 'b',
      data: {},
      pyrxAttrs: {},
    });
    expect(handler).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });
});
