# In-App Messaging

The `@pyrx/synapse-react-native` SDK delivers in-app messages to your
host app via a typed render callback. Available since `0.3.0`.

> **The SDK does NOT render messages.** It hands you the typed
> `InAppMessage` data; you draw the UI in whatever style fits your
> app's design system (typical RN pattern: a controlled `<Modal>` or
> banner `<View>` driven by component state). PYRX UI Kit pre-built
> components are deferred to a future release per
> [ADR-0008 D2](https://github.com/PYRX-Tech/pyrx-synapse/blob/master/docs/adr/ADR-0008-in-app-messaging-delivery-model.md).

## Quick start

```tsx
import {
  Synapse,
  useInAppMessage,
  type InAppMessage,
} from '@pyrx/synapse-react-native';
import { useState } from 'react';
import { Modal, View, Text, Pressable, Image } from 'react-native';

function HomeScreen() {
  const [active, setActive] = useState<InAppMessage | null>(null);

  // Register a callback for the `home_banner` placement. The SDK
  // fires it once per fresh message; we render it via state.
  useInAppMessage('home_banner', setActive);

  const dismiss = () => {
    if (active) {
      Synapse.inApp.dismiss(active.id, 'user_dismissed');
      setActive(null);
    }
  };

  return (
    <View>
      <Modal visible={active != null} transparent onRequestClose={dismiss}>
        {active && (
          <View style={{ padding: 20, backgroundColor: '#fff' }}>
            {active.image_url && (
              <Image source={{ uri: active.image_url }} style={{ height: 120 }} />
            )}
            <Text style={{ fontWeight: 'bold' }}>{active.title}</Text>
            <Text>{active.body}</Text>
            {active.ctas.map((cta) => (
              <Pressable
                key={cta.id}
                onPress={() => {
                  // Telemetry — fire BEFORE acting on the CTA so the
                  // backend records the interaction even if the
                  // navigation kills your screen.
                  Synapse.inApp.markInteracted(active.id, cta.id);
                  // Act on the CTA per its action_type — see the
                  // "Handling CTAs" section below.
                  handleCta(cta);
                  if (cta.action_type === 'dismiss') {
                    setActive(null);
                  }
                }}
              >
                <Text>{cta.label}</Text>
              </Pressable>
            ))}
            <Pressable onPress={dismiss}>
              <Text>Close</Text>
            </Pressable>
          </View>
        )}
      </Modal>
    </View>
  );
}
```

## API surface

### Imperative

```ts
import { Synapse } from '@pyrx/synapse-react-native';

// Register a placement render callback. Returns an unsubscribe fn.
const unsubscribe = await Synapse.inApp.show(
  'home_banner',
  (msg: InAppMessage) => { /* render */ }
);

// Sync read of currently-active messages.
const messages = await Synapse.inApp.getActive(); // or .getActive('home_banner')

// Mark dismissed (evicts from cache + telemetry).
await Synapse.inApp.dismiss(msg.id);                  // no reason
await Synapse.inApp.dismiss(msg.id, 'user_dismissed'); // with reason

// Mark CTA tapped (telemetry only — does NOT evict).
await Synapse.inApp.markInteracted(msg.id, cta.id);

// Force an immediate poll (e.g., pull-to-refresh).
await Synapse.inApp.refresh();
```

Use the imperative surface from non-component callers (Redux
middleware, sagas, plain utility modules). Inside React components,
prefer the hooks below for lifecycle ergonomics.

### React hooks

#### `useInAppMessage(placement, callback)`

Subscribe to fresh messages for a single placement.

```tsx
useInAppMessage('home_banner', (msg) => setActive(msg));
```

- Registers on mount; unregisters on unmount.
- Re-registers when `placement` changes.
- Callback identity changes do NOT trigger re-registration (the
  hook holds the latest callback in a ref).
- Multiple components calling `useInAppMessage` with the SAME
  placement each get their own callback fired.

#### `useInAppMessageReceived(callback)`

Global observer — fires for EVERY new in-app message regardless of
placement. For cross-cutting concerns: analytics middleware, debug
overlays, RUM-style logging.

```tsx
useInAppMessageReceived((msg) => {
  analytics.track('in_app_received', {
    messageId: msg.id,
    placement: msg.placement_key,
  });
});
```

Does NOT register any placement with the native polling loop — at
least one `useInAppMessage(...)` or `Synapse.inApp.show(...)` must
be active for the SDK to poll.

#### `useInAppMessageDismissed(handler)`

Observer for dismissals.

```tsx
useInAppMessageDismissed((messageId, reason) => {
  analytics.track('in_app_dismissed', { messageId, reason });
});
```

Fires whenever `Synapse.inApp.dismiss(...)` is called. `reason` is
`null` (not `undefined`) when the caller did not provide one.

## Types

### `InAppMessage`

Wire-shape JSON delivered to your render callback. Snake_case keys
to match the backend payload byte-for-byte:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Server-issued **assignment** id. Pass back via `markInteracted` / `dismiss`. |
| `message_id` | `string` | The `in_app_messages.id` — stable across assignments. Use for host-side dedupe. |
| `placement_key` | `string` | The placement you registered. |
| `title` | `string` | NLT-rendered title. |
| `body` | `string` | NLT-rendered body. |
| `image_url` | `string \| null` | NLT-rendered URL, or null. |
| `ctas` | `InAppCta[]` | 0–2 CTAs. |
| `custom` | `Record<string, unknown>` | Host-app custom JSON; never NLT-rendered server-side. |
| `expires_at` | `string \| null` | ISO-8601 instant. SDK does NOT auto-evict — the next poll drops them server-side. |
| `priority` | `number` | Higher = more important. `getActive` sorts by priority desc, then expiry asc. |

### `InAppCta`

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Pass back via `markInteracted(messageId, ctaId)`. |
| `label` | `string` | NLT-rendered label. |
| `action_type` | `'deep_link' \| 'dismiss' \| 'webview' \| 'callback'` | Tells you how to handle the tap. |
| `action_payload` | `string \| null` | URL for `deep_link`/`webview`; opaque for `callback`; null for `dismiss`. |

## Handling CTAs

The SDK does NOT execute CTAs automatically. Your render code is
responsible for acting on `action_type`:

```tsx
function handleCta(cta: InAppCta) {
  switch (cta.action_type) {
    case 'deep_link':
      // Open via the OS / your router. action_payload is the URL.
      if (cta.action_payload) {
        Linking.openURL(cta.action_payload);
      }
      break;
    case 'webview':
      // Push an in-app webview screen — your navigator's call.
      if (cta.action_payload) {
        navigation.navigate('WebView', { url: cta.action_payload });
      }
      break;
    case 'dismiss':
      // Telemetry + UI dismissal — you usually want this paired
      // with Synapse.inApp.dismiss(msg.id, 'cta_dismissed').
      break;
    case 'callback':
      // Opaque — interpret action_payload per your routing convention.
      handleCustomCallback(cta.action_payload);
      break;
  }
}
```

## Lifecycle behavior

The SDK owns these rules (the bridge does not re-implement them in
JS — it delegates to the native SDKs):

1. **Identity-gated polling.** The SDK does NOT poll
   `/v1/in-app/poll` until you call `Synapse.identify(...)`. A
   registration made before identify is buffered and a poll fires
   as soon as identity lands.
2. **Immediate poll on null→identified.** As soon as identify lands
   AND you have at least one placement registered, the SDK polls.
3. **Track-call refresh.** Calls to `Synapse.track(...)` within the
   max-age window short-circuit the next poll.
4. **Concurrent poll coalescing.** Multiple `refresh()` calls fan
   into one in-flight poll.
5. **Server-authoritative cache eviction.** Each poll's response
   replaces the cache — expired/superseded messages drop server-side.
6. **Observer dedupe by assignment id.** The
   `pyrx:in-app:received` event fires once per assignment id even
   on re-polls.
7. **Auto-impression after render.** The SDK records an impression
   after your render callback returns.
8. **`soft_degraded` doubles the poll interval.** Reduces traffic
   during backpressure.
9. **`plan_limit_reached` still surfaces the message** with a
   warning log so the user experience does not silently drop.
10. **No widget code.** Data-only contract per ADR-0008 D2 — you
    render.

## Telemetry contract

Every interaction with an in-app message produces backend telemetry:

| Action | Backend event | Billable? |
|---|---|---|
| Message rendered (auto, post-callback) | `impression` | Yes (per ADR-0008 D4) |
| `markInteracted(id, ctaId)` | `interacted` | No |
| `dismiss(id, reason?)` | `dismissed` | No |

The `reason` field on `dismiss` is observer-only — it does NOT
cross the wire (the backend `/v1/in-app/log` schema does not carry
it in Phase 10 PR-1). Reserved for forward-compat.

## Cross-SDK contract

The same five methods + two observer events ship on every PYRX
Synapse SDK (browser, iOS, Android, React Native, Flutter) per
[ADR-0009 D5](https://github.com/PYRX-Tech/pyrx-synapse/blob/master/docs/adr/ADR-0009-in-app-sdk-surface.md).
The semantic contract is identical; only the language-idiomatic
shape differs (browser uses string-command dispatch; iOS uses a
nested `Synapse.InApp.*` namespace; Android uses `Pyrx.inApp.*`; RN
uses `Synapse.inApp.*` for symmetry with the browser SDK).

If you ship a multi-platform app, the same dashboard composer
authoring flow surfaces messages on every platform without
client-side branching.
