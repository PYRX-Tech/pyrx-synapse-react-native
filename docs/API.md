# `Synapse` namespace API reference

The `Synapse` namespace is the imperative public surface. Inside React
components you usually want the [hooks](./HOOKS.md) instead — they
expose the same methods plus reactive state. Use `Synapse` directly
from non-component code: utility modules, redux middleware, plain
classes.

```ts
import { Synapse } from '@pyrx/synapse-react-native';
```

## Lifecycle

### `Synapse.initialize(config)`

```ts
await Synapse.initialize({
  workspaceId: 'wks_xxx',
  apiKey: 'psk_live_xxx',
  environment: 'production',
  baseUrl: 'https://synapse-events.pyrx.tech', // optional
  logLevel: 'info',                             // optional
  maxQueueSize: 5000,                           // optional
});
```

You usually don't call this directly — `<SynapseProvider config={...}>`
calls it on mount. Calling it twice with the same config is a no-op.
Calling it with a different config produces a `SynapseError('invalid_argument')`.

### `Synapse.setLogLevel(level)`

```ts
await Synapse.setLogLevel('debug');
```

Adjust native SDK console log verbosity at runtime. Levels: `'debug'`,
`'info'`, `'warning'`, `'error'`, `'none'`.

### `Synapse.debugInfo()`

```ts
const info = await Synapse.debugInfo();
// {
//   initialized: boolean,
//   workspaceId: string | null,
//   environment: 'production' | 'sandbox' | null,
//   anonymousId: string | null,
//   externalId: string | null,
//   queueDepth: number,
//   sdkVersion: string,
// }
```

Returns a snapshot of the SDK's internal state. Useful for support
tickets and debug overlays.

---

## Identity

### `Synapse.identify(externalId, traits?)`

```ts
const result = await Synapse.identify('user-123', {
  email: 'jane@example.com',
  plan: 'pro',
  signupDate: '2026-01-15T00:00:00Z',
});
// {
//   externalId: 'user-123',
//   anonymousId: 'anon-abc',
//   merged: true, // anonymous events were merged into the identified profile
// }
```

Merges any anonymous events sent before this call into the identified
profile. Subsequent events are attributed to the external ID. Traits
are sent as a profile update to your backend.

### `Synapse.alias(newExternalId)`

```ts
await Synapse.alias('user-123-renamed');
```

Re-links the current identity to a new external ID. Useful when a user
changes their primary identifier (email change, account merge, etc.).

### `Synapse.logout()`

```ts
await Synapse.logout();
```

Clears the identity. The SDK generates a new anonymous ID for
subsequent events.

---

## Events

### `Synapse.track(eventName, properties?)`

```ts
await Synapse.track('order.completed', {
  orderId: 'ord-789',
  amount: 49.99,
  currency: 'USD',
  items: [
    { sku: 'sku-1', qty: 2 },
    { sku: 'sku-2', qty: 1 },
  ],
});
```

Enqueues an event. Resolves once the event is on the offline queue,
NOT once the network round-trip lands. The native SDK handles
batching, retries, and exponential backoff transparently.

### `Synapse.screen(screenName, properties?)`

```ts
await Synapse.screen('Checkout', { step: 'payment' });
```

Same as `track`, semantically a screen view. Some analytics dashboards
treat `screen` events differently.

---

## Push

### `Synapse.requestPushPermission(options?)`

```ts
const status = await Synapse.requestPushPermission({
  alert: true,
  sound: true,
  badge: true,
});
// 'granted' | 'denied' | 'provisional' | 'notDetermined'
```

Triggers the OS push permission prompt on iOS. If permission has
already been determined, returns the current state without
re-prompting. On Android, prefer `usePushPermission()` from the hooks
module — it handles both platforms.

### `Synapse.getPushPermissionStatus()`

```ts
const status = await Synapse.getPushPermissionStatus();
// 'granted' | 'denied' | 'provisional' | 'notDetermined'
```

Reads the current OS permission state without prompting.

> **Note:** push registration (the actual APNs / FCM token round-trip)
> happens automatically inside the AppDelegate / FCM service the SDK
> ships — there is no `Synapse.registerForPush()` method to call. As
> soon as the user grants permission AND the AppDelegate base class is
> wired up, the device appears in your PYRX dashboard.

---

## Privacy

### `Synapse.setTrackingEnabled(enabled)`

```ts
await Synapse.setTrackingEnabled(false); // opt out
await Synapse.setTrackingEnabled(true);  // opt in
```

GDPR opt-out kill switch. When `false`, the SDK stops collecting events
and drains its offline queue. Identity is preserved. Use this for the
"don't track me" toggle in your settings UI.

### `Synapse.deleteUser()`

```ts
await Synapse.deleteUser();
```

GDPR delete cascade: clears identity, wipes the encrypted local store,
and POSTs `/v1/contacts/{id}/delete` to your backend. The backend
removes the contact and all associated events. Irreversible — call
only after the user has confirmed the action in your UI.

---

## Errors

Every `Synapse.*` method returns a `Promise<T>`. Failures reject with
a `SynapseError`:

```ts
import { Synapse, SynapseError } from '@pyrx/synapse-react-native';

try {
  await Synapse.identify('user-123');
} catch (err) {
  if (err instanceof SynapseError) {
    console.warn('Synapse failed:', err.code, err.message, err.details);
    // err.code is one of: 'not_initialized' | 'permission_denied'
    //   | 'network_error' | 'invalid_argument' | 'internal_error'
  }
}
```

Error codes mirror the native SDKs' `PyrxError` enum:

| Code | When | Recommended UX |
|---|---|---|
| `not_initialized` | Method called before `initialize()` resolved | Defer the call; gate UI behind `useSynapse().isInitialized`. |
| `permission_denied` | OS denied push permission, or user denied at runtime | Show a "go to Settings" CTA. |
| `network_error` | Transient backend failure | Auto-retry (the SDK already does); show toast if user-initiated. |
| `invalid_argument` | Bad input (empty string, wrong type) | Bug in caller code; surface in dev console. |
| `internal_error` | Native SDK internal failure | File a bug; include `Synapse.debugInfo()` output. |

---

## Types

All types are exported from the package root:

```ts
import type {
  // Core
  SynapseInitConfig,
  SynapseEnvironment,
  SynapseLogLevel,
  SynapseProperties,
  SynapsePropertyValue,
  SynapseDebugInfo,
  SynapseIdentifyResult,
  // Push
  PushPermissionOptions,
  PushPermissionStatus,
  // Errors
  SynapseErrorCode,
  // Events
  SynapseEventName,
  SynapseEventMap,
  PushReceivedEvent,
  PushClickEvent,
  QueueDrainedEvent,
  // Hooks (return shapes)
  UseSynapseReturn,
  UseIdentifyReturn,
  UseIdentifyOptions,
  UsePushPermissionReturn,
  UseDeepLinkReturn,
  // Provider
  SynapseContextValue,
  SynapseProviderProps,
  SynapseStatus,
} from '@pyrx/synapse-react-native';
```
