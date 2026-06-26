/**
 * Tests for `usePushPermission`.
 *
 * Verifies:
 *   - Initial state is `notDetermined` while the first read is pending.
 *   - First-mount read populates `status` from the TurboModule.
 *   - `request()` triggers `requestPushPermission` and updates `status`.
 *   - `refresh()` re-reads via `getPushPermissionStatus`.
 *   - `isPending` flips correctly across operations.
 */

import { mockNative, resetAll } from './helpers/setup';

import { act, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { usePushPermission } from '../hooks/usePushPermission';
import { renderWithProvider } from './helpers/renderWithProvider';

function ProbeHarness({
  onState,
}: {
  onState: (s: ReturnType<typeof usePushPermission>) => void;
}) {
  const state = usePushPermission();
  onState(state);
  return <Text>{state.status}</Text>;
}

const config = {
  workspaceId: '550e8400-e29b-41d4-a716-446655440000',
  apiKey: 'psk_test_abc',
  environment: 'sandbox' as const,
};

beforeEach(() => {
  resetAll();
});

describe('usePushPermission', () => {
  it('reads the OS permission state on mount', async () => {
    mockNative.getPushPermissionStatus.mockResolvedValueOnce('granted');
    const latest: { state: ReturnType<typeof usePushPermission> | null } = {
      state: null,
    };

    await renderWithProvider(
      <ProbeHarness onState={(s) => (latest.state = s)} />,
      { config }
    );

    await waitFor(() => {
      expect(latest.state?.status).toBe('granted');
    });
    expect(mockNative.getPushPermissionStatus).toHaveBeenCalledTimes(1);
  });

  it('flips isPending true → false across the first read', async () => {
    const transitions: boolean[] = [];

    await renderWithProvider(
      <ProbeHarness onState={(s) => transitions.push(s.isPending)} />,
      { config }
    );

    await waitFor(() => {
      // The hook starts isPending=true, refresh resolves to false.
      expect(transitions.at(-1)).toBe(false);
    });
    expect(transitions[0]).toBe(true);
  });

  it('request() calls the TurboModule and updates status', async () => {
    mockNative.getPushPermissionStatus.mockResolvedValueOnce('notDetermined');
    mockNative.requestPushPermission.mockResolvedValueOnce('granted');

    const latest: { state: ReturnType<typeof usePushPermission> | null } = {
      state: null,
    };

    await renderWithProvider(
      <ProbeHarness onState={(s) => (latest.state = s)} />,
      { config }
    );

    await waitFor(() => {
      expect(latest.state?.status).toBe('notDetermined');
    });

    let result: string | undefined;
    await act(async () => {
      result = await latest.state!.request({ alert: true, sound: false });
    });
    expect(result).toBe('granted');
    expect(mockNative.requestPushPermission).toHaveBeenCalledWith({
      alert: true,
      sound: false,
      badge: true,
    });
    await waitFor(() => {
      expect(latest.state?.status).toBe('granted');
    });
  });

  it('refresh() re-reads getPushPermissionStatus', async () => {
    mockNative.getPushPermissionStatus
      .mockResolvedValueOnce('notDetermined')
      .mockResolvedValueOnce('denied');

    const latest: { state: ReturnType<typeof usePushPermission> | null } = {
      state: null,
    };
    await renderWithProvider(
      <ProbeHarness onState={(s) => (latest.state = s)} />,
      { config }
    );

    await waitFor(() => {
      expect(latest.state?.status).toBe('notDetermined');
    });

    await act(async () => {
      await latest.state!.refresh();
    });

    await waitFor(() => {
      expect(latest.state?.status).toBe('denied');
    });
    expect(mockNative.getPushPermissionStatus).toHaveBeenCalledTimes(2);
  });

  it('does not call requestPushPermission when only refresh is used', async () => {
    const latest: { state: ReturnType<typeof usePushPermission> | null } = {
      state: null,
    };
    await renderWithProvider(
      <ProbeHarness onState={(s) => (latest.state = s)} />,
      { config }
    );

    await waitFor(() => {
      expect(latest.state).not.toBeNull();
    });

    expect(mockNative.requestPushPermission).not.toHaveBeenCalled();
  });
});
