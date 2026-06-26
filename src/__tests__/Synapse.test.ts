/**
 * Tests for the `Synapse` imperative namespace.
 *
 * Goal: prove each method on the namespace
 *   1. Validates its arguments at the JS boundary (fast-fail with
 *      `SynapseError('invalid_argument', ...)` before crossing the bridge).
 *   2. Invokes the TurboModule with the correct marshalled shape
 *      (especially: properties / traits become a JSON string; optional
 *      payloads become `null`).
 *   3. Resolves with the TurboModule's return value (untransformed).
 *   4. Rejects with a `SynapseError` whose `code` mirrors the native
 *      rejection's `code`.
 *
 * The TurboModule is mocked via `./helpers/setup` which hoists a
 * `jest.mock('../NativePyrxSynapse', ...)` above all imports.
 */

import { mockNative, resetAll } from './helpers/setup';
import { Synapse } from '../Synapse';
import { SynapseError } from '../SynapseError';

beforeEach(() => {
  resetAll();
});

describe('Synapse.initialize', () => {
  const validConfig = {
    workspaceId: '550e8400-e29b-41d4-a716-446655440000',
    apiKey: 'psk_live_abc123',
    environment: 'production' as const,
  };

  it('invokes the TurboModule with a plain bridge-shaped config', async () => {
    await Synapse.initialize(validConfig);

    expect(mockNative.initialize).toHaveBeenCalledTimes(1);
    expect(mockNative.initialize).toHaveBeenCalledWith({
      workspaceId: validConfig.workspaceId,
      apiKey: validConfig.apiKey,
      environment: 'production',
    });
  });

  it('forwards optional fields when present and omits them otherwise', async () => {
    await Synapse.initialize({
      ...validConfig,
      baseUrl: 'https://example.com',
      logLevel: 'debug',
      maxQueueSize: 500,
    });

    expect(mockNative.initialize).toHaveBeenCalledWith({
      workspaceId: validConfig.workspaceId,
      apiKey: validConfig.apiKey,
      environment: 'production',
      baseUrl: 'https://example.com',
      logLevel: 'debug',
      maxQueueSize: 500,
    });
  });

  it('rejects with invalid_argument when workspaceId is empty', async () => {
    await expect(
      Synapse.initialize({ ...validConfig, workspaceId: '' })
    ).rejects.toMatchObject({
      name: 'SynapseError',
      code: 'invalid_argument',
    });
    expect(mockNative.initialize).not.toHaveBeenCalled();
  });

  it('rejects with invalid_argument when apiKey is missing', async () => {
    await expect(
      Synapse.initialize({
        ...validConfig,
        apiKey: '',
      })
    ).rejects.toBeInstanceOf(SynapseError);
    expect(mockNative.initialize).not.toHaveBeenCalled();
  });

  it('rejects with invalid_argument when environment is not "production" | "sandbox"', async () => {
    await expect(
      Synapse.initialize({
        ...validConfig,
        // Cast through unknown to bypass TS — runtime guard is what we test.
        environment: 'staging' as unknown as 'production',
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(mockNative.initialize).not.toHaveBeenCalled();
  });

  it('rejects with invalid_argument when maxQueueSize is non-positive', async () => {
    await expect(
      Synapse.initialize({ ...validConfig, maxQueueSize: 0 })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(
      Synapse.initialize({ ...validConfig, maxQueueSize: -1 })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(
      Synapse.initialize({ ...validConfig, maxQueueSize: Number.NaN })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(mockNative.initialize).not.toHaveBeenCalled();
  });

  it('lifts native rejection into a SynapseError preserving the code', async () => {
    const nativeErr = Object.assign(new Error('boom'), {
      code: 'network_error',
    });
    mockNative.initialize.mockRejectedValueOnce(nativeErr);

    await expect(Synapse.initialize(validConfig)).rejects.toMatchObject({
      name: 'SynapseError',
      code: 'network_error',
      message: 'boom',
    });
  });
});

describe('Synapse.setLogLevel', () => {
  it('forwards the level to the bridge', async () => {
    await Synapse.setLogLevel('debug');
    expect(mockNative.setLogLevel).toHaveBeenCalledWith('debug');
  });

  it('rejects empty strings', async () => {
    await expect(Synapse.setLogLevel('' as 'debug')).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });
});

describe('Synapse.debugInfo', () => {
  it('passes through the TurboModule result unchanged', async () => {
    const fixture = {
      initialized: true,
      anonymousId: 'anon-xyz',
      externalId: 'ext-1',
      hasDeviceToken: true,
      queueDepth: 42,
      sdkVersion: '0.1.0',
      sdkPlatform: 'ios+rn',
      trackingEnabled: false,
    };
    mockNative.debugInfo.mockResolvedValueOnce(fixture);
    await expect(Synapse.debugInfo()).resolves.toEqual(fixture);
  });
});

describe('Synapse.identify', () => {
  it('JSON-encodes traits before crossing the bridge', async () => {
    await Synapse.identify('user-123', { plan: 'pro', count: 3 });

    expect(mockNative.identify).toHaveBeenCalledWith(
      'user-123',
      JSON.stringify({ plan: 'pro', count: 3 })
    );
  });

  it('passes null when traits are omitted', async () => {
    await Synapse.identify('user-123');
    expect(mockNative.identify).toHaveBeenCalledWith('user-123', null);
  });

  it('rejects empty externalId without crossing the bridge', async () => {
    await expect(Synapse.identify('')).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    expect(mockNative.identify).not.toHaveBeenCalled();
  });

  it('rejects non-object traits (array)', async () => {
    await expect(
      Synapse.identify('user-123', ['not-an-object'] as unknown as Record<
        string,
        string
      >)
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(mockNative.identify).not.toHaveBeenCalled();
  });

  it('returns the bridge result unchanged', async () => {
    const result = {
      contactId: 'c1',
      path: 'known_exists',
      aliasedExternalId: 'old-id',
      eventsReattributed: 5,
      devicesReattributed: 1,
      anonymousContactTombstoned: true,
    };
    mockNative.identify.mockResolvedValueOnce(result);
    await expect(Synapse.identify('user-123')).resolves.toEqual(result);
  });
});

describe('Synapse.alias', () => {
  it('forwards the new external id', async () => {
    await Synapse.alias('new-user-id');
    expect(mockNative.alias).toHaveBeenCalledWith('new-user-id');
  });

  it('rejects empty input', async () => {
    await expect(Synapse.alias('')).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });
});

describe('Synapse.logout', () => {
  it('invokes the TurboModule', async () => {
    await Synapse.logout();
    expect(mockNative.logout).toHaveBeenCalledTimes(1);
  });
});

describe('Synapse.track', () => {
  it('JSON-encodes properties', async () => {
    await Synapse.track('order.completed', { amount: 49.99, currency: 'USD' });
    expect(mockNative.track).toHaveBeenCalledWith(
      'order.completed',
      JSON.stringify({ amount: 49.99, currency: 'USD' })
    );
  });

  it('passes null when properties are omitted', async () => {
    await Synapse.track('order.completed');
    expect(mockNative.track).toHaveBeenCalledWith('order.completed', null);
  });

  it('rejects empty event name', async () => {
    await expect(Synapse.track('')).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    expect(mockNative.track).not.toHaveBeenCalled();
  });
});

describe('Synapse.screen', () => {
  it('JSON-encodes properties', async () => {
    await Synapse.screen('Checkout', { step: 'payment' });
    expect(mockNative.screen).toHaveBeenCalledWith(
      'Checkout',
      JSON.stringify({ step: 'payment' })
    );
  });

  it('rejects empty screen name', async () => {
    await expect(Synapse.screen('')).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });
});

describe('Synapse.requestPushPermission', () => {
  it('defaults all three flags to true when omitted', async () => {
    await Synapse.requestPushPermission();
    expect(mockNative.requestPushPermission).toHaveBeenCalledWith({
      alert: true,
      sound: true,
      badge: true,
    });
  });

  it('honours user-provided flags', async () => {
    await Synapse.requestPushPermission({ alert: false });
    expect(mockNative.requestPushPermission).toHaveBeenCalledWith({
      alert: false,
      sound: true,
      badge: true,
    });
  });

  it('returns the OS permission discriminator', async () => {
    mockNative.requestPushPermission.mockResolvedValueOnce('denied');
    await expect(Synapse.requestPushPermission()).resolves.toBe('denied');
  });
});

describe('Synapse.getPushPermissionStatus', () => {
  it('returns the bridge value', async () => {
    mockNative.getPushPermissionStatus.mockResolvedValueOnce('provisional');
    await expect(Synapse.getPushPermissionStatus()).resolves.toBe(
      'provisional'
    );
  });
});

describe('Synapse.setTrackingEnabled', () => {
  it('forwards boolean true/false', async () => {
    await Synapse.setTrackingEnabled(false);
    expect(mockNative.setTrackingEnabled).toHaveBeenCalledWith(false);
    await Synapse.setTrackingEnabled(true);
    expect(mockNative.setTrackingEnabled).toHaveBeenCalledWith(true);
  });

  it('rejects non-boolean input', async () => {
    await expect(
      Synapse.setTrackingEnabled('true' as unknown as boolean)
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(mockNative.setTrackingEnabled).not.toHaveBeenCalled();
  });
});

describe('Synapse.deleteUser', () => {
  it('invokes the TurboModule', async () => {
    await Synapse.deleteUser();
    expect(mockNative.deleteUser).toHaveBeenCalledTimes(1);
  });
});

describe('error lifting', () => {
  it('lifts plain Error rejections into SynapseError with internal_error', async () => {
    mockNative.track.mockRejectedValueOnce(new Error('weird native crash'));
    await expect(Synapse.track('order.completed')).rejects.toMatchObject({
      name: 'SynapseError',
      code: 'internal_error',
      message: 'weird native crash',
    });
  });

  it('passes through an existing SynapseError unchanged', async () => {
    const original = new SynapseError('permission_denied', 'user said no');
    mockNative.requestPushPermission.mockRejectedValueOnce(original);
    await expect(Synapse.requestPushPermission()).rejects.toBe(original);
  });

  it('handles string rejections defensively', async () => {
    mockNative.logout.mockRejectedValueOnce('weird-string-throw');
    await expect(Synapse.logout()).rejects.toMatchObject({
      name: 'SynapseError',
      code: 'internal_error',
      message: 'weird-string-throw',
    });
  });
});
