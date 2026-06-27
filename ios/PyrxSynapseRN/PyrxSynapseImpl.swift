/*
 * PyrxSynapseImpl.swift
 * @pyrx/synapse-react-native — Swift implementation behind the ObjC++
 * TurboModule glue (`PyrxSynapseModule.mm`).
 *
 * This is where the bridge actually talks to the published `PYRXSynapse`
 * SDK. Every method here:
 *   - Lives on a `@MainActor`-isolated singleton (a class deliberately
 *     constrained to the main actor so the ObjC bridge can call
 *     `[PyrxSynapseImpl shared]` from any thread without an unsafe
 *     race — the Swift compiler enforces the isolation).
 *   - Bridges JS-friendly types (NSString, NSDictionary) to the
 *     Swift-typed inputs the wrapper expects.
 *   - Hops into the wrapper via `Task { await … }`, then resolves or
 *     rejects the RN promise from the result.
 *
 * Wrapper-DI testability seam
 * ---------------------------
 * Method bodies invoke `wrapper.identify(...)` instead of
 * `Pyrx.shared.identify(...)`. The production singleton constructs a
 * `ProductionPyrxWrapper` which forwards 1:1 to `Pyrx.shared`. Tests
 * construct `PyrxSynapseImpl(wrapper: MockPyrxWrapper())` and assert on
 * the recorded calls without touching the real SDK. See
 * `PyrxWrapper.swift` for the protocol definition.
 *
 * Pure marshalling helpers (JSON parsing, status string, error mapping,
 * IdentityResult → dict) live in `PyrxSynapseImplHelpers.swift` so they
 * can be unit-tested without the React dependency this file carries.
 *
 * Error mapping
 * -------------
 * `PyrxError` cases are mapped to one of the JS-visible codes the
 * TurboModule spec promises (see src/NativePyrxSynapse.ts file header):
 *   - .notInitialized   → "not_initialized"
 *   - .invalidConfig    → "invalid_argument"
 *   - .network          → "network_error"
 *   - .keychainFailure  → "internal_error"
 *   - .alreadyInitialized (when config differs) → "invalid_argument"
 *   - <anything else>   → "internal_error"
 *
 * What's intentionally NOT here
 * ----------------------------
 * - `handleDeviceToken` — wired by `PyrxSynapseAppDelegate.swift`; not
 *   exposed to JS.
 * - `recordColdStartLaunch` — captured by `PyrxSynapseAppDelegate.swift`
 *   on `application:didFinishLaunchingWithOptions:` before JS is alive.
 * - `handleNotificationResponse` / `handleForegroundNotification` —
 *   wired by `PyrxSynapseAppDelegate.swift`. The resulting telemetry
 *   does NOT yet flow to JS in v0.1.x — the
 *   `pyrx:push:received` / `pyrx:push:click` / `pyrx:queue:drained`
 *   events declared in `src/events.ts` are not emitted natively in
 *   this version. Wiring them is tracked in PR-1 follow-up
 *   issue #4 ("Wire native push event emission, Phase 9.2.1");
 *   blocked on observer APIs landing in `PYRXSynapse` 0.1.2.
 */

import Foundation
import PYRXSynapse
import React
import UserNotifications

@objc(PyrxSynapseImpl)
@MainActor
public final class PyrxSynapseImpl: NSObject {

    /// Singleton handle the ObjC bridge calls via `[PyrxSynapseImpl shared]`.
    /// The `@MainActor` annotation on the class forces every call site to
    /// be main-actor isolated — RN's TurboModule machinery already calls
    /// us on the main thread for promise-returning methods, so this is
    /// a tightening rather than an addition.
    @objc public static let shared = PyrxSynapseImpl()

    /// Wrapper around the SDK's `Pyrx.shared` actor. Production code
    /// uses `ProductionPyrxWrapper`; tests inject a mock via the
    /// designated initializer. See `PyrxWrapper.swift`.
    private let wrapper: PyrxWrapper

    /// Track outstanding listener count so we can stop emitting / clean
    /// up if a future event source needs to know nobody is listening.
    /// Today the count is bookkeeping-only; we still increment/decrement
    /// because RN requires the protocol methods to exist.
    private var listenerCount: Int = 0

    /// Production-path initializer used by the singleton. Injects the
    /// `ProductionPyrxWrapper` which forwards 1:1 to `Pyrx.shared`.
    private override init() {
        self.wrapper = ProductionPyrxWrapper()
        super.init()
    }

