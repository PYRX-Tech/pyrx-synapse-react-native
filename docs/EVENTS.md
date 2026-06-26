# Native event emitter reference

`@pyrx/synapse-react-native` ships a typed `NativeEventEmitter` wrapper
that fires events from the native SDKs into your JS layer. Most apps
consume these events via the [React hooks](./HOOKS.md), but the raw
emitter is exported for non-component code (redux middleware, plain
utility modules, background workers).

## Importing

```ts
import { synapseEvents } from '@pyrx/synapse-react-native';

const sub = synapseEvents.addListener('pyrx:push:click', (event) => {
  console.log('User tapped a push', event);
});

// Always clean up:
sub.remove();
```

## Event names

The emitter exposes three event names. All others are internal.

| Event | When it fires | Recommended consumer |
|---|---|---|
| `pyrx:push:received` | A push arrives while the app is in the foreground. | `usePushReceived(callback)` |
| `pyrx:push:click` | The user taps a push (foreground, background, or cold start). | `usePushClicked(callback)` for side effects; `useDeepLink()` for routing |
| `pyrx:queue:drained` | The internal event queue successfully flushed a batch to the backend. Mostly useful for debugging. | None — direct emitter subscription if you really need it |

## Payload shapes

### `pyrx:push:received`

```ts
type PushReceivedEvent = {
  /** APS / FCM alert title. May be empty for silent / data-only pushes. */
  title: string;
  /** APS / FCM alert body. May be empty for silent / data-only pushes. */
  body: string;
  /**
   * Arbitrary custom data the sender attached. JSON-decoded from the
   * native side; values are JSON primitives, arrays, or objects.
   */
  data: Record<string, unknown>;
};
```

### `pyrx:push:click`

```ts
type PushClickEvent = {
  /** Synapse-issued push log row identifier; matches `push_logs.id`. */
  pushLogId: string;
  /** Optional deep link the sender attached. `null` when no link. */
  deepLink: string | null;
  /**
   * Optional action identifier (Android notification action button or
   * iOS UNNotificationAction). `null` for plain body taps.
   */
  actionId: string | null;
};
```

### `pyrx:queue:drained`

```ts
type QueueDrainedEvent = {
  /** Number of events flushed in this drain cycle. */
  count: number;
  /** Server-acknowledged batch id (for matching to dashboard logs). */
  batchId: string;
};
```

## Subscription lifecycle

`addListener` returns an `EmitterSubscription`. **Always call
`.remove()` when you're done.** Inside React components, prefer the
hooks ([`usePushReceived`](./HOOKS.md#usepushreceivedcallback), etc.) —
they handle teardown for you on unmount.

For non-component code, wire teardown to whatever scope owns the
subscription:

```ts
class AnalyticsPipeline {
  private clickSub: { remove: () => void } | null = null;

  start() {
    this.clickSub = synapseEvents.addListener(
      'pyrx:push:click',
      this.handleClick
    );
  }

  stop() {
    this.clickSub?.remove();
    this.clickSub = null;
  }

  private handleClick = (event: PushClickEvent) => {
    // forward to your analytics layer
  };
}
```

## Delivery guarantees

- **Order:** events are delivered in the order they're emitted from
  native. Inter-event-type ordering is not guaranteed (e.g., a
  `push:received` and a `push:click` for the same push may arrive in
  either order if the user taps a foreground push very quickly).
- **At-least-once vs exactly-once:** for normal app lifecycle (app
  alive when the push arrives), every event fires exactly once. For
  cold-start scenarios (app launched by a push tap), the SDK replays
  the cached payload as soon as `Synapse.initialize` completes — so
  the `pyrx:push:click` event may fire several seconds after the tap
  itself. The `pushLogId` deduplication is your responsibility if
  your handler is non-idempotent.
- **Backpressure:** the emitter has no backpressure; JS handlers run on
  the JS thread and block subsequent events until they return. Keep
  handlers fast and offload heavy work via `setImmediate` /
  `requestAnimationFrame`.

## See also

- [`docs/HOOKS.md`](./HOOKS.md) — React-shaped wrappers around these events
- [Main README](../README.md#react-navigation-deep-link-integration) — deep-link routing example
