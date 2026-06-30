/**
 * Tests for the `Synapse.inApp.*` imperative surface (Phase 10
 * PR-2b — 0.3.0).
 *
 * Goal: prove each of the 5 methods on the in-app namespace
 *   1. Validates its arguments at the JS boundary (fail-fast with
 *      `SynapseError('invalid_argument', ...)` before crossing the
 *      bridge).
 *   2. Invokes the TurboModule with the correct marshalled shape
 *      (snake_case payload JSON for `getActive`, plain primitives
 *      everywhere else).
 *   3. Resolves with the TurboModule's return value (transformed as
 *      documented — e.g. `getActive` JSON-parses).
 *   4. Wires per-placement fan-out via the `pyrx:in-app:received`
 *      event correctly: the JS-side dispatch routes a single
 *      bridge-emitted event to every callback registered for the
 *      matching `placement_key` AND no callback registered for a
 *      different placement.
 *   5. Cleans up native registrations on unsubscribe.
 */

import {
  emitNativeEvent,
  listenerCount,
  mockNative,
  resetAll,
} from './helpers/setup';
import { Synapse } from '../Synapse';
import { SynapseError } from '../SynapseError';
import { __resetInAppForTests } from '../inApp';
import type { InAppMessage } from '../types/in-app';

beforeEach(() => {
  resetAll();
  __resetInAppForTests();
});

/** Build an InAppMessage with the wire-shape defaults used in tests. */
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

describe('Synapse.inApp.show', () => {
  it('rejects with invalid_argument when placement is empty', async () => {
    await expect(Synapse.inApp.show('', () => {})).rejects.toBeInstanceOf(
      SynapseError
    );
    expect(mockNative.inAppShow).not.toHaveBeenCalled();
  });

  it('rejects with invalid_argument when callback is not a function', async () => {
    await expect(
      // @ts-expect-error -- deliberate misuse to test runtime guard
      Synapse.inApp.show('home_banner', 'not-a-function')
    ).rejects.toBeInstanceOf(SynapseError);
    expect(mockNative.inAppShow).not.toHaveBeenCalled();
  });

  it('forwards placement to the TurboModule and returns an unsubscribe', async () => {
    const unsub = await Synapse.inApp.show('home_banner', () => {});
    expect(mockNative.inAppShow).toHaveBeenCalledTimes(1);
    expect(mockNative.inAppShow).toHaveBeenCalledWith('home_banner');
    expect(typeof unsub).toBe('function');
  });

  it('invokes the callback when a matching placement message is emitted', async () => {
    const cb = jest.fn();
    await Synapse.inApp.show('home_banner', cb);
    const msg = makeMessage({ placement_key: 'home_banner' });
    emitNativeEvent('pyrx:in-app:received', msg);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(msg);
  });

  it('does NOT invoke the callback for a non-matching placement', async () => {
    const cb = jest.fn();
    await Synapse.inApp.show('home_banner', cb);
    emitNativeEvent(
      'pyrx:in-app:received',
      makeMessage({ placement_key: 'settings_modal' })
    );
    expect(cb).not.toHaveBeenCalled();
  });

  it('fans out a single emit to multiple callbacks for the same placement', async () => {
    const a = jest.fn();
    const b = jest.fn();
    await Synapse.inApp.show('home_banner', a);
    await Synapse.inApp.show('home_banner', b);
    const msg = makeMessage({ placement_key: 'home_banner' });
    emitNativeEvent('pyrx:in-app:received', msg);
    expect(a).toHaveBeenCalledWith(msg);
    expect(b).toHaveBeenCalledWith(msg);
  });

  it('unsubscribe stops further callback invocations + calls inAppHideAll', async () => {
    const cb = jest.fn();
    const unsub = await Synapse.inApp.show('home_banner', cb);

    emitNativeEvent('pyrx:in-app:received', makeMessage());
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    // inAppHideAll is called with the subscription id the mock handed
    // back; the precise id is opaque so we just assert it was called.
    expect(mockNative.inAppHideAll).toHaveBeenCalledTimes(1);

    cb.mockClear();
    emitNativeEvent('pyrx:in-app:received', makeMessage());
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe is idempotent — second call is a silent no-op', async () => {
    const unsub = await Synapse.inApp.show('home_banner', () => {});
    unsub();
    unsub();
    expect(mockNative.inAppHideAll).toHaveBeenCalledTimes(1);
  });

  it('installs the receive subscription exactly once across multiple show calls', async () => {
    await Synapse.inApp.show('placement_a', () => {});
    await Synapse.inApp.show('placement_b', () => {});
    await Synapse.inApp.show('placement_c', () => {});
    // Single underlying native event subscription — the JS layer
    // fans out to every per-placement callback locally.
    expect(listenerCount('pyrx:in-app:received')).toBe(1);
  });
});