    /// Test-path initializer. Lets a test substitute the wrapper without
    /// touching the singleton. Tests construct a fresh `PyrxSynapseImpl`
    /// per test case to keep listener-count and wrapper state isolated.
    ///
    /// `internal` rather than `public` because customers should never
    /// construct this directly — the ObjC bridge calls the singleton.
    /// The `@testable import` in the test target reaches this.
    internal init(wrapper: PyrxWrapper) {
        self.wrapper = wrapper
        super.init()
    }

    // MARK: - Lifecycle

    @objc public func initialize(
        config: [String: Any],
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        guard
            let workspaceIdRaw = config["workspaceId"] as? String,
            let workspaceId = UUID(uuidString: workspaceIdRaw)
        else {
            rejecter("invalid_argument", "workspaceId must be a UUID string", nil)
            return
        }
        guard let apiKey = config["apiKey"] as? String, !apiKey.isEmpty else {
            rejecter("invalid_argument", "apiKey must be a non-empty string", nil)
            return
        }
        guard let envRaw = config["environment"] as? String else {
            rejecter("invalid_argument", "environment must be 'production' or 'sandbox'", nil)
            return
        }
        let environment: PyrxEnvironment
        switch envRaw {
        case "production": environment = .production
        case "sandbox":    environment = .sandbox
        default:
            rejecter("invalid_argument",
                     "environment must be 'production' or 'sandbox' (got '\(envRaw)')",
                     nil)
            return
        }

        // Optional fields — fall back to the SDK defaults when omitted.
        let baseUrl: URL
        if let raw = config["baseUrl"] as? String, let url = URL(string: raw) {
            baseUrl = url
        } else {
            baseUrl = PyrxConfig.defaultBaseUrl
        }

        let logLevel: LogLevel =
            PyrxSynapseImplHelpers.parseLogLevel(
                (config["logLevel"] as? String) ?? "info"
            ) ?? .info

        let maxQueueSize = (config["maxQueueSize"] as? NSNumber)?.intValue ?? 1000

        // The wrapper-variant marker — read PRODUCT_PROFILE convention
        // and the side-PR in pyrx-synapse-ios (#12). Telemetry-only;
        // produces `sdk_platform = "ios+rn"` on /v1/devices.
        let pyrxConfig = PyrxConfig(
            workspaceId: workspaceId,
            apiKey: apiKey,
            environment: environment,
            baseUrl: baseUrl,
            logLevel: logLevel,
            maxQueueSize: maxQueueSize,
            sdkVariant: "rn"
        )

        Task {
            do {
                try await wrapper.initialize(config: pyrxConfig)
                resolver(NSNull())
            } catch let error as PyrxError {
                Self.reject(rejecter, error)
            } catch {
                rejecter("internal_error", error.localizedDescription, error)
            }
        }
    }

    @objc public func setLogLevel(
        level: String,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        guard let parsed = PyrxSynapseImplHelpers.parseLogLevel(level) else {
            rejecter("invalid_argument",
                     "logLevel must be one of debug|info|warning|error|none (got '\(level)')",
                     nil)
            return
        }
        // setLogLevel on the Pyrx actor is async (actor isolation) but
        // not throws — hop into the actor's context, then resolve.
        Task {
            await wrapper.setLogLevel(parsed)
            resolver(NSNull())
        }
    }

    @objc public func debugInfo(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        Task {
            let info = await wrapper.debugInfo()
            // PyrxDebugInfo exposes `hasExternalId` (Bool) but NOT the
            // externalId string — the SDK keeps it in encrypted storage
            // and only surfaces presence in the debug snapshot. The JS
            // side handles that by reflecting `externalId: null` when
            // hasExternalId is false; when true, JS code that needs the
            // value can call identify() to re-confirm.
            resolver([
                "initialized": info.initialized,
                "anonymousId": info.anonymousId as Any? ?? NSNull(),
                "externalId": NSNull(), // see comment above; presence only
                "hasDeviceToken": info.hasDeviceToken,
                "queueDepth": info.eventQueueDepth,
                "sdkVersion": info.sdkVersion,
                "sdkPlatform": info.platform,
                "trackingEnabled": info.trackingEnabled
            ] as [String: Any])
        }
    }

    // MARK: - Identity

