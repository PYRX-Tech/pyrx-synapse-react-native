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
 *     Swift-typed inputs the `Pyrx` actor expects.
 *   - Hops into `Pyrx.shared`'s actor isolation via `Task { await … }`,
 *     then resolves or rejects the RN promise from the result.
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
 *   wired by `PyrxSynapseAppDelegate.swift`; the resulting telemetry
 *   surfaces to JS via the NativeEventEmitter (PR-2).
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

    /// Track outstanding listener count so we can stop emitting / clean
    /// up if a future event source needs to know nobody is listening.
    /// Today the count is bookkeeping-only; we still increment/decrement
    /// because RN requires the protocol methods to exist.
    private var listenerCount: Int = 0

    private override init() {
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

        let logLevel: LogLevel
        switch (config["logLevel"] as? String) ?? "info" {
        case "debug":   logLevel = .debug
        case "info":    logLevel = .info
        case "warning": logLevel = .warning
        case "error":   logLevel = .error
        case "none":    logLevel = .none
        default:        logLevel = .info
        }

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
                try await Pyrx.shared.initialize(config: pyrxConfig)
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
        let parsed: LogLevel
        switch level {
        case "debug":   parsed = .debug
        case "info":    parsed = .info
        case "warning": parsed = .warning
        case "error":   parsed = .error
        case "none":    parsed = .none
        default:
            rejecter("invalid_argument",
                     "logLevel must be one of debug|info|warning|error|none (got '\(level)')",
                     nil)
            return
        }
        // setLogLevel on the Pyrx actor is async (actor isolation) but
        // not throws — hop into the actor's context, then resolve.
        Task {
            await Pyrx.shared.setLogLevel(parsed)
            resolver(NSNull())
        }
    }

    @objc public func debugInfo(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        Task {
            let info = await Pyrx.shared.debugInfo()
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
        let traits = Self.parseJSONValueObject(traitsJson)
        Task {
            do {
                let result = try await Pyrx.shared.identify(
                    externalId: externalId,
                    traits: traits
                )
                resolver(Self.identityResultDict(result))
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
                let result = try await Pyrx.shared.alias(newExternalId: newExternalId)
                resolver(Self.identityResultDict(result))
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
                try await Pyrx.shared.logout()
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
        let properties = Self.parseJSONValueObject(propertiesJson)
        Task {
            do {
                try await Pyrx.shared.track(eventName: eventName, properties: properties)
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
        let properties = Self.parseJSONValueObject(propertiesJson)
        Task {
            do {
                try await Pyrx.shared.screen(screenName: screenName, properties: properties)
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
        var options: UNAuthorizationOptions = []
        if alert { options.insert(.alert) }
        if sound { options.insert(.sound) }
        if badge { options.insert(.badge) }
        Task {
            // Pyrx.requestPushPermission is non-throwing — any OS error
            // is mapped to .notDetermined internally, see PushPermission.swift.
            let status = await Pyrx.shared.requestPushPermission(options: options)
            resolver(Self.statusString(status))
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
            resolver(Self.statusString(status))
        }
    }

    // MARK: - Privacy

    @objc public func setTrackingEnabled(
        enabled: Bool,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        Task {
            await Pyrx.shared.setTrackingEnabled(enabled)
            resolver(NSNull())
        }
    }

    @objc public func deleteUser(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        Task {
            do {
                try await Pyrx.shared.deleteUser()
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

    // MARK: - Helpers

    /// Convert an IdentityResult to the JS dict shape declared in
    /// `NativePyrxSynapse.ts::SynapseIdentifyResult`.
    private static func identityResultDict(_ result: IdentityResult) -> [String: Any] {
        return [
            "contactId": result.contactId.uuidString.lowercased(),
            "path": result.path.rawValue,
            "aliasedExternalId": result.aliasedExternalId as Any? ?? NSNull(),
            "eventsReattributed": result.eventsReattributed,
            "devicesReattributed": result.devicesReattributed,
            "anonymousContactTombstoned": result.anonymousContactTombstoned,
        ]
    }

    /// Parse a JSON-encoded object payload from JS into the
    /// `[String: JSONValue]?` shape the Pyrx actor accepts for traits /
    /// properties. Returns nil for nil / empty / invalid input — the SDK
    /// treats nil identically to "no traits".
    ///
    /// `JSONValue` is the SDK's strongly-typed payload sum (Null / Bool /
    /// Int / Double / String / Array / Object), so we walk the loose
    /// `Any` shape JSONSerialization gives us and tag each leaf.
    private static func parseJSONValueObject(_ raw: String?) -> [String: JSONValue]? {
        guard let raw, !raw.isEmpty, let data = raw.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data),
              let dict = any as? [String: Any] else {
            return nil
        }
        return dict.mapValues { Self.toJSONValue($0) }
    }

    /// Lift an opaque `Any` into the SDK's `JSONValue` sum. Unsupported
    /// kinds (eg Date) round-trip through `String(describing:)` rather
    /// than silently dropping — the alternative ("nil") loses data.
    ///
    /// JSONSerialization returns every numeric as `NSNumber`, so we check
    /// it specifically and use `CFNumber` introspection to split the
    /// bool / int / double bucket the underlying `JSONValue` cases
    /// require.
    private static func toJSONValue(_ value: Any) -> JSONValue {
        if value is NSNull { return .null }
        if let v = value as? String { return .string(v) }
        if let v = value as? [Any] { return .array(v.map(Self.toJSONValue)) }
        if let v = value as? [String: Any] { return .object(v.mapValues(Self.toJSONValue)) }
        // NSNumber: cover Bool first (kCFBooleanType is a special class),
        // then the integer/floating split. JSONValue.int is Int64.
        if let n = value as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            if CFNumberIsFloatType(n) { return .double(n.doubleValue) }
            return .int(n.int64Value)
        }
        return .string(String(describing: value))
    }

    /// Map a `PyrxError` to the JS-visible error contract documented in
    /// `NativePyrxSynapse.ts`.
    private static func reject(_ rejecter: RCTPromiseRejectBlock, _ error: PyrxError) {
        let code: String
        let message: String
        switch error {
        case .notInitialized:
            code = "not_initialized"
            message = "Pyrx.initialize() has not been called yet"
        case .invalidConfig(let reason):
            code = "invalid_argument"
            message = reason
        case .network(let underlying):
            code = "network_error"
            message = "\(underlying)"
        case .keychainFailure:
            code = "internal_error"
            message = "keychain access failed"
        case .alreadyInitialized:
            // Treated as invalid_argument because the only way it surfaces
            // is the caller passing a config that differs from a prior call.
            code = "invalid_argument"
            message = "initialize already called with a different config"
        default:
            code = "internal_error"
            message = error.localizedDescription
        }
        rejecter(code, message, error)
    }

    /// Map `PushPermissionStatus` (SDK enum) to the JS-side string
    /// contract. `.authorized` collapses to "granted" because that's the
    /// term the docs and dashboards use across platforms; `.ephemeral`
    /// (iOS App Clips) collapses to "granted" too — the JS contract
    /// doesn't distinguish, and from the app's perspective the OS will
    /// deliver until the clip is dismissed.
    private static func statusString(_ status: PushPermissionStatus) -> String {
        switch status {
        case .authorized:    return "granted"
        case .denied:        return "denied"
        case .provisional:   return "provisional"
        case .notDetermined: return "notDetermined"
        case .ephemeral:     return "granted"
        }
    }
}
