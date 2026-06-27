# `@pyrx/synapse-react-native`

PYRX Synapse SDK for React Native. Events, identity, push notifications,
and privacy controls — for iOS and Android, with a unified TypeScript
surface and React hooks.

This package is a **thin TurboModule wrapper** around the published
native SDKs:

- iOS: [`PYRXSynapse`](https://cocoapods.org/pods/PYRXSynapse) (CocoaPods + Swift Package Manager)
- Android: [`tech.pyrx.synapse:synapse-core`](https://central.sonatype.com/artifact/tech.pyrx.synapse/synapse-core) + [`tech.pyrx.synapse:synapse-push`](https://central.sonatype.com/artifact/tech.pyrx.synapse/synapse-push) (Maven Central)

The RN package owns the JS bridge, the React ergonomics (hooks,
provider, typed errors), the Expo config plugin, and the documentation.
The event queue, network layer, identity manager, privacy cascade, and
push registration all live in the native SDKs — so the RN package
inherits every native-SDK bug fix and tuning automatically.

| Concern | Where it lives |
|---|---|
| Public TS API | `@pyrx/synapse-react-native` (this package) |
| iOS native code (queue, network, push) | `PYRXSynapse` Pod |
| Android native code (queue, network, push) | `tech.pyrx.synapse:synapse-*` AARs |
| Backend (events, push delivery) | `synapse-events.pyrx.tech` |

---

> ## ✨ What's new in 0.2.0 (2026-06-27)
>
> The three push-event hooks that were stubbed in 0.1.x —
> `usePushReceived`, `usePushClicked`, `useDeepLink` — **now fire**
> against the just-shipped observer surfaces in `PYRXSynapse 0.1.2`
> (iOS) and `tech.pyrx.synapse:synapse-{core,push}:0.1.4` (Android).
>
> Two new hooks join them:
>
> - **`usePushReceivedColdStart(callback)`** — fires when the OS
>   launched the app from a notification tap. Distinct from
>   `useDeepLink` because cold-start routing often needs to wait for
>   navigation to mount, and the native SDKs replay-buffer up to 4
>   most-recent events so late JS subscribers still catch it. Mutually
>   exclusive with `usePushClicked` for the same tap (the native SDKs
>   dedup by `push_log_id` over a 5-second window).
>
> - **`useIdentityChanged(callback)`** — fires when the SDK's
>   resolved identity transitions via `identify`, `alias`, or `logout`.
>   Carries `{ before, after }` snapshots so dashboard-style apps can
>   refetch user data on login state change without polling
>   `useIdentify` in a `useEffect`.
>
> See [`CHANGELOG.md`](./CHANGELOG.md) for the full 0.2.0 changelog.
> Cross-link to the native SDK observer-API docs:
>
> - iOS observers: [PYRXSynapse 0.1.2 release](https://github.com/PYRX-Tech/pyrx-synapse-ios/releases/tag/0.1.2)
>   (`Pyrx.shared.observe(on:_:)` closure registry + `Pyrx.shared.events()`
>   AsyncStream sugar)
> - Android observers: [synapse-core 0.1.4 release](https://github.com/PYRX-Tech/pyrx-synapse-android/releases/tag/0.1.4)
>   (`Pyrx.events: SharedFlow<PyrxEvent>`)

## Supported platforms

- **React Native** 0.76+ (New Architecture only — TurboModules)
- **Expo SDK** 52+ (**Expo Dev Build only** — Expo Go is not supported because this package ships native modules)
- **iOS** 14.0+
- **Android** API 24+ (Android 7.0 Nougat and up)

Bare React Native and Expo Dev Build are both supported. **For RN Web,
use [`@pyrx/synapse-browser`](https://www.npmjs.com/package/@pyrx/synapse-browser)
directly** — this package targets native iOS and Android only.

---

## Install

### Expo Dev Build (recommended for new apps)

```bash
# In your Expo app
npx expo install @pyrx/synapse-react-native
```

Then add the config plugin to your `app.json` / `app.config.ts`:

```json
{
  "expo": {
    "plugins": [
      [
        "@pyrx/synapse-react-native",
        {
          "iosMode": "development",
          "androidPostNotificationsPermission": true
        }
      ]
    ]
  }
}
```

Plugin options:

| Option | Default | What it does |
|---|---|---|
| `iosMode` | `"development"` | Sets the `aps-environment` entitlement. Use `"production"` for App Store / TestFlight builds; `"development"` for simulator and Ad Hoc / EAS development builds. |
| `androidPostNotificationsPermission` | `true` | Adds `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />` to your Android manifest. Required to show push on Android 13+. Set to `false` only if another plugin already adds it. |

Then prebuild and run a dev build:

```bash
npx expo prebuild --clean
eas build --profile development --platform ios
eas build --profile development --platform android
```

Install the resulting build on a device or simulator and start the
dev server with `npx expo start --dev-client`.

### Bare React Native (existing apps without Expo)

```bash
npm install @pyrx/synapse-react-native
cd ios && pod install
```

Then make the two native edits documented in
[`docs/INSTALL-BARE.md`](docs/INSTALL-BARE.md):

- iOS: change your `AppDelegate.swift` (or `.mm`) inheritance to
  `PyrxSynapseAppDelegate`. Add the `aps-environment` entitlement and
  `UIBackgroundModes: [remote-notification]` to your Info.plist.
- Android: add `POST_NOTIFICATIONS` to your `AndroidManifest.xml`. No
  service registration needed — the `synapse-push` AAR's manifest
  declares `PyrxMessagingService` and Android's manifest merger picks
  it up.

For both paths, you also need:

- iOS: [Apple Push Notification service key](https://developer.apple.com/help/account/configure-app-capabilities/configure-push-notifications) configured on your Apple Developer account
- Android: a `google-services.json` from your [Firebase project](https://console.firebase.google.com/) placed at your Android app's root (or referenced via `expo.android.googleServicesFile` for Expo apps)

---

## Quick start

```tsx
// App.tsx
import { SynapseProvider } from '@pyrx/synapse-react-native';
import Home from './src/Home';

export default function App() {
  return (
    <SynapseProvider
      config={{
        workspaceId: process.env.EXPO_PUBLIC_PYRX_WORKSPACE_ID!,
        apiKey: process.env.EXPO_PUBLIC_PYRX_API_KEY!, // psk_live_xxx or psk_test_xxx
        environment: 'production', // 'production' | 'sandbox'
        logLevel: 'info',
        // baseUrl: 'https://synapse-events.pyrx.tech', // optional; defaults to PYRX prod
      }}
    >
      <Home />
    </SynapseProvider>
  );
}
```

```tsx
// src/Home.tsx
import { Button, View } from 'react-native';
import {
  useSynapse,
  useIdentify,
  usePushPermission,
  useDeepLink,
} from '@pyrx/synapse-react-native';

export default function Home() {
  const { isInitialized, track } = useSynapse();
  const { identify, isIdentified } = useIdentify();
  const { status: pushStatus, request } = usePushPermission();
  const { lastPushClick } = useDeepLink();

  // Route deep links to your navigator. The SDK does NOT auto-route —
  // see "React Navigation deep-link integration" below for the recipe.

  return (
    <View>
      <Button
        title="Identify"
        disabled={!isInitialized || isIdentified}
        onPress={() => identify('user-123', { email: 'jane@example.com' })}
      />
      <Button
        title="Track event"
        disabled={!isInitialized}
        onPress={() => track('home.viewed', { plan: 'starter' })}
      />
      <Button
        title={`Enable push (${pushStatus})`}
        onPress={() => request({ alert: true, sound: true, badge: true })}
      />
    </View>
  );
}
```

That's it. Once `request()` returns `'granted'`, the SDK registers the
device with `synapse-events.pyrx.tech` and pushes you send from the
PYRX dashboard land on the device.

---

## React Navigation deep-link integration

The `useDeepLink()` hook surfaces the latest `pyrx:push:click` payload.
The SDK does NOT auto-call `Linking.openURL` — you decide how to route.

```tsx
import { Linking } from 'react-native';
import { useEffect } from 'react';
import { useDeepLink } from '@pyrx/synapse-react-native';

function NavigationRoot() {
  const { lastPushClick, clear } = useDeepLink();

  useEffect(() => {
    if (lastPushClick?.deepLink) {
      // React Navigation's Linking config picks this up if your
      // <NavigationContainer linking={{ prefixes, config }} /> is wired.
      Linking.openURL(lastPushClick.deepLink);
      clear(); // Prevent re-firing on re-render
    }
  }, [lastPushClick, clear]);

  return <Stack.Navigator>{/* ... */}</Stack.Navigator>;
}
```

---

## API reference

| What | Where |
|---|---|
| Hooks (full signatures and examples) | [`docs/HOOKS.md`](docs/HOOKS.md) |
| Event emitter payloads | [`docs/EVENTS.md`](docs/EVENTS.md) |
| Full `Synapse` namespace reference | [`docs/API.md`](docs/API.md) |
| Bare-RN install + manual AppDelegate fallback | [`docs/INSTALL-BARE.md`](docs/INSTALL-BARE.md) |
| Migrating from the native iOS / Android SDKs | [`docs/MIGRATING-FROM-NATIVE.md`](docs/MIGRATING-FROM-NATIVE.md) |
| Future migration notes | [`docs/MIGRATION.md`](docs/MIGRATION.md) |
| Sample app | [`examples/SynapseRNDemo/`](examples/SynapseRNDemo/) |

---

## Sample app

A fully-working Expo Dev Build sample app lives in
[`examples/SynapseRNDemo/`](examples/SynapseRNDemo/). It demonstrates:

- Initializing the SDK via `<SynapseProvider>`
- Identifying a user
- Tracking an event
- Requesting push permission
- Registering for push and displaying the resulting device ID
- Receiving a foreground push and handling a tap

Run it:

```bash
cd examples/SynapseRNDemo
npm install
# Configure your workspace credentials in .env, then:
eas build --profile development --platform ios     # or android
# Install the resulting build, then:
npx expo start --dev-client
```

Send a push to the device from the PYRX dashboard's push composer and
you'll see the receipt logged in-app plus the click logged in the
dashboard's push logs.

---

## Troubleshooting

### iOS: push permission granted but no token registered

Check that your AppDelegate inherits from `PyrxSynapseAppDelegate`. If
you're on bare RN with a custom AppDelegate parent class, use the
manual forwarding pattern in [`docs/INSTALL-BARE.md`](docs/INSTALL-BARE.md).

Verify in the Xcode console that
`application:didRegisterForRemoteNotificationsWithDeviceToken:` is
being called. If it isn't, your build is missing the `aps-environment`
entitlement — re-run `expo prebuild` or check your `ios/App.entitlements`.

### iOS: pushes work on TestFlight but not in Xcode dev builds (or vice-versa)

You probably have the wrong `aps-environment`. Use `"development"` for
Xcode and EAS development profiles; use `"production"` for App Store
and TestFlight. Pass the value via the plugin option:

```json
[
  "@pyrx/synapse-react-native",
  { "iosMode": "production" }
]
```

### Android: device registers but no push lands

Verify `google-services.json` is at your Android app's root (or
referenced from `app.json` via `android.googleServicesFile`). Verify
the Firebase project ID in that file matches what the PYRX dashboard
shows for your workspace. Verify `POST_NOTIFICATIONS` is granted at
runtime — the SDK does not auto-request it; your app must call
[`PermissionsAndroid.request`](https://reactnative.dev/docs/permissionsandroid)
on Android 13+ before pushes will display.

### "The package doesn't seem to be linked"

Run `npx expo prebuild --clean`, then rebuild via EAS. If you're on
bare RN, run `cd ios && pod install` and verify
`PyrxSynapseRN` appears in your `Podfile.lock`.

### Plugin failed during `expo prebuild` with "Could not find a recognized AppDelegate parent class"

Your app's `AppDelegate.swift` / `.mm` extends a custom parent class
that isn't `RCTAppDelegate` or `ExpoAppDelegate`. The plugin won't try
to guess — use the bare-install path documented in
[`docs/INSTALL-BARE.md`](docs/INSTALL-BARE.md), which includes a
5-method-forwarding fallback.

---

## License

MIT. See [LICENSE](LICENSE).

---

## Contributing

This package is part of the [PYRX](https://pyrx.tech) ecosystem. See
[CONTRIBUTING.md](CONTRIBUTING.md) for development workflow,
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and our pull-request
guidelines. The native SDKs live in separate repos:

- [`pyrx-synapse-ios`](https://github.com/PYRX-Tech/pyrx-synapse-ios)
- [`pyrx-synapse-android`](https://github.com/PYRX-Tech/pyrx-synapse-android)
