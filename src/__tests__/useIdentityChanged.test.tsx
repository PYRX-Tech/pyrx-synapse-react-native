/**
 * Tests for `useIdentityChanged`. Verifies:
 *   - The callback fires for each native `pyrx:identity:changed` emit.
 *   - The `{ before, after }` shape is delivered verbatim.
 *   - `before` is null for the very first identify of a fresh install;
 *     non-null for subsequent transitions (login → switch → logout).
 *   - Subscription cleanup on unmount.
 *   - Multi-subscriber: two hooks at once each get every event.
 *   - Callback identity change doesn't trigger native re-subscription.
 *
 * Note on `before == null` semantics: the JS hook does not enforce
 * the "only on fresh install" rule — that's a NATIVE-side invariant
 * documented in the SDK observer surface. The hook simply hands the
 * payload through. These tests confirm the JS surface preserves the
 * native semantic (we emit `before: null` and verify the callback
 * receives null, vs `before: {...}` and verifies it receives the
 * object).
 */

import { emitNativeEvent, listenerCount, resetAll } from './helpers/setup';

import { Text } from 'react-native';

import { useIdentityChanged } from '../hooks/useIdentityChanged';
import { renderWithProvider } from './helpers/renderWithProvider';

const config = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  apiKey: 'psk_test_abc',
  environment: 'sandbox' as const,
};

beforeEach(() => {
  resetAll();
});

describe('useIdentityChanged', () => {
  function Subscriber({ onIdentity }: { onIdentity: (e: unknown) => void }) {
    useIdentityChanged(onIdentity);
    return <Text>identity-subscribed</Text>;
  }

  it('invokes the callback when an identity transition fires', async () => {
    const handler = jest.fn();
    await renderWithProvider(<Subscriber onIdentity={handler} />, { config });

    const after = {
      anonymousId: 'anon-uuid-1',
      externalId: 'user-42',
      snapshotAt: '2026-06-27T09:00:01Z',
    };

    emitNativeEvent('pyrx:identity:changed', {
      before: null, // Fresh-install first identify.
      after,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ before: null, after });
  });

  it('delivers before/after for a login transition (before non-null, externalId null → set)', async () => {
    const handler = jest.fn();
    await renderWithProvider(<Subscriber onIdentity={handler} />, { config });

    const before = {
      anonymousId: 'anon-uuid-1',
      externalId: null,
      snapshotAt: '2026-06-27T09:00:00Z',
    };
    const after = {
      anonymousId: 'anon-uuid-1',
      externalId: 'user-42',
      snapshotAt: '2026-06-27T09:00:01Z',
    };

    emitNativeEvent('pyrx:identity:changed', { before, after });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ before, after });
    // Consumer-side login detection per the documented contract:
    const payload = handler.mock.calls[0]![0] as {
      before: typeof before | null;
      after: typeof after;
    };
    const isLogin =
      payload.before?.externalId == null && payload.after.externalId != null;
    expect(isLogin).toBe(true);
  });

  it('delivers before/after for a logout transition (externalId set → null)', async () => {
    const handler = jest.fn();
    await renderWithProvider(<Subscriber onIdentity={handler} />, { config });

    const before = {
      anonymousId: 'anon-uuid-1',
      externalId: 'user-42',
      snapshotAt: '2026-06-27T09:01:00Z',
    };
    const after = {
      anonymousId: 'anon-uuid-1',
      externalId: null,
      snapshotAt: '2026-06-27T09:01:01Z',
    };

    emitNativeEvent('pyrx:identity:changed', { before, after });

    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0]![0] as {
      before: typeof before;
      after: typeof after;
    };
    const isLogout =
      payload.before.externalId != null && payload.after.externalId == null;
    expect(isLogout).toBe(true);
  });

  it('preserves before:null when emitted (no defaulting to an empty snapshot)', async () => {
    const handler = jest.fn();
    await renderWithProvider(<Subscriber onIdentity={handler} />, { config });

    const after = {
      anonymousId: 'anon-uuid-fresh',
      externalId: 'first-ever-id',
      snapshotAt: '2026-06-27T10:00:00Z',
    };

    emitNativeEvent('pyrx:identity:changed', { before: null, after });

    const payload = handler.mock.calls[0]![0] as {
      before: object | null;
      after: object;
    };
    expect(payload.before).toBeNull();
    expect(payload.after).toEqual(after);
  });

  it('cleans up its subscription on unmount', async () => {
    const handler = jest.fn();
    const { unmount } = await renderWithProvider(
      <Subscriber onIdentity={handler} />,
      { config }
    );

    expect(listenerCount('pyrx:identity:changed')).toBe(1);
    await unmount();
    expect(listenerCount('pyrx:identity:changed')).toBe(0);

    emitNativeEvent('pyrx:identity:changed', {
      before: null,
      after: {
        anonymousId: 'anon-x',
        externalId: 'late',
        snapshotAt: '2026-06-27T11:00:00Z',
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple parallel subscribers', async () => {
    const a = jest.fn();
    const b = jest.fn();
    await renderWithProvider(
      <>
        <Subscriber onIdentity={a} />
        <Subscriber onIdentity={b} />
      </>,
      { config }
    );

    emitNativeEvent('pyrx:identity:changed', {
      before: null,
      after: {
        anonymousId: 'anon-multi',
        externalId: 'multi-user',
        snapshotAt: '2026-06-27T12:00:00Z',
      },
    });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-subscribe on callback identity change', async () => {
    const handler = jest.fn();
    const { rerender } = await renderWithProvider(
      <Subscriber onIdentity={handler} />,
      { config }
    );
    expect(listenerCount('pyrx:identity:changed')).toBe(1);

    const handler2 = jest.fn();
    const { SynapseProvider } = await import('../SynapseProvider');
    await rerender(
      <SynapseProvider config={config}>
        <Subscriber onIdentity={handler2} />
      </SynapseProvider>
    );

    expect(listenerCount('pyrx:identity:changed')).toBe(1);

    emitNativeEvent('pyrx:identity:changed', {
      before: null,
      after: {
        anonymousId: 'anon-ref',
        externalId: 'after-rerender',
        snapshotAt: '2026-06-27T13:00:00Z',
      },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });
});