describe('Synapse.inApp.getActive', () => {
  it('passes null for the placement filter when no placement is given', async () => {
    await Synapse.inApp.getActive();
    expect(mockNative.inAppGetActive).toHaveBeenCalledWith(null);
  });

  it('forwards the placement filter when one is given', async () => {
    await Synapse.inApp.getActive('home_banner');
    expect(mockNative.inAppGetActive).toHaveBeenCalledWith('home_banner');
  });

  it('rejects with invalid_argument when placement is empty', async () => {
    await expect(Synapse.inApp.getActive('')).rejects.toBeInstanceOf(
      SynapseError
    );
    expect(mockNative.inAppGetActive).not.toHaveBeenCalled();
  });

  it('returns an empty array when the bridge resolves to "[]"', async () => {
    mockNative.inAppGetActive.mockResolvedValueOnce('[]');
    const result = await Synapse.inApp.getActive();
    expect(result).toEqual([]);
  });

  it('returns parsed messages when the bridge resolves to a JSON array', async () => {
    const msg = makeMessage({ id: 'a', placement_key: 'p' });
    mockNative.inAppGetActive.mockResolvedValueOnce(JSON.stringify([msg]));
    const result = await Synapse.inApp.getActive();
    expect(result).toEqual([msg]);
  });

  it('rejects with internal_error when the bridge resolves to non-JSON', async () => {
    mockNative.inAppGetActive.mockResolvedValueOnce('not-json');
    await expect(Synapse.inApp.getActive()).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('Synapse.inApp.dismiss', () => {
  it('rejects with invalid_argument when messageId is empty', async () => {
    await expect(Synapse.inApp.dismiss('')).rejects.toBeInstanceOf(
      SynapseError
    );
    expect(mockNative.inAppDismiss).not.toHaveBeenCalled();
  });

  it('forwards messageId and null reason when no reason is given', async () => {
    await Synapse.inApp.dismiss('assignment-1');
    expect(mockNative.inAppDismiss).toHaveBeenCalledWith('assignment-1', null);
  });

  it('forwards messageId and reason when both are given', async () => {
    await Synapse.inApp.dismiss('assignment-1', 'user_dismissed');
    expect(mockNative.inAppDismiss).toHaveBeenCalledWith(
      'assignment-1',
      'user_dismissed'
    );
  });

  it('normalises an empty-string reason to null', async () => {
    await Synapse.inApp.dismiss('assignment-1', '');
    expect(mockNative.inAppDismiss).toHaveBeenCalledWith('assignment-1', null);
  });
});

describe('Synapse.inApp.markInteracted', () => {
  it('rejects with invalid_argument when messageId is empty', async () => {
    await expect(
      Synapse.inApp.markInteracted('', 'cta-1')
    ).rejects.toBeInstanceOf(SynapseError);
    expect(mockNative.inAppMarkInteracted).not.toHaveBeenCalled();
  });

  it('rejects with invalid_argument when ctaId is empty', async () => {
    await expect(
      Synapse.inApp.markInteracted('assignment-1', '')
    ).rejects.toBeInstanceOf(SynapseError);
    expect(mockNative.inAppMarkInteracted).not.toHaveBeenCalled();
  });

  it('forwards both ids to the bridge', async () => {
    await Synapse.inApp.markInteracted('assignment-1', 'cta-1');
    expect(mockNative.inAppMarkInteracted).toHaveBeenCalledWith(
      'assignment-1',
      'cta-1'
    );
  });
});

describe('Synapse.inApp.refresh', () => {
  it('forwards to the bridge without args', async () => {
    await Synapse.inApp.refresh();
    expect(mockNative.inAppRefresh).toHaveBeenCalledTimes(1);
  });

  it('lifts native rejections into SynapseError', async () => {
    const err = new Error('boom');
    (err as Error & { code: string }).code = 'network_error';
    mockNative.inAppRefresh.mockRejectedValueOnce(err);
    await expect(Synapse.inApp.refresh()).rejects.toMatchObject({
      name: 'SynapseError',
      code: 'network_error',
    });
  });
});
