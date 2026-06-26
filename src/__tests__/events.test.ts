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
 *   5. Three event names are independent — emitting on one does not
 *      fan out to the others.
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
