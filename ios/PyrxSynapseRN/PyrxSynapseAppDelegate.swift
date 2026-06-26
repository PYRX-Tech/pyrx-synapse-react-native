/*
 * PyrxSynapseAppDelegate.swift
 * @pyrx/synapse-react-native — iOS lifecycle base class.
 *
 * Customers subclass this in their `AppDelegate.swift` instead of
 * `RCTAppDelegate` and get APNs registration, cold-start push attribution,
 * foreground/background/tap handlers, and APNs error logging wired up
 * with zero glue:
 *
 *     // AppDelegate.swift (RN bare or Expo Dev Build)
 *     import PyrxSynapseRN
 *
 *     @main
 *     class AppDelegate: PyrxSynapseAppDelegate {
 *         // override application(_:didFinishLaunchingWithOptions:) to
 *         // add your own setup; remember to call super.
 *     }
 *
 * The Expo config plugin (PR-3) automatically patches the customer's
 * AppDelegate inheritance line to point at this class — bare RN
 * customers do the edit by hand. Customers with a custom AppDelegate
 * parent class can call the 5 forwarded methods manually instead; see
 * docs/INSTALL-BARE.md (PR-3).
 *
 * Why subclass `RCTAppDelegate`?
 * ------------------------------
 * RN 0.76+ ships `RCTAppDelegate` as the base class every new RN app's
 * AppDelegate inherits from. It owns React Native bridge setup, hot
 * reload, the root view controller, and a dozen other things we MUST
 * not break. Subclassing means the customer's RN behavior is unchanged;
 * we add PYRX behavior on top of the RN scaffolding.
 *
 * What this class does NOT do
 * ---------------------------
 * - Does not call `Pyrx.shared.initialize(config:)` — that's the JS
 *   layer's job (the customer's React tree calls Synapse.initialize()).
 *   We can't initialize on the app delegate because we don't know the
 *   workspaceId / apiKey at native-load time.
 * - Does not request push permission — Synapse.requestPushPermission()
 *   on the JS side does that.
 *
 * What this class DOES do (automatically, no JS-side wiring needed)
 * -----------------------------------------------------------------
 * - Captures `launchOptions[.remoteNotification]` on cold start and
 *   replays it through `Pyrx.shared.recordColdStartLaunch` AS SOON AS
 *   `Pyrx.shared.initialize` has completed. We can't fire the call
 *   synchronously here (the JS layer hasn't initialized the SDK yet),
 *   so we cache the payload and let the SDK consume it on next read.
 * - Forwards `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
 *   into `Pyrx.shared.handleDeviceToken(_:)`.
 * - Forwards `application(_:didFailToRegisterForRemoteNotificationsWithError:)`
 *   into `Pyrx.shared.handleRegistrationError(_:)`.
 * - Forwards `userNotificationCenter(_:willPresent:withCompletionHandler:)`
 *   into `Pyrx.shared.handleForegroundNotification(_:)`.
 * - Forwards `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`
 *   into `Pyrx.shared.handleBackgroundNotification(...)`.
 * - Forwards `userNotificationCenter(_:didReceive:withCompletionHandler:)`
 *   into `Pyrx.shared.handleNotificationResponse(_:completion:)`.
 */

import Foundation
import PYRXSynapse
import React
import UIKit
import UserNotifications

#if canImport(React_RCTAppDelegate)
import React_RCTAppDelegate
#endif

/// Inheritance target for customer `AppDelegate.swift`. See file header
/// for the integration recipe.
@objc(PyrxSynapseAppDelegate)
open class PyrxSynapseAppDelegate: RCTAppDelegate, UNUserNotificationCenterDelegate {

    /// Cached cold-start push payload — populated in
    /// `application(_:didFinishLaunchingWithOptions:)` from
    /// `launchOptions[.remoteNotification]` BEFORE the JS bridge is
    /// alive, then replayed once `Pyrx.shared.initialize` has completed.
    ///
    /// We can't make the call synchronously in `didFinishLaunching`:
    /// `Pyrx.shared.recordColdStartLaunch` only buffers if the SDK has
    /// been initialized, and `Synapse.initialize()` (JS-side) won't be
    /// called until the React tree mounts. So we cache here, watch the
    /// SDK's debug state on a short tick, and replay once we see it
    /// flip to initialized.
    private var coldStartPayload: [AnyHashable: Any]?

    open override func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // Capture the cold-start push BEFORE letting super run — `super`
        // bootstraps the JS bridge, which may begin draining the queue
        // immediately; we want the payload latched first.
        if let payload = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            coldStartPayload = payload
            schedulePayloadReplay()
        }
        // Install ourselves as the UN delegate so the foreground / tap
        // handlers fire. If the customer's subclass replaces this in
        // their override, they should re-install themselves or forward
        // the UN delegate methods manually.
        UNUserNotificationCenter.current().delegate = self

        return super.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    // MARK: - APNs token + error

    open override func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task {
            // `handleDeviceToken` is `async throws` — we discard the
            // result (the SDK's own logger captures the outcome) and
            // swallow errors because there's nothing actionable a
            // customer subclass could do here.
            _ = try? await Pyrx.shared.handleDeviceToken(deviceToken)
        }
    }

    open override func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task {
            await Pyrx.shared.handleRegistrationError(error)
        }
    }

    // MARK: - Foreground / background / tap

    /// Foreground push presentation. Asks the SDK what banner / badge /
    /// sound options the OS should apply.
    open func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        Task {
            let options = await Pyrx.shared.handleForegroundNotification(notification)
            completionHandler(options)
        }
    }

    /// Background / silent push delivery. The SDK enqueues a
    /// `$push_received` event and signals .newData / .noData to the OS.
    open override func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Pyrx.shared.handleBackgroundNotification(userInfo: userInfo) { result in
            completionHandler(Self.bridge(result))
        }
    }

    /// Notification tap / custom-action button.
    open func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task {
            await Pyrx.shared.handleNotificationResponse(response, completion: completionHandler)
        }
    }

    // MARK: - Cold-start payload replay

    /// Repeatedly check whether the SDK has been initialized; once it
    /// has, replay the cached cold-start payload and stop checking.
    ///
    /// We use a polling loop rather than a notification because the iOS
    /// SDK does not currently expose an "initialized" KVO / Combine
    /// signal — and the JS-side initialize() runs on a timeline we
    /// don't control. The polling interval is conservative (200ms) and
    /// the loop self-cancels after 30 seconds if init never completes
    /// (the user likely never mounted the React tree — abandon the
    /// replay rather than leak the timer).
    private func schedulePayloadReplay() {
        Task { @MainActor in
            let deadline = Date().addingTimeInterval(30)
            while Date() < deadline {
                let info = await Pyrx.shared.debugInfo()
                if info.initialized {
                    if let payload = coldStartPayload {
                        await Pyrx.shared.recordColdStartLaunch(userInfo: payload)
                        coldStartPayload = nil
                    }
                    return
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            // Fell through — abandon the payload to prevent stale data
            // bleeding into a much-later session.
            coldStartPayload = nil
        }
    }

    // MARK: - Helpers

    /// Bridge the SDK's PyrxBackgroundFetchResult into the UIKit
    /// `UIBackgroundFetchResult` the system completion handler expects.
    private static func bridge(_ result: PyrxBackgroundFetchResult) -> UIBackgroundFetchResult {
        switch result {
        case .newData: return .newData
        case .noData:  return .noData
        case .failed:  return .failed
        }
    }
}
