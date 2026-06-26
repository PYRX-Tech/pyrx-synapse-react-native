# Bare React Native install

For Expo Dev Build customers, the config plugin handles all of this
automatically — see the [README](../README.md) for the Expo path. This
document is for **bare React Native apps** (apps created via
`npx @react-native-community/cli init` or otherwise not using Expo's
config plugin system).

## Prerequisites

- React Native 0.76 or later (New Architecture)
- iOS 14.0+, Android API 24+
- An [Apple Developer account](https://developer.apple.com) with push
  notifications enabled for your app's bundle ID
- A [Firebase project](https://console.firebase.google.com/) with
  Cloud Messaging enabled and your `google-services.json` downloaded
- A PYRX workspace API key (`psk_live_xxx` or `psk_test_xxx`)

## 1. Install the package

```bash
npm install @pyrx/synapse-react-native
# or yarn / pnpm
```

## 2. iOS setup

### 2a. Run `pod install`

```bash
cd ios && pod install
```

This pulls in the `PyrxSynapseRN` Pod plus its transitive dependency
on `PYRXSynapse` (>= 0.1.1).

### 2b. Change AppDelegate inheritance

Open `ios/<YourAppName>/AppDelegate.swift` (or `.mm` if you're on an
older bare RN template) and change the inheritance from
`RCTAppDelegate` to `PyrxSynapseAppDelegate`:

**Swift:**

```swift
// AppDelegate.swift
import Foundation
import React
import UIKit
import PyrxSynapseRN  // <-- add this import

@UIApplicationMain
class AppDelegate: PyrxSynapseAppDelegate {  // <-- change parent from RCTAppDelegate
    // Keep your existing overrides; remember to call super.
}
```

**Objective-C++:**

```objc
// AppDelegate.h
#import <PyrxSynapseRN/PyrxSynapseRN-Swift.h>  // <-- add this import

@interface AppDelegate : PyrxSynapseAppDelegate  // <-- change parent from RCTAppDelegate
@end
```

### 2c. Add entitlements

Open `ios/<YourAppName>/<YourAppName>.entitlements` (create one if it
doesn't exist) and add:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>aps-environment</key>
    <string>development</string>
    <!-- Use "production" for App Store and TestFlight builds. -->
</dict>
</plist>
```

In Xcode, select your target → Signing & Capabilities → `+ Capability`
→ Push Notifications to ensure the entitlement is wired into your
signing configuration.

### 2d. Add Info.plist background mode

In `ios/<YourAppName>/Info.plist`, add `remote-notification` to
`UIBackgroundModes`:

```xml
<key>UIBackgroundModes</key>
<array>
    <string>remote-notification</string>
</array>
```

This is required for silent / background push delivery to fire your
SDK handlers reliably.

### 2e. (Optional fallback) If you can't change AppDelegate inheritance

If your AppDelegate must inherit from a different base class (for
example, you're already wrapping Adjust or another SDK that provides
its own base class), you can keep your existing parent and call the
five forwarded methods manually:

```swift
import PYRXSynapse
import UserNotifications

class AppDelegate: SomeOtherSDKBaseDelegate, UNUserNotificationCenterDelegate {

    override func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // 1. Cold-start push capture
        if let payload = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            Task { await Pyrx.shared.recordColdStartLaunch(userInfo: payload) }
        }
        UNUserNotificationCenter.current().delegate = self
        return super.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    // 2. APNs token
    override func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { _ = try? await Pyrx.shared.handleDeviceToken(deviceToken) }
    }

    // 3. APNs registration error
    override func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { await Pyrx.shared.handleRegistrationError(error) }
    }

    // 4. Foreground presentation
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        Task {
            let options = await Pyrx.shared.handleForegroundNotification(notification)
            completionHandler(options)
        }
    }

    // 5. Tap / action handling
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task { await Pyrx.shared.handleNotificationResponse(response, completion: completionHandler) }
    }
}
```

This is what `PyrxSynapseAppDelegate` does internally — you're replicating
the forwarding so you can keep your custom parent class.

## 3. Android setup

### 3a. Place `google-services.json`

Put your `google-services.json` at `android/app/google-services.json`.
If you don't already have the Google Services Gradle plugin wired up,
add to `android/build.gradle`:

```groovy
buildscript {
    dependencies {
        classpath 'com.google.gms:google-services:4.4.2'
    }
}
```

And to `android/app/build.gradle`:

```groovy
apply plugin: 'com.google.gms.google-services'
```

### 3b. Add `POST_NOTIFICATIONS` permission

In `android/app/src/main/AndroidManifest.xml`, inside the `<manifest>`
tag:

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

Android 13+ requires this permission to be granted at runtime before
push notifications can display. Your app code should call
`PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS')`
at an appropriate point — or use the `usePushPermission()` hook from
this package, which handles iOS and Android in one call.

### 3c. (No service registration needed)

The `synapse-push` AAR's manifest already declares
`tech.pyrx.synapse.push.PyrxMessagingService` as the `FirebaseMessagingService`.
Android's manifest merger picks this up automatically when you add the
`synapse-push` dependency — no manual `<service>` entry is needed in
your app's manifest.

If you have your own custom `FirebaseMessagingService` that you want
to keep, you can subclass `PyrxMessagingService` instead of
`FirebaseMessagingService` and re-declare the service in your manifest
with `tools:replace="android:name"`. See the
[`synapse-push` README](https://github.com/PYRX-Tech/pyrx-synapse-android)
for the subclass pattern.

## 4. Initialize from your React tree

Same as the Expo path — wrap your app in `<SynapseProvider>` and use
the hooks. See the [main README quick start](../README.md#quick-start).

## 5. Verify the install

After running your app on a device:

1. Look for `[PYRXSynapse]` log lines in the device console (Xcode or
   `adb logcat`).
2. Open the PYRX dashboard's Devices view. After `requestPushPermission`
   returns `'granted'` and a few seconds pass for the APNs / FCM token
   to be returned, your device should appear with `sdk_name` matching
   `PYRXSynapse-RN` and the correct platform.
3. From the dashboard's push composer, send a single push targeting
   that device. It should arrive and (on tap) fire your `useDeepLink`
   handler.

If anything in this flow fails, see the
[Troubleshooting section of the main README](../README.md#troubleshooting).
