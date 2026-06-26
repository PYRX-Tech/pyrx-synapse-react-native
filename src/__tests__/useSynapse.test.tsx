/**
 * Tests for `useSynapse`.
 *
 * Verifies:
 *   - Returned shape mirrors the contract: status + reactive snapshot
 *     accessors + imperative API methods.
 *   - Identity-mutating methods (identify, alias, logout, deleteUser)
 *     auto-refresh debugInfo afterwards so derived accessors
 *     (`externalId`, `anonymousId`) stay current.
 *   - Non-mutating methods (track, screen, etc.) do NOT trigger a
 *     debugInfo refresh.
 *   - Stable methods retain identity across re-renders (matters for
 *     callers passing them into useEffect deps).
 */

import { mockNative, resetAll } from './helpers/setup';

import { Text } from 'react-native';
import { act, waitFor } from '@testing-library/react-native';

import { useSynapse } from '../hooks/useSynapse';
import { renderWithProvider } from './helpers/renderWithProvider';

function Probe({
  onState,
}: {
  onState: (state: ReturnType<typeof useSynapse>) => void;
}) {
  const state = useSynapse();
  onState(state);
  return <Text>{state.externalId ?? 'none'}</Text>;
}

const config = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  apiKey: 'psk_test_abc',
  environment: 'sandbox' as const,
};

beforeEach(() => {
  resetAll();
});

describe('useSynapse', () => {
  it('exposes lifecycle state once the provider settles', async () => {
    let latest: ReturnType<typeof useSynapse> | null = null;
    await renderWithProvider(<Probe onState={(s) => (latest = s)} />, {
      config,
    });

    await waitFor(() => {
      expect(latest?.isInitialized).toBe(true);
    });
    expect(latest!.isPending).toBe(false);
    expect(latest!.error).toBeNull();
    expect(latest!.debugInfo).not.toBeNull();
  });

  it('derives anonymousId / externalId / queueDepth from debugInfo', async () => {
    mockNative.debugInfo.mockResolvedValueOnce({
      initialized: true,
      anonymousId: 'anon-derived',
      externalId: 'ext-derived',
      hasDeviceToken: true,
      queueDepth: 7,
      sdkVersion: '0.1.0',
      sdkPlatform: 'jest+rn',
      trackingEnabled: true,
    });
    let latest: ReturnType<typeof useSynapse> | null = null;
    await renderWithProvider(<Probe onState={(s) => (latest = s)} />, {
      config,
    });

    await waitFor(() => {
      expect(latest?.anonymousId).toBe('anon-derived');
    });
    expect(latest!.externalId).toBe('ext-derived');
    expect(latest!.queueDepth).toBe(7);
  });

  it('identify() forwards to the TurboModule and triggers a debugInfo refresh', async () => {
    let latest: ReturnType<typeof useSynapse> | null = null;
    await renderWithProvider(<Probe onState={(s) => (latest = s)} />, {
      config,
    });
    await waitFor(() => {
      expect(latest?.isInitialized).toBe(true);
    });

    const callsBefore = mockNative.debugInfo.mock.calls.length;
    await act(async () => {
      await latest!.identify('user-7', { plan: 'pro' });
    });

    expect(mockNative.identify).toHaveBeenCalledWith(
      'user-7',
      JSON.stringify({ plan: 'pro' })
    );
    expect(mockNative.debugInfo.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('track() does NOT trigger a debugInfo refresh', async () => {
    let latest: ReturnType<typeof useSynapse> | null = null;
    await renderWithProvider(<Probe onState={(s) => (latest = s)} />, {
      config,
    });
    await waitFor(() => {
      expect(latest?.isInitialized).toBe(true);
    });

    const callsBefore = mockNative.debugInfo.mock.calls.length;
    await act(async () => {
      await latest!.track('clicked', { button: 'cta' });
    });

    expect(mockNative.track).toHaveBeenCalled();
    expect(mockNative.debugInfo.mock.calls.length).toBe(callsBefore);
  });

  it('logout() and deleteUser() also refresh debugInfo', async () => {
    let latest: ReturnType<typeof useSynapse> | null = null;
    await renderWithProvider(<Probe onState={(s) => (latest = s)} />, {
      config,
    });
    await waitFor(() => {
      expect(latest?.isInitialized).toBe(true);
    });

    const before = mockNative.debugInfo.mock.calls.length;
    await act(async () => {
      await latest!.logout();
    });
    expect(mockNative.logout).toHaveBeenCalled();
    const afterLogout = mockNative.debugInfo.mock.calls.length;
    expect(afterLogout).toBeGreaterThan(before);

    await act(async () => {
      await latest!.deleteUser();
    });
    expect(mockNative.deleteUser).toHaveBeenCalled();
    expect(mockNative.debugInfo.mock.calls.length).toBeGreaterThan(afterLogout);
  });

  it('stable methods keep identity across rerenders', async () => {
    const captured: Array<{
      track: ReturnType<typeof useSynapse>['track'];
      screen: ReturnType<typeof useSynapse>['screen'];
      setLogLevel: ReturnType<typeof useSynapse>['setLogLevel'];
    }> = [];

    const { rerender } = await renderWithProvider(
      <Probe
        onState={(s) =>
          captured.push({
            track: s.track,
            screen: s.screen,
            setLogLevel: s.setLogLevel,
          })
        }
      />,
      { config }
    );

    await waitFor(() => {
      expect(captured.length).toBeGreaterThanOrEqual(2);
    });

    // Force an extra render so we have multiple snapshots to compare.
    await rerender(
      <Probe
        onState={(s) =>
          captured.push({
            track: s.track,
            screen: s.screen,
            setLogLevel: s.setLogLevel,
          })
        }
      />
    );

    const refs = captured.slice(-3);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    const [a, b] = refs;
    expect(a!.track).toBe(b!.track);
    expect(a!.screen).toBe(b!.screen);
    expect(a!.setLogLevel).toBe(b!.setLogLevel);
  });
});
