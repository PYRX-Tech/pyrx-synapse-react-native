/**
 * Tests for `synapseEvents` (the typed `NativeEventEmitter` wrapper).
 *
 * Verifies:
 *   1. Listeners registered via `synapseEvents.addListener` receive
 *      payloads when the native side emits.
 *   2. Multiple listeners per event each receive every emit, and
 *      removing one does not affect the others.
 *   3. `subscription.remove()` actually disconnects (no leaked
 *      listeners after teardown).
 *   4. `removeAllListeners(eventName)` drops every listener for that
 *      event.
 *   5. Five event names are independent — emitting on one does not
 *      fan out to the others. (Was three in 0.1.x; 0.2.0 adds
 *      `pyrx:push:received-cold-start` and `pyrx:identity:changed`.)
 */

import { emitNativeEvent, listenerCount, resetAll } from './helpers/setup';
import { synapseEvents } from '../events';

beforeEach(() => {
  resetAll();
});

describe('synapseEvents.addListener', () => {
  it('delivers the payload to the listener', () => {
    const handler = jest.fn();
    const sub = synapseEvents.addListener('pyrx:push:click', handler);

    emitNativeEvent('pyrx:push:click', {
      pushLogId: 'plog_1',
      deepLink: 'myapp://orders/123',
      actionId: null,
      pyrxAttrs: { tenant_id: 't1' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      pushLogId: 'plog_1',
      deepLink: 'myapp://orders/123',
      actionId: null,
      pyrxAttrs: { tenant_id: 't1' },
    });
    sub.remove();
  });

  it('supports multiple listeners for the same event', () => {
    const a = jest.fn();
    const b = jest.fn();
    const c = jest.fn();
    const subA = synapseEvents.addListener('pyrx:push:received', a);
    const subB = synapseEvents.addListener('pyrx:push:received', b);
    const subC = synapseEvents.addListener('pyrx:push:received', c);

    emitNativeEvent('pyrx:push:received', {
      title: 'hi',
      body: 'hello',
      data: {},
      pyrxAttrs: {},
    });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);

    subA.remove();
    subB.remove();
    subC.remove();
  });

  it('removing one listener leaves the others intact', () => {
    const a = jest.fn();
    const b = jest.fn();
    const subA = synapseEvents.addListener('pyrx:push:click', a);
    synapseEvents.addListener('pyrx:push:click', b);

    subA.remove();
    emitNativeEvent('pyrx:push:click', {
      pushLogId: 'plog_2',
      deepLink: null,
      actionId: null,
      pyrxAttrs: {},
    });

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('returns subscriptions that fully detach when removed', () => {
    const handler = jest.fn();
    const sub = synapseEvents.addListener('pyrx:queue:drained', handler);
    expect(listenerCount('pyrx:queue:drained')).toBe(1);

    sub.remove();
    expect(listenerCount('pyrx:queue:drained')).toBe(0);

    emitNativeEvent('pyrx:queue:drained', { count: 5, batchId: 'b1' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not fan out across event names', () => {
    const onClick = jest.fn();
    const onReceived = jest.fn();
    synapseEvents.addListener('pyrx:push:click', onClick);
    synapseEvents.addListener('pyrx:push:received', onReceived);

    emitNativeEvent('pyrx:push:click', {
      pushLogId: 'p',
      deepLink: null,
      actionId: null,
      pyrxAttrs: {},
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onReceived).not.toHaveBeenCalled();
  });
});

describe('synapseEvents.removeAllListeners', () => {
  it('clears every listener for the given event name', () => {
    synapseEvents.addListener('pyrx:push:received', jest.fn());
    synapseEvents.addListener('pyrx:push:received', jest.fn());
    synapseEvents.addListener('pyrx:push:click', jest.fn());

    expect(listenerCount('pyrx:push:received')).toBe(2);
    expect(listenerCount('pyrx:push:click')).toBe(1);

    synapseEvents.removeAllListeners('pyrx:push:received');

    expect(listenerCount('pyrx:push:received')).toBe(0);
    // Other events are untouched.
    expect(listenerCount('pyrx:push:click')).toBe(1);
  });
});

describe('synapseEvents — 0.2.0 events (cold-start + identity)', () => {
  it('delivers pyrx:push:received-cold-start payloads', () => {
    const handler = jest.fn();
    const sub = synapseEvents.addListener(
      'pyrx:push:received-cold-start',
      handler
    );

    const payload = {
      title: 'cold-start',
      body: 'launched-from-tap',
      pushLogId: 'plog_cs_1',
      data: { route: '/home' },
      pyrxAttrs: { tenant_id: 't1', deep_link: 'myapp://home' },
      receivedAt: '2026-06-27T08:30:00Z',
    };
    emitNativeEvent('pyrx:push:received-cold-start', payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
    sub.remove();
  });

  it('delivers pyrx:identity:changed payloads with non-null before+after', () => {
    const handler = jest.fn();
    const sub = synapseEvents.addListener('pyrx:identity:changed', handler);

    const payload = {
      before: {
        anonymousId: 'anon-1',
        externalId: null,
        snapshotAt: '2026-06-27T09:00:00Z',
      },
      after: {
        anonymousId: 'anon-1',
        externalId: 'user-42',
        snapshotAt: '2026-06-27T09:00:01Z',
      },
    };
    emitNativeEvent('pyrx:identity:changed', payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
    sub.remove();
  });

  it('preserves before:null for the first-ever identify shape', () => {
    const handler = jest.fn();
    const sub = synapseEvents.addListener('pyrx:identity:changed', handler);

    const payload = {
      before: null,
      after: {
        anonymousId: 'anon-fresh',
        externalId: 'first-id',
        snapshotAt: '2026-06-27T09:30:00Z',
      },
    };
    emitNativeEvent('pyrx:identity:changed', payload);

    expect(handler).toHaveBeenCalledTimes(1);
    const received = handler.mock.calls[0]![0] as typeof payload;
    expect(received.before).toBeNull();
    expect(received.after).toEqual(payload.after);
    sub.remove();
  });

  it('cold-start and warm-start receive events independently', () => {
    // The native SDKs dedup so a single tap produces only one of the
    // two events, but the JS emitter treats them as independent
    // channels — verify they don't cross-fire (i.e., the JS layer
    // does not collapse them into one stream).
    const onColdStart = jest.fn();
    const onClick = jest.fn();
    const subA = synapseEvents.addListener(
      'pyrx:push:received-cold-start',
      onColdStart
    );
    const subB = synapseEvents.addListener('pyrx:push:click', onClick);

    emitNativeEvent('pyrx:push:received-cold-start', {
      title: 't',
      body: 'b',
      pushLogId: 'plog_cs_only',
      data: {},
      pyrxAttrs: null,
      receivedAt: '2026-06-27T09:45:00Z',
    });

    expect(onColdStart).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();

    subA.remove();
    subB.remove();
  });

  it('all 5 events are independent channels (no fan-out)', () => {
    // Smoke test for the 5-event taxonomy: emitting on one name does
    // not fire listeners on any of the other four.
    const handlers = {
      received: jest.fn(),
      click: jest.fn(),
      coldStart: jest.fn(),
      drained: jest.fn(),
      identity: jest.fn(),
    };
    synapseEvents.addListener('pyrx:push:received', handlers.received);
    synapseEvents.addListener('pyrx:push:click', handlers.click);
    synapseEvents.addListener(
      'pyrx:push:received-cold-start',
      handlers.coldStart
    );
    synapseEvents.addListener('pyrx:queue:drained', handlers.drained);
    synapseEvents.addListener('pyrx:identity:changed', handlers.identity);

    emitNativeEvent('pyrx:queue:drained', { count: 7 });

    expect(handlers.drained).toHaveBeenCalledTimes(1);
    expect(handlers.received).not.toHaveBeenCalled();
    expect(handlers.click).not.toHaveBeenCalled();
    expect(handlers.coldStart).not.toHaveBeenCalled();
    expect(handlers.identity).not.toHaveBeenCalled();
  });
});
