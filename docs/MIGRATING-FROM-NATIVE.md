# Migrating from the native iOS / Android SDKs

If your app currently uses the [`PYRXSynapse`](https://github.com/PYRX-Tech/pyrx-synapse-ios)
iOS Pod or the [`tech.pyrx.synapse:synapse-{core,push}`](https://github.com/PYRX-Tech/pyrx-synapse-android)
Android AARs directly — e.g., because you started as a bare iOS app
and added React Native later — switching to `@pyrx/synapse-react-native`
is mostly mechanical. This document walks you through it.

**Most things stay the same.** Your backend workspace, API keys, push
templates, segmentation, and event names are all unchanged. The same
device shows up in the same dashboard with the same `external_id`. You
are switching the SDK layer, not the data layer.

## What changes

| Surface | Before (native direct) | After (RN wrapper) |
|---|---|---|
| Init call | `Pyrx.shared.initialize(config:)` in Swift or `Pyrx.initialize(...)` in Kotlin | `Synapse.initialize({...})` in TS, or `<SynapseProvider config={...}>` |
| Identify | `Pyrx.shared.identify(externalId:traits:)` | `Synapse.identify(externalId, traits)` |
| Track | `Pyrx.shared.track(eventName:properties:)` | `Synapse.track(eventName, properties)` |
| Request push | `Pyrx.shared.requestPushPermission(options:)` | `usePushPermission().request(...)` or `Synapse.requestPushPermission(...)` |
| Logout | `Pyrx.shared.logout()` | `Synapse.logout()` |
| Delete user | `Pyrx.shared.deleteUser()` | `Synapse.deleteUser()` |
| AppDelegate parent | `PyrxAppDelegate` or manual forwarding | `PyrxSynapseAppDelegate` (RN-specific base class) |
| Android FCM service | Already auto-registered by the synapse-push AAR | Same — no change |

The TypeScript method names mirror the native ones 1:1. Property and
parameter shapes are the same. Wire-level payloads are byte-for-byte
identical (the RN wrapper is just a TurboModule bridge to the same
native code).

## Step-by-step

### 1. Install the RN package

Follow the install path that matches your project shape:

- Expo Dev Build: [README §Install](../README.md#expo-dev-build-recommended-for-new-apps)
- Bare RN: [docs/INSTALL-BARE.md](./INSTALL-BARE.md)

### 2. Move the `Pyrx.shared.initialize(...)` call to your React tree

**Before** (Swift, in `AppDelegate.swift`):

```swift
override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
) -> Bool {
    Task {
        try await Pyrx.shared.initialize(config: PyrxConfig(
            workspaceId: "wks_xxx",
            apiKey: "psk_live_xxx",
            environment: .production
        ))
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
}
```

**After** (TypeScript, in your React root):

```tsx
// App.tsx
import { SynapseProvider } from '@pyrx/synapse-react-native';

export default function App() {
  return (
    <SynapseProvider config={{
      workspaceId: 'wks_xxx',
      apiKey: 'psk_live_xxx',
      environment: 'production',
    }}>
      <RootNavigator />
    </SynapseProvider>
  );
}
```

You can also use `Synapse.initialize(...)` directly from a non-React
entry point if you have a hybrid app structure — call it once on app
startup and you're done.

### 3. Switch your AppDelegate parent class (iOS only)

If your AppDelegate previously extended `PyrxAppDelegate` (the iOS
SDK's optional convenience base class), switch to
`PyrxSynapseAppDelegate` (the RN-specific equivalent). The forwarded
methods are the same; the difference is that `PyrxSynapseAppDelegate`
extends `RCTAppDelegate` so React Native's bridge setup runs.

If you previously used manual forwarding (you didn't extend any PYRX
base class), nothing changes — keep your existing forwarding code.

### 4. Translate your call sites from Swift / Kotlin to TypeScript

This is the bulk of the work and is mechanical. For each
`Pyrx.shared.method(...)` (iOS) or `Pyrx.method(...)` (Android) call
in your native code, find the equivalent JS call site (or create a
new one) and replace.

If a method is called from a place that doesn't have a React tree
above it (e.g., a background task scheduler, a deep link handler in
the native side), keep the native call — both layers can coexist.
The RN wrapper and the native SDK share the same singleton; events
tracked from either side land in the same queue.

### 5. Re-verify push registration

After the switch:

1. Run your app on a device.
2. Trigger `requestPushPermission`.
3. Open the PYRX dashboard's Devices view. The device should appear
   with `sdk_name = "PYRXSynapse-RN"` (vs the previous
   `"PYRXSynapse"`). This is the only data-side artifact of the
   switch and is cosmetic — it tells the dashboard "this device is
   using the RN wrapper" so support tickets can route correctly.
4. Send a push from the dashboard's push composer. It should land
   exactly as before.

### 6. Remove the old native call sites

Once the RN call sites are wired up and verified, delete the
corresponding Swift / Kotlin `Pyrx.*` calls. The native SDK itself
stays linked — the RN wrapper depends on it.

## What you do NOT need to change

- Backend workspace, API keys, or environment settings
- Push templates, campaigns, or segmentation rules
- Event names, property schemas, or your analytics warehouse mappings
- Device tokens — existing tokens continue to work; no re-registration needed
- `external_id` values — the same user is still the same user
- iOS Apple push certificate / key
- Android Firebase project or `google-services.json`

## Hybrid setups

You can keep some PYRX calls in native code and move others to RN.
The two layers share the same singleton state — events tracked from
JS and events tracked from native both land in the same offline queue
and flush to the same `/v1/events/batch` endpoint. Identity set from
either side is visible to both.

This is useful when:

- A background `BGTaskScheduler` / `WorkManager` job needs to fire a
  PYRX event from a context where JS isn't running.
- A native-side deep link handler needs to call `Synapse.track` before
  the React tree mounts.
- You're migrating incrementally and want both code paths live during
  the rollout.

## Troubleshooting the migration

### "I see duplicate events in my dashboard after switching"

You're probably calling the same event from both the old native call
site and the new RN call site. Remove the native call. The RN
wrapper is the source of truth post-migration.

### "Identity is reset after I switch"

Identity persists in the encrypted store, which the SDK reads on
init. As long as your `workspaceId` is unchanged, the SDK should
restore the same `anonymousId` and `externalId` on the first
`Synapse.initialize` call. If you see a reset, check that you didn't
accidentally change `workspaceId` or change the iOS / Android keychain
group / encrypted shared prefs name.

### "My iOS app builds but pushes don't arrive"

Check that you actually changed the AppDelegate parent class to
`PyrxSynapseAppDelegate` — without that change, the APNs token
registration callback fires but isn't forwarded to the SDK. Verify
by adding a breakpoint in your AppDelegate's
`didRegisterForRemoteNotificationsWithDeviceToken` override and
confirming `super` is called.
