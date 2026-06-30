/**
 * Tests for `useInAppMessageDismissed(handler)` (Phase 10 PR-2b —
 * 0.3.0).
 *
 * Verifies:
 *   - The handler fires for each native `pyrx:in-app:dismissed`
 *     emit; payload (`messageId`, `reason`) is delivered verbatim.
 *   - `reason: null` is preserved (not coerced to undefined).
 *   - Unmount removes the subscription.
 *   - Multiple subscribers each get every emit.
 *   - Callback identity change does NOT trigger re-subscription.
 */

import { Text } from 'react-native';

import { emitNativeEvent, listenerCount, resetAll } from './helpers/setup';
import { useInAppMessageDismissed } from '../hooks/useInAppMessageDismissed';
import { renderWithProvider } from './helpers/renderWithProvider';
import { __resetInAppForTests } from '../inApp';

const config = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  apiKey: 'psk_test_abc',
  environment: 'sandbox' as const,
};

beforeEach(() => {
  resetAll();
  __resetInAppForTests();
});

describe('useInAppMessageDismissed', () => {
  function Subscriber({
    onDismiss,
  }: {
    onDismiss: (id: string, reason: string | null) => void;
  }) {
    useInAppMessageDismissed(onDismiss);
    return <Text>dismissed-subscribed</Text>;
  }

  it('invokes the handler with messageId + reason', async () => {
    const cb = jest.fn();
    await renderWithProvider(<Subscriber onDismiss={cb} />, { config });

    emitNativeEvent('pyrx:in-app:dismissed', {
      messageId: 'assignment-1',
      reason: 'user_dismissed',
    });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('assignment-1', 'user_dismissed');
  });

  it('preserves reason: null when emitted', async () => {
    const cb = jest.fn();
    await renderWithProvider(<Subscriber onDismiss={cb} />, { config });

    emitNativeEvent('pyrx:in-app:dismissed', {
      messageId: 'assignment-1',
      reason: null,
    });

    expect(cb).toHaveBeenCalledWith('assignment-1', null);
  });

  it('cleans up the subscription on unmount', async () => {
    const cb = jest.fn();
    const { unmount } = await renderWithProvider(
      <Subscriber onDismiss={cb} />,
      {
        config,
      }
    );

    expect(listenerCount('pyrx:in-app:dismissed')).toBe(1);
    await unmount();
    expect(listenerCount('pyrx:in-app:dismissed')).toBe(0);

    emitNativeEvent('pyrx:in-app:dismissed', {
      messageId: 'late',
      reason: null,
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('supports multiple parallel subscribers', async () => {
    const a = jest.fn();
    const b = jest.fn();
    await renderWithProvider(
      <>
        <Subscriber onDismiss={a} />
        <Subscriber onDismiss={b} />
      </>,
      { config }
    );

    emitNativeEvent('pyrx:in-app:dismissed', {
      messageId: 'assignment-1',
      reason: 'cta_dismissed',
    });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-subscribe on callback identity change', async () => {
    const cb1 = jest.fn();
    const { rerender } = await renderWithProvider(
      <Subscriber onDismiss={cb1} />,
      { config }
    );
    expect(listenerCount('pyrx:in-app:dismissed')).toBe(1);

    const cb2 = jest.fn();
    const { SynapseProvider } = await import('../SynapseProvider');
    await rerender(
      <SynapseProvider config={config}>
        <Subscriber onDismiss={cb2} />
      </SynapseProvider>
    );
    expect(listenerCount('pyrx:in-app:dismissed')).toBe(1);

    emitNativeEvent('pyrx:in-app:dismissed', {
      messageId: 'assignment-after',
      reason: null,
    });
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledWith('assignment-after', null);
  });
});