    @objc public func identify(
        externalId: String,
        traitsJson: String?,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let traits = PyrxSynapseImplHelpers.parseJSONValueObject(traitsJson)
        Task {
            do {
                let result = try await wrapper.identify(
                    externalId: externalId,
                    traits: traits
                )
                resolver(PyrxSynapseImplHelpers.identityResultDict(result))
            } catch let error as PyrxError {
                Self.reject(rejecter, error)
            } catch {
                rejecter("internal_error", error.localizedDescription, error)
            }
        }
    }

    @objc public func alias(
        newExternalId: String,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        Task {
            do {
                let result = try await wrapper.alias(newExternalId: newExternalId)
                resolver(PyrxSynapseImplHelpers.identityResultDict(result))
            } catch let error as PyrxError {
                Self.reject(rejecter, error)
            } catch {
                rejecter("internal_error", error.localizedDescription, error)
            }
        }
    }

    @objc public func logout(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        Task {
            do {
                try await wrapper.logout()
                resolver(NSNull())
            } catch let error as PyrxError {
                Self.reject(rejecter, error)
            } catch {
                rejecter("internal_error", error.localizedDescription, error)
            }
        }
    }

    // MARK: - Events

    @objc public func track(
        eventName: String,
        propertiesJson: String?,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let properties = PyrxSynapseImplHelpers.parseJSONValueObject(propertiesJson)
        Task {
            do {
                try await wrapper.track(eventName: eventName, properties: properties)
                resolver(NSNull())
            } catch let error as PyrxError {
                Self.reject(rejecter, error)
            } catch {
                rejecter("internal_error", error.localizedDescription, error)
            }
        }
    }

    @objc public func screen(
        screenName: String,
        propertiesJson: String?,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let properties = PyrxSynapseImplHelpers.parseJSONValueObject(propertiesJson)
        Task {
            do {
                try await wrapper.screen(screenName: screenName, properties: properties)
                resolver(NSNull())
            } catch let error as PyrxError {
                Self.reject(rejecter, error)
            } catch {
                rejecter("internal_error", error.localizedDescription, error)
            }
        }
    }

    // MARK: - Push

    @objc public func requestPushPermission(
        alert: Bool,
        sound: Bool,
        badge: Bool,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let options = PyrxSynapseImplHelpers.authorizationOptions(
            alert: alert, sound: sound, badge: badge
        )
        Task {
            // Pyrx.requestPushPermission is non-throwing — any OS error
            // is mapped to .notDetermined internally, see PushPermission.swift.
            let status = await wrapper.requestPushPermission(options: options)
            resolver(PyrxSynapseImplHelpers.statusString(status))
        }
    }

    @objc public func getPushPermissionStatus(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        // Pyrx does not surface a dedicated "current status" getter — we
        // read UNUserNotificationCenter directly. This is what the SDK's
        // own PushPermission does on a pre-request peek and matches the
        // OS source of truth.
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            let status = PushPermissionStatus(from: settings.authorizationStatus)
            resolver(PyrxSynapseImplHelpers.statusString(status))
        }
    }

    // MARK: - Privacy

    @objc public func setTrackingEnabled(
        enabled: Bool,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        Task {
            await wrapper.setTrackingEnabled(enabled)
            resolver(NSNull())
        }
    }

    @objc public func deleteUser(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        Task {
            do {
                try await wrapper.deleteUser()
                resolver(NSNull())
            } catch let error as PyrxError {
                Self.reject(rejecter, error)
            } catch {
                rejecter("internal_error", error.localizedDescription, error)
            }
        }
    }

    // MARK: - NativeEventEmitter symmetry

    @objc public func addListener(eventType: String) {
        listenerCount += 1
    }

    @objc public func removeListeners(count: Int) {
        listenerCount = max(0, listenerCount - count)
    }

    /// Test-only accessor for the listener counter. Internal because
    /// production callers never need this.
    internal var currentListenerCount: Int { listenerCount }

    // MARK: - Helpers

    /// React-typed wrapper around `PyrxSynapseImplHelpers.mapErrorToContract`.
    /// Kept here (not in the helpers file) because the
    /// `RCTPromiseRejectBlock` typedef belongs to React and would force
    /// the helpers file to import React — defeating the purpose of the
    /// split.
    private static func reject(_ rejecter: RCTPromiseRejectBlock, _ error: PyrxError) {
        let (code, message) = PyrxSynapseImplHelpers.mapErrorToContract(error)
        rejecter(code, message, error)
    }
}
