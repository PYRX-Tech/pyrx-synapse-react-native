# Changelog

All notable changes to `@pyrx/synapse-react-native` are documented in
this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06-27

Initial public release. Ships the React Native wrapper around the
published [PYRXSynapse iOS SDK](https://github.com/PYRX-Tech/pyrx-synapse-ios)
(`PYRXSynapse` 0.1.1+, via CocoaPods Trunk and Swift Package Manager)
and the [PYRX Synapse Android SDKs](https://github.com/PYRX-Tech/pyrx-synapse-android)
(`tech.pyrx.synapse:synapse-core` and `tech.pyrx.synapse:synapse-push`
0.1.3+, via Maven Central).

### Added

- **`Synapse` namespace** — imperative TypeScript API that mirrors the
  native SDKs' public surface. Methods: `initialize`, `identify`,
  `alias`, `logout`, `track`, `screen`, `requestPushPermission`,
  `setTrackingEnabled`, `deleteUser`, `setLogLevel`, `debugInfo`.
- **`SynapseError`** — typed error class with machine-readable `code`
  field. Codes: `not_initialized`, `permission_denied`, `network_error`,
  `invalid_argument`, `internal_error`.
- **React hooks**:
  - `useSynapse()` — primary hook; returns the imperative API plus
    reactive state (`isInitialized`, `anonymousId`, `externalId`,
    `queueDepth`).
  - `useIdentify()` — identity-only sugar over `useSynapse`.
  - `usePushPermission()` — returns current permission state and a
    `request()` callback.
  - `usePushReceived(handler)` — subscribes to foreground push delivery.
  - `usePushClicked(handler)` — subscribes to push tap events.
  - `useDeepLink()` — exposes the latest `pyrx:push:click` payload for
    React Navigation `Linking` integration.
- **`<SynapseProvider>`** — root context provider; eagerly initializes
  the SDK from a `config` prop and exposes lifecycle status to children.
- **`synapseEvents`** — typed `NativeEventEmitter` wrapper. Events:
  `pyrx:push:received`, `pyrx:push:click`, `pyrx:queue:drained`.
- **iOS native bridge** — TurboModule (`PyrxSynapseModule`) and
  `PyrxSynapseAppDelegate` base class. Customers subclass
  `PyrxSynapseAppDelegate` in their `AppDelegate.swift` /
  `AppDelegate.mm` to wire APNs registration, cold-start push
  attribution, and foreground/background/tap handlers automatically.
- **Android native bridge** — TurboModule (`PyrxSynapseModule`) and
  `PyrxSynapsePackage` registration. The Firebase Messaging service
  (`tech.pyrx.synapse.push.PyrxMessagingService`) is provided by the
  published `synapse-push` AAR and registered automatically via
  Android's manifest merger — no customer-side manifest edits needed.
- **Expo config plugin** — `@pyrx/synapse-react-native/app.plugin.js`
  (default-resolved when customers add the package name to their
  `expo.plugins` array). Patches the customer's `AppDelegate.swift` /
  `AppDelegate.mm` inheritance line, adds the `aps-environment`
  entitlement, adds `UIBackgroundModes: [remote-notification]` to
  Info.plist, and adds `POST_NOTIFICATIONS` to the Android manifest.
  Plugin options: `iosMode` (`"development"` | `"production"`),
  `androidPostNotificationsPermission` (boolean).
- **Sample app** — `examples/SynapseRNDemo/`, an Expo Dev Build that
  demonstrates init → identify → track → push permission → register
  device → display received push → handle deep link via `useDeepLink`.
- **Documentation** — `README.md`, `docs/INSTALL-BARE.md`,
  `docs/HOOKS.md`, `docs/EVENTS.md`, `docs/API.md`,
  `docs/MIGRATING-FROM-NATIVE.md`, `docs/MIGRATION.md`.

### Supported platforms

- **React Native** 0.76+
- **Expo SDK** 52+ (Expo Dev Build; Expo Go is not supported because
  the wrapper ships custom native modules)
- **iOS** 14.0+
- **Android** API 24+

### Native SDK pins

- iOS Podfile: `PYRXSynapse >= 0.1.1`
- Android Gradle: `tech.pyrx.synapse:synapse-core:0.1.3+`,
  `tech.pyrx.synapse:synapse-push:0.1.3+`

### Known limitations

- **Expo SDK 53+ with Swift AppDelegate**: the plugin replaces
  inheritance from `ExpoAppDelegate` → `PyrxSynapseAppDelegate`. The
  base class currently extends `RCTAppDelegate`, so apps that rely on
  Expo-Modules-only behavior delivered via the `ExpoAppDelegate`
  subscriber pattern may need to use the bare-install path. See
  `docs/INSTALL-BARE.md` for the manual integration.
- **Expo Go**: not supported. Use an Expo Dev Build or bare RN.
- **RN Web**: out of scope. Use `@pyrx/synapse-browser` for web.
