/**
 * Tests for `useIdentify`.
 *
 * Verifies:
 *   - Imperative form: returns an `identify` callback that forwards.
 *   - Auto-identify form: calls Synapse.identify when userId changes.
 *   - Calling with userId=null or undefined is a no-op.
 *   - Same userId between renders does not refire identify.
 *   - Trait change (via JSON-key) triggers a fresh identify.
 *   - `onError` callback receives `SynapseError` on failure.
 */

import { mockNative, resetAll } from './helpers/setup';

import type React from 'react';
import { Text } from 'react-native';
import { act, waitFor } from '@testing-library/react-native';

import { useIdentify } from '../hooks/useIdentify';
import { SynapseError } from '../SynapseError';
import { SynapseProvider } from '../SynapseProvider';
import { renderWithProvider } from './helpers/renderWithProvider';

const config = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  apiKey: 'psk_test_abc',
  environment: 'sandbox' as const,
};

beforeEach(() => {
  resetAll();
});

describe('useIdentify (imperative form)', () => {
  function ImperativeProbe({
    onApi,
  }: {
    onApi: (s: ReturnType<typeof useIdentify>) => void;
  }) {
    const state = useIdentify();
    onApi(state);
    return <Text>{state.externalId ?? 'none'}</Text>;
  }

  it('returns an identify() callback that forwards to the TurboModule', async () => {
    let api: ReturnType<typeof useIdentify> | null = null;
    await renderWithProvider(<ImperativeProbe onApi={(s) => (api = s)} />, {
      config,
    });

    await act(async () => {
      await api!.identify('user-9');
    });
    expect(mockNative.identify).toHaveBeenCalledWith('user-9', null);
  });

  it('does NOT auto-fire identify in the imperative form', async () => {
    await renderWithProvider(<ImperativeProbe onApi={() => {}} />, { config });
    // Allow a few ticks for any rogue effects to fire.
    await waitFor(() => {
      expect(mockNative.initialize).toHaveBeenCalled();
    });
    expect(mockNative.identify).not.toHaveBeenCalled();
  });
});

describe('useIdentify (auto-identify form)', () => {
  function AutoProbe({
    userId,
    traits,
    onError,
  }: {
    userId: string | null | undefined;
    traits?: Record<string, string | number | boolean | null>;
    onError?: (e: SynapseError) => void;
  }) {
    useIdentify(userId, traits, { onError });
    return <Text>{userId ?? 'null'}</Text>;
  }

  // Wrap helper: rerender uses the whole provider+child tree so the
  // provider context isn't torn down between rerenders.
  function wrap(node: React.ReactElement) {
    return <SynapseProvider config={config}>{node}</SynapseProvider>;
  }

  it('calls identify exactly once for a stable userId', async () => {
    const { rerender } = await renderWithProvider(
      <AutoProbe userId="user-1" />,
      { config }
    );

    await waitFor(() => {
      expect(mockNative.identify).toHaveBeenCalledWith('user-1', null);
    });

    await rerender(wrap(<AutoProbe userId="user-1" />));
    await rerender(wrap(<AutoProbe userId="user-1" />));
    expect(mockNative.identify).toHaveBeenCalledTimes(1);
  });

  it('re-calls identify when userId changes', async () => {
    const { rerender } = await renderWithProvider(
      <AutoProbe userId="alice" />,
      { config }
    );
    await waitFor(() => {
      expect(mockNative.identify).toHaveBeenCalledWith('alice', null);
    });

    await rerender(wrap(<AutoProbe userId="bob" />));
    await waitFor(() => {
      expect(mockNative.identify).toHaveBeenLastCalledWith('bob', null);
    });
    expect(mockNative.identify).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when userId is null or empty', async () => {
    const { rerender } = await renderWithProvider(<AutoProbe userId={null} />, {
      config,
    });
    await waitFor(() => {
      expect(mockNative.initialize).toHaveBeenCalled();
    });
    expect(mockNative.identify).not.toHaveBeenCalled();

    await rerender(wrap(<AutoProbe userId="" />));
    expect(mockNative.identify).not.toHaveBeenCalled();
  });

  it('re-calls identify when traits change', async () => {
    const { rerender } = await renderWithProvider(
      <AutoProbe userId="carol" traits={{ plan: 'free' }} />,
      { config }
    );
    await waitFor(() => {
      expect(mockNative.identify).toHaveBeenCalledWith(
        'carol',
        JSON.stringify({ plan: 'free' })
      );
    });

    await rerender(wrap(<AutoProbe userId="carol" traits={{ plan: 'pro' }} />));
    await waitFor(() => {
      expect(mockNative.identify).toHaveBeenLastCalledWith(
        'carol',
        JSON.stringify({ plan: 'pro' })
      );
    });
    expect(mockNative.identify).toHaveBeenCalledTimes(2);
  });

  it('forwards errors to the onError callback as SynapseError', async () => {
    mockNative.identify.mockRejectedValueOnce(
      Object.assign(new Error('rate-limited'), { code: 'network_error' })
    );
    const onError = jest.fn();

    await renderWithProvider(<AutoProbe userId="dave" onError={onError} />, {
      config,
    });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    const err = onError.mock.calls[0]?.[0] as unknown;
    expect(err).toBeInstanceOf(SynapseError);
    expect((err as SynapseError).code).toBe('network_error');
  });

  it('exposes derived isIdentified flag from the provider state', async () => {
    mockNative.debugInfo.mockResolvedValueOnce({
      initialized: true,
      anonymousId: 'anon-x',
      externalId: 'erin',
      hasDeviceToken: false,
      queueDepth: 0,
      sdkVersion: '0.1.0',
      sdkPlatform: 'jest+rn',
      trackingEnabled: true,
    });

    let api: ReturnType<typeof useIdentify> | null = null;
    function Captor() {
      api = useIdentify();
      return null;
    }
    await renderWithProvider(<Captor />, { config });
    await waitFor(() => {
      expect(api?.isIdentified).toBe(true);
      expect(api?.externalId).toBe('erin');
    });
  });
});
