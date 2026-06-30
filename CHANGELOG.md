# Changelog

All notable changes to `@pyrx/synapse-react-native` are documented in
this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-07-01

**In-app messaging surface lands.** Adds the `Synapse.inApp.*`
namespace and three new React hooks (`useInAppMessage`,
`useInAppMessageReceived`, `useInAppMessageDismissed`) — the
cross-SDK symmetric in-app messaging contract per
[ADR-0009 D5](https://github.com/PYRX-Tech/pyrx-synapse/blob/master/docs/adr/ADR-0009-in-app-sdk-surface.md).
Mirrors the browser SDK's `synapse('inApp.*', ...)` shape and the
iOS / Android `Synapse.InApp.*` / `Pyrx.inApp.*` surfaces shipped in
Phase 10 PR-2b.

The SDK delivers `InAppMessage` data to the host app's render
callback; the host app draws the UI in whatever style fits its
design system. The SDK does NOT render — PYRX UI Kit pre-built
components are deferred to Phase 10.x per ADR-0008 D2.

### Added

- **`Synapse.inApp` namespace** — five methods:
  - `show(placement, callback)` — register a render callback for a
    placement, returns an unsubscribe function. Triggers an
    immediate poll if the SDK is identified; otherwise queues until
    identify (the 10 lifecycle rules of PR #218 are owned by the
    native SDKs).
  - `getActive(placement?)` — sync read of currently-active messages
    from the in-memory cache.
  - `dismiss(messageId, reason?)` — mark a message dismissed.
    Evicts from cache, fires `pyrx:in-app:dismissed`, POSTs
    `/v1/in-app/log`. `reason` is observer-only (does NOT cross the
    wire per ADR-0008 D2).
  - `markInteracted(messageId, ctaId)` — mark a CTA tapped.
  - `refresh()` — force an immediate poll. Coalesces with any
    in-flight poll.
- **`useInAppMessage(placement, callback)`** — placement-scoped
  render hook. Wraps `Synapse.inApp.show(...)` with React lifecycle
  ergonomics (registers on mount, unregisters on unmount,
  re-registers on placement change, no re-subscribe on callback
  identity change).
- **`useInAppMessageReceived(callback)`** — global observer hook.
  Fires for every new in-app message regardless of placement; for
  cross-cutting concerns like analytics middleware.
- **`useInAppMessageDismissed(handler)`** — observer hook for
  dismissals. Fires with `(messageId, reason)` whenever
  `Synapse.inApp.dismiss(...)` is called.
- **`pyrx:in-app:received` event** — new native event name. Payload
  is the wire-shape `InAppMessage` (snake_case keys including
  `placement_key`, `message_id`, `image_url`, `expires_at`, etc.).
- **`pyrx:in-app:dismissed` event** — new native event name.
  Payload: `{ messageId: string, reason: string | null }`. `reason`
  is `null` (not `undefined`) when the caller did not provide one.
- **In-app types exported from the public surface:** `InAppMessage`,
  `InAppCta`, `InAppCtaActionType`, `InAppDismissReason`,
  `InAppRenderCallback`, `InAppMessageReceivedHandler`,
  `InAppMessageDismissedHandler`, plus the
  `InAppMessageReceivedEvent` / `InAppMessageDismissedEvent` event
  payload types.

### Changed

- Native SDK dep floors bumped:
  - iOS: `PYRXSynapse ~> 0.2.0` (was `~> 0.1.2`).
  - Android: `tech.pyrx.synapse:synapse-{core,push}` →
    `[0.2.0, 0.3.0)` (was `0.1.4+`).
  - Android: `tech.pyrx.synapse:synapse-inapp:[0.2.0, 0.3.0)` —
    NEW dependency. Bundled transitively so the host app does NOT
    need to add it manually; the wrapper's `initialize` calls
    `PyrxInApp.install(...)` after `Pyrx.initialize(...)`.
  These floors are strict because the bridge code invokes APIs that
  did not exist in the previous floors (the
  `Synapse.InApp.*` / `Pyrx.inApp.*` namespaces +
  `PyrxEvent.InAppMessage*` cases landed in Phase 10 PR-2b).
- iOS bridge (`PyrxSynapseImpl.swift`,
  `PyrxSynapseModule.h/.mm`): adds five in-app TurboModule
  methods, two new `supportedEvents` entries, and Codable-based
  payload encoding (wire-shape JSON) for the in-app observer event
  dispatch.
- Android bridge (`PyrxSynapseModule.kt`): adds five in-app
  TurboModule overrides, two new `dispatchPyrxEvent` cases, and
  kotlinx-serialization-based payload encoding for the in-app
  observer event dispatch. `initialize` now also calls
  `PyrxInApp.install(...)`. `invalidate()` also closes outstanding
  in-app show tokens so Metro fast-reload gets a clean slate.

### Migration

Adopting in-app messaging requires no changes to existing 0.2.x
code — the surface is purely additive. To start using it:

1. Bump the dep: `yarn add @pyrx/synapse-react-native@0.3.0`.
2. In any screen: `useInAppMessage('home_banner', (msg) => setActiveMessage(msg))`.
3. Render `activeMessage` in your own `<Modal>` / `<View>`.
4. On dismiss: call `Synapse.inApp.dismiss(msg.id, 'user_dismissed')`.
5. On CTA tap: call `Synapse.inApp.markInteracted(msg.id, cta.id)`.

The native SDKs handle the polling loop, in-memory cache, and the
10 lifecycle rules of PR #218 — the RN bridge is a thin
delegation layer.

See `docs/IN-APP.md` (new in this release) for the full
integration guide and a complete `<Modal>`-based render example.

## [0.2.0] — 2026-06-27

**The push-event hooks now FIRE.** The three hooks marked `STUBBED in
0.1.x` (`usePushReceived`, `usePushClicked`, `useDeepLink`) are
functional in 0.2.0 against `PYRXSynapse 0.1.2` (iOS) and
`tech.pyrx.synapse:synapse-{core,push}:0.1.4` (Android). The native
observer surfaces these wrap landed in Phase 9.2.1 — see the iOS
[PYRXSynapse 0.1.2 release](https://github.com/PYRX-Tech/pyrx-synapse-ios/releases/tag/0.1.2)
and the Android [synapse-core 0.1.4 release](https://github.com/PYRX-Tech/pyrx-synapse-android/releases/tag/0.1.4)
for the upstream observer-API docs.

### Added

- **`usePushReceivedColdStart(callback)`** — new hook. Subscribes to
  the new `pyrx:push:received-cold-start` event. Fires when the OS
  launched the app from a notification tap (terminated state). The
  native SDKs replay-buffer up to 4 most-recent events so late JS
  subscribers still catch cold-start payloads delivered before the
  bridge mounted.
- **`useIdentityChanged(callback)`** — new hook. Subscribes to the
  new `pyrx:identity:changed` event. Fires when the SDK's resolved
  identity transitions via `identify`, `alias`, or `logout`. Carries
  `{ before, after }` snapshots so dashboard-style apps can refetch
  user data on login state change without polling `useIdentify` in a
  `useEffect`.
- **`pyrx:push:received-cold-start` event** — new native event name.
  Mutually exclusive with `pyrx:push:click` for the same `pushLogId`
  (the native SDKs dedup via a 5-second LRU). Payload shape is
  identical to `pyrx:push:received`; the distinguishing signal is the
  event name.
- **`pyrx:identity:changed` event** — new native event name. See
  [`docs/EVENTS.md`](./docs/EVENTS.md#pyrxidentitychanged-020) for the
  payload shape.
- **`IdentitySnapshot`, `IdentityChangedEvent`,
  `PushReceivedColdStartEvent` types** exported from the public
  surface (`@pyrx/synapse-react-native`).
- **`pushLogId` field added to `PushReceivedEvent`** — was missing in
  0.1.x's documented type; now exposed to JS via the bridge so apps
  can correlate received pushes with `push_logs` rows or with later
  click/cold-start events.
- **`receivedAt` / `clickedAt` ISO-8601 timestamp fields** added to
  the push event payloads.

### Changed

- `usePushReceived`, `usePushClicked`, `useDeepLink` — the JSDoc
  `⚠️ NOT WIRED IN 0.1.x` callouts are removed; these hooks now fire
  as documented. The behavior change is the headline.
- `pyrxAttrs` field on `PushReceivedEvent` and `PushClickEvent` is
  now `Record<string, unknown> | null` (was `Record<string, unknown>`)
  because the native struct exposes the field as optional — pushes
  without a `pyrx_attrs` namespace produce `null` instead of `{}`.
- `events.ts` module docstring rewritten to describe the 5-event
  taxonomy and the cold-start dedup contract. The `⚠️ EVENTS NOT
  FIRING IN 0.1.x` warning block is removed.
- iOS bridge (`PyrxSynapseModule.h/.mm`, `PyrxSynapseImpl.swift`):
  inherits from `RCTEventEmitter` (was `NSObject`), subscribes to
  `Pyrx.shared.events()` AsyncStream on first JS listener attach,
  cancels on last listener detach. `supportedEvents` returns the 5
  event names.
- Android bridge (`PyrxSynapseModule.kt`): collects `Pyrx.events`
  SharedFlow in a dedicated coroutine scope on first JS listener
  attach, cancels on last listener detach. Forwards via
  `RCTDeviceEventEmitter`. `invalidate()` cleans up on bridge
  teardown so Metro fast-reload gets a clean slate.
- Native SDK dep floors bumped:
  - iOS: `PYRXSynapse ~> 0.1.2` (was `>= 0.1.1`).
  - Android: `tech.pyrx.synapse:synapse-{core,push}:0.1.4+` (was
    `0.1.3+`).
  These floors are strict because the bridge code subscribes to APIs
  that did not exist in the previous floors.

### Removed

- `src/hooks/__hookStubWarning.ts` — DELETED. The one-time
  `console.warn` warning that hooks were no-op is 0.1.x-only.
- `QueueDrainedEvent.batchId` field declaration — never populated by
  the native side. Type tightened to match runtime shape. Apps that
  subscribed in 0.1.x and read `batchId` would have seen `undefined`
  regardless; no behavior change for working consumers.

### Test coverage

- 90 → 107 jest tests (+17). New tests cover both new hooks (cold-
  start firing + dedup invariant, identity transitions + before-null
  semantics) and the 5-event surface of `synapseEvents`.

### Migration notes (0.1.x → 0.2.0)

- **If you integrated `usePushReceived` / `usePushClicked` /
  `useDeepLink` in 0.1.x against the no-op contract**: those
  callbacks now actually fire. Verify your handlers are idempotent
  and handle the data shape correctly.
- **If you wrote a workaround that captured push events in your
  AppDelegate / FirebaseMessagingService**: you can keep it OR
  delete it and use the now-functional hooks. Don't run both — you'll
  get duplicate handling.
- **If you `switch` over `SynapseEventName`**: add cases for
  `'pyrx:push:received-cold-start'` and `'pyrx:identity:changed'`,
  or rely on the union type's exhaustiveness check to flag the
  missing cases at compile time.

## [0.1.1] — 2026-06-27

Documentation-only release. Marks the push-event subscription hooks as
NOT WIRED in 0.1.x so customers don't waste integration time against
stubbed surfaces. No behaviour change vs 0.1.0 — these hooks never
fired in 0.1.0 either; this release adds the warnings the original
release missed.

### Changed

- `usePushReceived`, `usePushClicked`, `useDeepLink` — JSDoc + README
  + one-time `console.warn` at first subscription explain the hook is
  stubbed in 0.1.x and link to the tracking issue.
- `src/events.ts` — module-level JSDoc + per-event constant docs note
  that the native producer side is not implemented; `pyrx:queue:drained`
  has no internal observer in the underlying SDKs at all.
- `README.md` — new "Known limitations in 0.1.x" callout at the top of
  the supported-platforms section.

### Known limitations (carries forward from 0.1.0; fixed in 0.2.0)

The following are intentionally NOT WIRED in 0.1.x — fixing them
requires the underlying iOS / Android SDKs to expose observer APIs,
which is the scope of Phase 9.2.1:

- `usePushReceived(callback)` — registers a listener but the callback
  never fires
- `usePushClicked(callback)` — same
- `useDeepLink()` — built on `usePushClicked`; `lastPushClick` never
  updates
- `pyrx:queue:drained` event — documented but no internal drain
  observer exists in the underlying SDKs

The 12 imperative `Synapse.*` methods (`initialize`, `identify`,
`alias`, `logout`, `track`, `screen`, `requestPushPermission`,
`registerForPushNotifications`, etc.) all work as documented.

### Fixed

- (none — no code change; behavior identical to 0.1.0)

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
