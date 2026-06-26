# Synapse RN Demo

An Expo Dev Build sample that demonstrates every public surface of
`@pyrx/synapse-react-native`. Runs against your own PYRX workspace.

## What it shows

- `<SynapseProvider>` initialization and lifecycle state
- `useIdentify` — identify a user, see anonymous→identified merge
- `useSynapse().track` — send an event, watch `queueDepth` change
- `usePushPermission` — request OS permission cross-platform
- `usePushReceived` — handle a foreground-delivered push
- `useDeepLink` / `usePushClicked` — react to a push tap and route

## Prerequisites

- Node 20+ and a recent `npm` / `pnpm` / `yarn`
- [Expo CLI](https://docs.expo.dev/get-started/installation/) and an
  [Expo / EAS account](https://expo.dev/signup)
- A PYRX workspace with at least one API key
- For iOS: a Mac with Xcode 16+ and an Apple Developer account
- For Android: a Firebase project with Cloud Messaging enabled and a
  `google-services.json` downloaded

## 1. Install deps

From inside `examples/SynapseRNDemo/`:

```bash
npm install
```

The `@pyrx/synapse-react-native` dependency is wired to `file:../..`
so the sample uses the local SDK source. If you want to test against a
published version, change `package.json` to `"@pyrx/synapse-react-native": "^0.1.0"`.

## 2. Configure credentials

Copy `.env.example` to `.env` and fill in your workspace credentials:

```bash
cp .env.example .env
# edit .env with your workspace ID + API key
```

The variables prefixed with `EXPO_PUBLIC_` are surfaced into
`app.config.ts` via `process.env` at build time. Re-run `expo prebuild`
after changing these.

## 3. Add Firebase config (Android only)

Place your `google-services.json` at the project root
(`examples/SynapseRNDemo/google-services.json`) and uncomment the
`googleServicesFile` line in `app.config.ts`.

This file is workspace-specific and is gitignored — don't commit it.

## 4. Prebuild

```bash
npx expo prebuild --clean
```

This generates the `ios/` and `android/` native projects, running the
`@pyrx/synapse-react-native` config plugin in the process. You should
see the plugin patch `AppDelegate.swift` (or `.mm`) inheritance to
`PyrxSynapseAppDelegate` and add the entitlements.

## 5. Build a dev client

### Run on iOS simulator (fastest)

```bash
eas build --profile developmentSimulator --platform ios
```

Drag the resulting `.tar.gz` into your simulator, or use `eas build:run`.

### Run on a physical device

```bash
# iOS device:
eas build --profile development --platform ios

# Android device:
eas build --profile development --platform android
```

Install the resulting build via the QR code that EAS prints.

### Or run locally (requires native toolchains)

```bash
# iOS:
npm run ios

# Android (requires Android SDK + an emulator or device):
npm run android
```

## 6. Start the dev server and open the app

```bash
npm start
```

Open the installed dev build on your device. The app launches into the
`HomeScreen` and immediately calls `Synapse.initialize`. Within a few
seconds you should see `status: initialized` and an `anonymousId`
populated.

## 7. Exercise the surfaces

1. **Identify** — type an external ID and email, tap "Identify".
   `externalId` should populate. Open the PYRX dashboard's Contacts
   view and verify the contact appears.
2. **Track** — tap "Track demo.button.pressed" a few times. `queueDepth`
   ticks up briefly before the SDK flushes the batch.
3. **Request push** — tap "Request push". Grant permission at the OS
   prompt. Wait a few seconds for the APNs / FCM token to register.
   Open the PYRX dashboard's Devices view and verify your device
   appears with `sdk_name = PYRXSynapse-RN`.
4. **Send a push** — from the PYRX dashboard's push composer, send a
   single push targeting your device.
5. **Foreground receipt** — keep the app open and trigger the push.
   The "Foreground push receipt" section should populate with the
   title.
6. **Tap a push** — background the app, send another push, tap the
   notification. The "Push click / deep link" section should populate.
   If the push had a deep link, an "Open deep link" button appears.

## Troubleshooting

See the [main package README](../../README.md#troubleshooting).
Common issues specific to the sample:

- **`Synapse.initialize` rejects with `invalid_argument`** — likely your
  `.env` is missing `EXPO_PUBLIC_PYRX_WORKSPACE_ID` or
  `EXPO_PUBLIC_PYRX_API_KEY`. Re-run `expo prebuild`.
- **Metro complains about modules outside the project root** — make
  sure `metro.config.js` is committed (it adds the parent SDK as a
  `watchFolder`).
- **iOS build fails with "PyrxSynapseRN-Swift.h not found"** — your
  `pod install` didn't pick up the local SDK. Delete `ios/Pods/` and
  re-run `npx expo prebuild --clean`.

## What this sample is NOT

- It's not a production-ready UI. Styling is minimal so the SDK calls
  are visible. Don't ship buttons-on-cards as your real onboarding.
- It's not a comprehensive test suite. For automated tests, see the
  package's own `src/__tests__/` directory.
- It does not demonstrate React Navigation, redux integration, or
  multi-screen routing. Those are app-architecture decisions
  orthogonal to the SDK.
