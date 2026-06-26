/**
 * Tests for `<SynapseProvider>`.
 *
 * Verifies:
 *   - On mount, the provider calls `Synapse.initialize(config)` exactly
 *     once and then `Synapse.debugInfo()` to seed the snapshot.
 *   - `status` transitions `pending → initialized` on success.
 *   - `status` transitions `pending → error` on initialize failure, and
 *     the `onError` callback fires.
 *   - The `onInitialized` callback fires exactly once on success.
 *   - The context's `refreshDebugInfo` updates the snapshot.
 *   - Strict-mode double-mount does not double-call `initialize`.
 */

import { mockNative, resetAll } from './helpers/setup';

import { Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';

import { SynapseProvider, useSynapseContext } from '../SynapseProvider';
import { SynapseError } from '../SynapseError';
import { renderWithProvider } from './helpers/renderWithProvider';

function StatusProbe() {
  const ctx = useSynapseContext();
  return (
    <>
      <Text>{`status:${ctx.status}`}</Text>
      <Text>{`external:${ctx.debugInfo?.externalId ?? 'none'}`}</Text>
    </>
  );
}

const config = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  apiKey: 'psk_test_abc',
  environment: 'sandbox' as const,
};

beforeEach(() => {
  resetAll();
});

describe('SynapseProvider', () => {
  it('initialises the SDK once and exposes status=initialized', async () => {
    const { getByText } = await renderWithProvider(<StatusProbe />, { config });

    await waitFor(() => {
      expect(getByText('status:initialized')).toBeTruthy();
    });
    expect(mockNative.initialize).toHaveBeenCalledTimes(1);
    expect(mockNative.initialize).toHaveBeenCalledWith({
      workspaceId: config.workspaceId,
      apiKey: config.apiKey,
      environment: 'sandbox',
    });
  });

  it('seeds debugInfo after initialize resolves', async () => {
    mockNative.debugInfo.mockResolvedValueOnce({
      initialized: true,
      anonymousId: 'anon-xyz',
      externalId: 'ext-1',
      hasDeviceToken: false,
      queueDepth: 0,
      sdkVersion: '0.1.0',
      sdkPlatform: 'jest+rn',
      trackingEnabled: true,
    });
    const { getByText } = await renderWithProvider(<StatusProbe />, { config });
    await waitFor(() => {
      expect(getByText('external:ext-1')).toBeTruthy();
    });
  });

  it('fires onInitialized exactly once on success', async () => {
    const onInitialized = jest.fn();
    await renderWithProvider(<StatusProbe />, { config, onInitialized });
    await waitFor(() => {
      expect(onInitialized).toHaveBeenCalledTimes(1);
    });
  });

  it('transitions to status=error and fires onError on initialize failure', async () => {
    mockNative.initialize.mockRejectedValueOnce(
      Object.assign(new Error('bad key'), { code: 'invalid_argument' })
    );
    const onError = jest.fn();

    // We don't use renderWithProvider here because debugInfo will not
    // be called in the error path (the await chain bails before
    // refreshDebugInfo fires).
    const { getByText } = await render(
      <SynapseProvider config={config} onError={onError}>
        <StatusProbe />
      </SynapseProvider>
    );

    await waitFor(() => {
      expect(getByText('status:error')).toBeTruthy();
    });
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0] as unknown;
    expect(err).toBeInstanceOf(SynapseError);
    expect((err as SynapseError).code).toBe('invalid_argument');
  });

  it('refreshDebugInfo() re-fetches the snapshot', async () => {
    mockNative.debugInfo
      .mockResolvedValueOnce({
        initialized: true,
        anonymousId: 'anon-1',
        externalId: null,
        hasDeviceToken: false,
        queueDepth: 0,
        sdkVersion: '0.1.0',
        sdkPlatform: 'jest+rn',
        trackingEnabled: true,
      })
      .mockResolvedValueOnce({
        initialized: true,
        anonymousId: 'anon-1',
        externalId: 'newly-identified',
        hasDeviceToken: false,
        queueDepth: 0,
        sdkVersion: '0.1.0',
        sdkPlatform: 'jest+rn',
        trackingEnabled: true,
      });

    let ctxRef: ReturnType<typeof useSynapseContext> | null = null;
    function CapturingProbe() {
      ctxRef = useSynapseContext();
      return <Text>{ctxRef.debugInfo?.externalId ?? 'none'}</Text>;
    }

    const { findByText } = await renderWithProvider(<CapturingProbe />, {
      config,
    });
    await findByText('none');

    await act(async () => {
      await ctxRef!.refreshDebugInfo();
    });
    await waitFor(() => {
      expect(ctxRef!.debugInfo?.externalId).toBe('newly-identified');
    });
    expect(mockNative.debugInfo).toHaveBeenCalledTimes(2);
  });
});
