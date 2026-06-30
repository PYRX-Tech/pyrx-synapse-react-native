/**
 * Tests for `useInAppMessage(placement, callback)` (Phase 10 PR-2b
 * — 0.3.0).
 *
 * Verifies:
 *   - The callback fires for each native `pyrx:in-app:received` emit
 *     whose `placement_key` matches.
 *   - Non-matching placements are filtered out.
 *   - Unmount unregisters via `inAppHideAll` and stops further
 *     callback invocations.
 *   - Callback identity changes do NOT trigger native
 *     re-subscription (the ref pattern keeps the bridge call stable).
 *   - Switching `placement` tears down the old registration and
 *     creates a new one.
 */

import { Text } from 'react-native';
import { act } from 'react';

import { emitNativeEvent, mockNative, resetAll } from './helpers/setup';
import { useInAppMessage } from '../hooks/useInAppMessage';
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

/** Wait for a microtask flush so async-effect chains land. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useInAppMessage', () => {
  function Subscriber({
    placement,
    onMessage,
  }: {
    placement: string;
    onMessage: (msg: InAppMessage) => void;
  }) {
    useInAppMessage(placement, onMessage);
    return <Text>in-app-subscribed</Text>;
  }

  it('registers the placement with the bridge on mount', async () => {
    await renderWithProvider(
      <Subscriber placement="home_banner" onMessage={() => {}} />,
      { config }
    );
    await flush();
    expect(mockNative.inAppShow).toHaveBeenCalledWith('home_banner');
  });

  it('invokes the callback when a matching-placement message is emitted', async () => {
    const cb = jest.fn();
    await renderWithProvider(
      <Subscriber placement="home_banner" onMessage={cb} />,
      { config }
    );
    await flush();

    const msg = makeMessage({ placement_key: 'home_banner' });
    emitNativeEvent('pyrx:in-app:received', msg);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(msg);
  });

  it('does NOT invoke the callback for a non-matching placement', async () => {
    const cb = jest.fn();
    await renderWithProvider(
      <Subscriber placement="home_banner" onMessage={cb} />,
      { config }
    );
    await flush();

    emitNativeEvent(
      'pyrx:in-app:received',
      makeMessage({ placement_key: 'settings_modal' })
    );

    expect(cb).not.toHaveBeenCalled();
  });

  it('unmount calls inAppHideAll and stops further callbacks', async () => {
    const cb = jest.fn();
    const { unmount } = await renderWithProvider(
      <Subscriber placement="home_banner" onMessage={cb} />,
      { config }
    );
    await flush();

    emitNativeEvent('pyrx:in-app:received', makeMessage());
    expect(cb).toHaveBeenCalledTimes(1);

    await unmount();
    // Allow the hook's effect cleanup to run.
    await flush();

    expect(mockNative.inAppHideAll).toHaveBeenCalledTimes(1);

    cb.mockClear();
    emitNativeEvent('pyrx:in-app:received', makeMessage());
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT re-register when only the callback identity changes', async () => {
    const cb1 = jest.fn();
    const { rerender } = await renderWithProvider(
      <Subscriber placement="home_banner" onMessage={cb1} />,
      { config }
    );
    await flush();
    expect(mockNative.inAppShow).toHaveBeenCalledTimes(1);

    const cb2 = jest.fn();
    const { SynapseProvider } = await import('../SynapseProvider');
    await rerender(
      <SynapseProvider config={config}>
        <Subscriber placement="home_banner" onMessage={cb2} />
      </SynapseProvider>
    );
    await flush();

    // Still exactly one native registration — the ref pattern keeps
    // the bridge call stable for the component's lifetime.
    expect(mockNative.inAppShow).toHaveBeenCalledTimes(1);

    // The latest callback identity DOES fire on the next emit (the
    // ref-indirect pattern uses the most recent reference).
    emitNativeEvent('pyrx:in-app:received', makeMessage());
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('re-registers when placement changes', async () => {
    const cb = jest.fn();
    const { rerender } = await renderWithProvider(
      <Subscriber placement="home_banner" onMessage={cb} />,
      { config }
    );
    await flush();
    expect(mockNative.inAppShow).toHaveBeenCalledWith('home_banner');

    const { SynapseProvider } = await import('../SynapseProvider');
    await rerender(
      <SynapseProvider config={config}>
        <Subscriber placement="settings_modal" onMessage={cb} />
      </SynapseProvider>
    );
    await flush();

    expect(mockNative.inAppShow).toHaveBeenCalledTimes(2);
    expect(mockNative.inAppShow).toHaveBeenLastCalledWith('settings_modal');
    // Previous placement registration is torn down.
    expect(mockNative.inAppHideAll).toHaveBeenCalledTimes(1);
  });
});
