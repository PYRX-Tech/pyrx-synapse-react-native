/**
 * Tests for `usePushClicked`. Mirrors the `usePushReceived` shape since
 * the two hooks have identical subscription semantics — the only
 * difference is the event name.
 */

import { emitNativeEvent, listenerCount, resetAll } from './helpers/setup';

import { Text } from 'react-native';

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

describe('usePushClicked', () => {
  function Subscriber({ onClick }: { onClick: (e: unknown) => void }) {
    usePushClicked(onClick);
    return <Text>subscribed</Text>;
  }

  it('invokes the callback when a click is emitted', async () => {
    const handler = jest.fn();
    await renderWithProvider(<Subscriber onClick={handler} />, { config });

    emitNativeEvent('pyrx:push:click', {
      pushLogId: 'plog_1',
      deepLink: 'myapp://orders/123',
      actionId: null,
      pyrxAttrs: {},
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      pushLogId: 'plog_1',
      deepLink: 'myapp://orders/123',
      actionId: null,
      pyrxAttrs: {},
    });
  });

  it('cleans up its subscription on unmount', async () => {
    const handler = jest.fn();
    const { unmount } = await renderWithProvider(
      <Subscriber onClick={handler} />,
      { config }
    );

    expect(listenerCount('pyrx:push:click')).toBe(1);
    await unmount();
    expect(listenerCount('pyrx:push:click')).toBe(0);

    emitNativeEvent('pyrx:push:click', {
      pushLogId: 'plog_after',
      deepLink: null,
      actionId: null,
      pyrxAttrs: {},
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not fan out to non-click event names', async () => {
    const handler = jest.fn();
    await renderWithProvider(<Subscriber onClick={handler} />, { config });

    emitNativeEvent('pyrx:push:received', {
      title: 't',
      body: 'b',
      data: {},
      pyrxAttrs: {},
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
