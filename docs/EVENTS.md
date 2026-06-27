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

The emitter exposes five event names. All others are internal.

| Event | When it fires | Recommended consumer |
|---|---|---|
| `pyrx:push:received` | A push arrives while the app is in the foreground (or background, on Android). | `usePushReceived(callback)` |
| `pyrx:push:click` | The user taps a push (warm-start only — app process already alive). Cold-start taps fire `pyrx:push:received-cold-start` instead. | `usePushClicked(callback)` for side effects; `useDeepLink()` for routing |
| `pyrx:push:received-cold-start` | The OS launched the app from a notification tap (terminated state). The native SDKs dedup against `pyrx:push:click` for the same `pushLogId` so consumers see exactly one of the two. **New in 0.2.0.** | `usePushReceivedColdStart(callback)` |
| `pyrx:queue:drained` | The internal event queue successfully flushed a non-zero batch to the backend. Mostly useful for debugging. | None — direct emitter subscription if you really need it |
| `pyrx:identity:changed` | The SDK's resolved identity transitioned via `identify`, `alias`, or `logout`. **New in 0.2.0.** | `useIdentityChanged(callback)` |

## Payload shapes

### `pyrx:push:received`

```ts
type PushReceivedEvent = {
  /** APS / FCM alert title. May be empty for silent / data-only pushes. */
  title: string;
  /** APS / FCM alert body. May be empty for silent / data-only pushes. */
  body: string;
  /**
   * Synapse-issued push log row identifier; matches `push_logs.id` on
   * the backend. `null` for non-Synapse pushes (legacy passthrough —
   * the observer API surfaces them so apps can react to ALL
   * deliveries).
   */
  pushLogId: string | null;
  /**
   * Arbitrary custom data the sender attached. JSON-decoded from the
   * native side; values are JSON primitives, arrays, or objects.
   */
  data: Record<string, unknown>;
  /**
   * Synapse-stamped metadata: `push_log_id`, `tenant_id`, `template_id`,
   * etc. `null` if the push did NOT carry a `pyrx_attrs` namespace.
   */
  pyrxAttrs: Record<string, unknown> | null;
  /** ISO 8601 wall-clock instant the SDK observed the delivery (UTC). */
  receivedAt: string;
};
```

### `pyrx:push:received-cold-start` (0.2.0)

Identical payload to `pyrx:push:received` — exported as
`PushReceivedColdStartEvent` (a type alias) for self-documentation:

```ts
type PushReceivedColdStartEvent = PushReceivedEvent;
```

The distinguishing signal is the **event name**, not a payload field.
Use `usePushReceivedColdStart(callback)` to subscribe.

### `pyrx:push:click`

```ts
type PushClickEvent = {
  /**
   * Synapse-issued push log row identifier; matches `push_logs.id`.
   * `null` for non-Synapse pushes (legacy passthrough).
   */
  pushLogId: string | null;
  /** Optional deep link the sender attached. `null` when no link. */
  deepLink: string | null;
  /**
   * Optional action identifier (Android notification action button or
   * iOS UNNotificationAction). `null` for plain body taps.
   */
  actionId: string | null;
  /**
   * Echo of the push's pyrxAttrs map (see PushReceivedEvent). `null`
   * if no `pyrx_attrs` namespace was present.
   */
  pyrxAttrs: Record<string, unknown> | null;
  /** ISO 8601 wall-clock instant the SDK observed the click (UTC). */
  clickedAt: string;
};
```

### `pyrx:queue:drained`

```ts
type QueueDrainedEvent = {
  /** Number of events flushed in this drain cycle. Always > 0. */
  count: number;
};
```

Note: in 0.1.x the docs declared an additional `batchId` field that
was never populated by the native side. The 0.2.0 native producer
publishes only `count`; the type was tightened to match the actual
runtime shape. Apps that subscribed in 0.1.x and read `batchId` would
have seen `undefined` regardless — no behavior change for working
consumers.

### `pyrx:identity:changed` (0.2.0)

```ts
type IdentitySnapshot = {
  /**
   * The SDK-minted anonymous device id (UUIDv4). Survives identify /
   * alias / logout. Transiently `null` only for the very first
   * snapshot of a fresh install before storage is seeded.
   */
  anonymousId: string | null;
  /**
   * The user id passed to `identify(...)`, or `null` for anonymous-only
   * sessions. Returns to `null` after `logout`.
   */
  externalId: string | null;
  /** ISO 8601 wall-clock instant the snapshot was captured (UTC). */
  snapshotAt: string;
};

type IdentityChangedEvent = {
  /** Prior identity. `null` ONLY on the very first identify of a fresh install. */
  before: IdentitySnapshot | null;
  /** Resolved identity AFTER the transition. Always non-null. */
  after: IdentitySnapshot;
};
```

Detect transition kind by comparing the two snapshots:

| Transition | Detection |
|---|---|
| Login | `before?.externalId == null && after.externalId != null` |
| Logout | `before?.externalId != null && after.externalId == null` |
| Switch (rare) | both `externalId`s non-null AND `before.externalId !== after.externalId` |
| First identify | `before === null` (and `after.externalId != null`) |

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
  alive when the push arrives), every event fires exactly once. The
  native SDKs dedup cold-start taps against warm-start clicks for the
  same `push_log_id` via a 5-second LRU, so a single tap produces
  exactly one of `pyrx:push:click` OR `pyrx:push:received-cold-start`,
  never both.
- **Late-subscriber replay:** the native SDKs keep a replay buffer of
  the most-recent 4 events. A JS subscriber that attaches AFTER an
  event has fired still receives the buffered history — this handles
  the RN cold-start race where JS mounts after the OS has already
  delivered a push.
- **Backpressure:** the emitter has no backpressure; JS handlers run on
  the JS thread and block subsequent events until they return. Keep
  handlers fast and offload heavy work via `setImmediate` /
  `requestAnimationFrame`.

## See also

- [`docs/HOOKS.md`](./HOOKS.md) — React-shaped wrappers around these events
- [Main README](../README.md#react-navigation-deep-link-integration) — deep-link routing example
