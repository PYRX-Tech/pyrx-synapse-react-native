# React hooks reference

Every hook in `@pyrx/synapse-react-native` is exported from the
package root and requires the component tree to be wrapped in
`<SynapseProvider>` (see [README quick start](../README.md#quick-start)).

All hooks are safe to call from inside Suspense boundaries and from
deeply-nested components; the provider holds the SDK state and the
hooks subscribe to its updates via the native event emitter — no
prop-drilling required.

---

## `useSynapse()`

The primary hook. Returns the full imperative API plus reactive
lifecycle state.

```ts
const {
  // Reactive lifecycle
  status, isInitialized, isPending, error,
  debugInfo, anonymousId, externalId, queueDepth,
  refreshDebugInfo,
  // Imperative
  initialize, identify, alias, logout,
  track, screen,
  requestPushPermission, getPushPermissionStatus,
  setTrackingEnabled, deleteUser,
  setLogLevel,
} = useSynapse();
```

| Field | Type | Notes |
|---|---|---|
| `status` | `'pending' \| 'initialized' \| 'error'` | The provider's initialize() lifecycle. |
| `isInitialized` | `boolean` | Convenience: `status === 'initialized'`. |
| `isPending` | `boolean` | Convenience: `status === 'pending'`. |
| `error` | `SynapseError \| null` | The last initialize() error, if any. |
| `debugInfo` | `SynapseDebugInfo \| null` | Cached SDK debug snapshot. Refreshed on identity-changing operations. |
| `anonymousId` | `string \| null` | Sugar accessor for `debugInfo.anonymousId`. |
| `externalId` | `string \| null` | Sugar accessor for `debugInfo.externalId`. |
| `queueDepth` | `number` | Sugar accessor for `debugInfo.queueDepth`. |
| `refreshDebugInfo` | `() => Promise<SynapseDebugInfo \| null>` | Force-refresh the snapshot. Use after operations the SDK performs outside JS (e.g., a cold-start replay landing). |
| `initialize(config)` | `(SynapseInitConfig) => Promise<void>` | You usually don't call this directly — `<SynapseProvider config={...}>` calls it for you on mount. |
| `identify(externalId, traits?)` | `(string, SynapseProperties?) => Promise<SynapseIdentifyResult>` | Merges anonymous events into the identified profile. |
| `alias(newExternalId)` | `(string) => Promise<SynapseIdentifyResult>` | Re-links the current identity to a new external ID. |
| `logout()` | `() => Promise<void>` | Clears the identity. Future events are anonymous again. |
| `track(eventName, properties?)` | `(string, SynapseProperties?) => Promise<void>` | Enqueues an event. Resolves once the event is on the queue (not once the network round-trip lands). |
| `screen(screenName, properties?)` | `(string, SynapseProperties?) => Promise<void>` | Same as `track`, semantically a screen view. |
| `requestPushPermission(options?)` | `(PushPermissionOptions?) => Promise<PushPermissionStatus>` | Triggers the OS prompt. iOS only — on Android, `usePushPermission()` is recommended. |
| `getPushPermissionStatus()` | `() => Promise<PushPermissionStatus>` | Reads the current status without prompting. |
| `setTrackingEnabled(enabled)` | `(boolean) => Promise<void>` | GDPR opt-out kill switch. When `false`, the SDK stops collecting events and drains the queue. |
| `deleteUser()` | `() => Promise<void>` | GDPR delete cascade: clears identity, wipes the encrypted store, POSTs `/v1/contacts/{id}/delete`. |
| `setLogLevel(level)` | `(SynapseLogLevel) => Promise<void>` | Adjusts native SDK console log verbosity at runtime. |

---

## `useIdentify(options?)`

Sugar over `useSynapse()` for the common "identify on sign-in, logout
on sign-out" pattern.

```ts
const { identify, logout, isIdentified, externalId } = useIdentify();

await identify('user-123', { email: 'jane@example.com' });
// later
await logout();
```

| Field | Type | Notes |
|---|---|---|
| `isIdentified` | `boolean` | `true` when `externalId !== null`. |
| `externalId` | `string \| null` | Same as `useSynapse().externalId`. |
| `identify` | `(externalId, traits?) => Promise<SynapseIdentifyResult>` | Same as `useSynapse().identify`. |
| `logout` | `() => Promise<void>` | Same as `useSynapse().logout`. |

Options (all optional) — see the `UseIdentifyOptions` type for the
current shape.

---

## `usePushPermission()`

The cross-platform push permission hook. Handles iOS prompts AND
Android 13+ `POST_NOTIFICATIONS` runtime requests in one call.

```ts
const { status, request, refresh } = usePushPermission();

// Show the prompt at the right UX moment (NOT on app launch — Apple
// rejects apps for that).
await request({ alert: true, sound: true, badge: true });
```

| Field | Type | Notes |
|---|---|---|
| `status` | `'granted' \| 'denied' \| 'provisional' \| 'notDetermined'` | The current OS permission state. |
| `isPending` | `boolean` | `true` while a `request()` or `refresh()` call is in flight. |
| `request(options?)` | `(PushPermissionOptions?) => Promise<PushPermissionStatus>` | Triggers the OS prompt if `status === 'notDetermined'`. If already determined, returns the current state without re-prompting (the OS only shows the prompt once per install). |
| `refresh()` | `() => Promise<PushPermissionStatus>` | Re-reads the OS state. Useful after the user returns from Settings. |

Options (all optional):

| Option | Type | Default | What it does |
|---|---|---|---|
| `alert` | `boolean` | `true` | iOS: request the right to show banner alerts. |
| `sound` | `boolean` | `true` | iOS: request the right to play notification sounds. |
| `badge` | `boolean` | `true` | iOS: request the right to update the app icon badge. |

---

## `usePushReceived(callback)`

Subscribes to the `pyrx:push:received` event. Fires once per
foreground-delivered push.

```ts
usePushReceived((event) => {
  // event: PushReceivedEvent
  showInAppToast(event.title, event.body);
});
```

The handler may be sync or async. The subscription is automatically
removed when the component unmounts.

See [EVENTS.md](./EVENTS.md#pyrxpushreceived) for the full event shape.

---

## `usePushClicked(callback)`

Subscribes to the `pyrx:push:click` event. Fires once per push tap,
whether the app was foreground, background, or cold-launched by the
tap.

```ts
usePushClicked((event) => {
  // event: PushClickEvent
  if (event.deepLink) {
    Linking.openURL(event.deepLink);
  }
});
```

Same auto-unsubscribe semantics as `usePushReceived`.

Most apps prefer `useDeepLink()` for routing (it surfaces the latest
click as state instead of as a handler callback), but `usePushClicked`
is useful for fire-and-forget side effects like analytics.

See [EVENTS.md](./EVENTS.md#pyrxpushclick) for the full event shape.

---

## `useDeepLink()`

Exposes the latest push-click payload as React state for routing.

```ts
const { lastPushClick, clear } = useDeepLink();

useEffect(() => {
  if (lastPushClick?.deepLink) {
    Linking.openURL(lastPushClick.deepLink);
    clear(); // Reset so re-renders don't re-fire routing
  }
}, [lastPushClick, clear]);
```

| Field | Type | Notes |
|---|---|---|
| `lastPushClick` | `PushClickEvent \| null` | The most recent click payload. `null` until a tap arrives. |
| `clear()` | `() => void` | Reset `lastPushClick` to `null` after handling. |

The SDK does **not** auto-call `Linking.openURL` — you decide how
(and whether) to route. Validate the URL, gate behind auth state,
filter to in-app links, etc.

---

## `<SynapseProvider>`

Root provider. Eagerly initializes the SDK with the given config and
exposes the lifecycle state to every descendant hook.

```tsx
<SynapseProvider
  config={{
    workspaceId: 'wks_xxx',
    apiKey: 'psk_live_xxx',
    environment: 'production',
    logLevel: 'info',
  }}
  onError={(err) => console.warn('Synapse init failed', err)}
>
  <App />
</SynapseProvider>
```

Props:

| Prop | Type | Notes |
|---|---|---|
| `config` | `SynapseInitConfig` | Required. Passed straight through to `Synapse.initialize`. |
| `onError` | `(err: SynapseError) => void` | Optional. Fires once if `Synapse.initialize` rejects. |
| `children` | `ReactNode` | Required. Your app tree. |

`SynapseInitConfig` fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `workspaceId` | `string` | Yes | Your PYRX workspace ID. |
| `apiKey` | `string` | Yes | `psk_live_xxx` or `psk_test_xxx`. |
| `environment` | `'production' \| 'sandbox'` | Yes | Wire-level live/test divider. |
| `baseUrl` | `string` | No | Defaults to PYRX production. Override only for self-hosted / staging. |
| `logLevel` | `'debug' \| 'info' \| 'warning' \| 'error' \| 'none'` | No | Native SDK log verbosity. |
| `maxQueueSize` | `number` | No | Override the default offline-queue cap. |

`SynapseStatus` values:

- `'pending'` — provider mounted; `Synapse.initialize` is in-flight (or has not yet started).
- `'initialized'` — init resolved; hooks can be used.
- `'error'` — init rejected; the `SynapseError` is available via the `error` field on `useSynapse()` / `useSynapseContext()`.

For non-component contexts (utility modules, redux middleware), import
the imperative `Synapse` namespace directly instead of using the
provider:

```ts
import { Synapse } from '@pyrx/synapse-react-native';
await Synapse.track('worker.done', { jobId });
```

This works as long as `<SynapseProvider>` has called `initialize` at
least once somewhere in the React tree.

---

## `useSynapseContext()`

Lower-level escape hatch — returns the raw provider context. Most
apps should use `useSynapse()` instead, which adds the imperative
methods on top of the same state.

```ts
const ctx = useSynapseContext();
// { config, status, error, debugInfo, refreshDebugInfo }
```

Useful for components that need to know the SDK status without
needing the action methods.
