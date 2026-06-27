/*
 * PyrxSynapseImplHelpers.swift
 * @pyrx/synapse-react-native — pure helpers extracted from
 * PyrxSynapseImpl.swift.
 *
 * Why this is a separate file
 * ---------------------------
 * Every function here is pure (no `Pyrx.shared`, no React, no async).
 * They map between JS-side types (`NSString`, `NSDictionary`,
 * `JSON-encoded strings`) and SDK-side types (`[String: JSONValue]`,
 * `IdentityResult`, `PushPermissionStatus`, `PyrxError`).
 *
 * Splitting them out:
 *   1. Lets the test target import + exercise them WITHOUT pulling in
 *      `React` / `RCTPromiseRejectBlock` (those need the RN pod chain).
 *      The test target's `import` becomes just `import PYRXSynapse` —
 *      the published Pod that ships via SPM, no Xcode workspace
 *      required.
 *   2. Keeps `PyrxSynapseImpl.swift` focused on bridge orchestration
 *      (validate JS args → invoke wrapper → resolve promise) without
 *      the marshalling noise.
 *
 * What's intentionally NOT here
 * ----------------------------
 * - `reject(_:_:)` — needs `RCTPromiseRejectBlock`, which is a React
 *   typedef. The pure analogue `mapErrorToContract(_:)` IS here; it
 *   returns the `(code, message)` pair so the React-dependent shim
 *   can construct the rejecter call.
 * - Anything that touches `Pyrx.shared` — by definition not pure.
 */

import Foundation
import PYRXSynapse
import UserNotifications

/// Pure helpers for `PyrxSynapseImpl`. All `static`; this enum exists
/// solely as a namespace — no instances are ever constructed.
public enum PyrxSynapseImplHelpers {

    // MARK: - JSON ↔ JSONValue

    /// Parse a JSON-encoded object payload from JS into the
    /// `[String: JSONValue]?` shape the SDK accepts for traits /
    /// properties. Returns nil for nil / empty / invalid input — the SDK
    /// treats nil identically to "no traits".
    ///
    /// `JSONValue` is the SDK's strongly-typed payload sum (Null / Bool /
    /// Int / Double / String / Array / Object), so we walk the loose
    /// `Any` shape JSONSerialization gives us and tag each leaf.
    public static func parseJSONValueObject(_ raw: String?) -> [String: JSONValue]? {
        guard let raw, !raw.isEmpty, let data = raw.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data),
              let dict = any as? [String: Any] else {
            return nil
        }
        return dict.mapValues { toJSONValue($0) }
    }

    /// Lift an opaque `Any` into the SDK's `JSONValue` sum. Unsupported
    /// kinds (eg Date) round-trip through `String(describing:)` rather
    /// than silently dropping — the alternative ("nil") loses data.
    ///
    /// JSONSerialization returns every numeric as `NSNumber`, so we check
    /// it specifically and use `CFNumber` introspection to split the
    /// bool / int / double bucket the underlying `JSONValue` cases
    /// require.
    public static func toJSONValue(_ value: Any) -> JSONValue {
        if value is NSNull { return .null }
        if let v = value as? String { return .string(v) }
        if let v = value as? [Any] { return .array(v.map(toJSONValue)) }
        if let v = value as? [String: Any] { return .object(v.mapValues(toJSONValue)) }
        // NSNumber: cover Bool first (kCFBooleanType is a special class),
        // then the integer/floating split. JSONValue.int is Int64.
        if let n = value as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            if CFNumberIsFloatType(n) { return .double(n.doubleValue) }
            return .int(n.int64Value)
        }
        return .string(String(describing: value))
    }

    // MARK: - IdentityResult → JS dict

    /// Convert an IdentityResult to the JS dict shape declared in
    /// `NativePyrxSynapse.ts::SynapseIdentifyResult`.
    public static func identityResultDict(_ result: IdentityResult) -> [String: Any] {
        return [
            "contactId": result.contactId.uuidString.lowercased(),
            "path": result.path.rawValue,
            "aliasedExternalId": result.aliasedExternalId as Any? ?? NSNull(),
            "eventsReattributed": result.eventsReattributed,
            "devicesReattributed": result.devicesReattributed,
            "anonymousContactTombstoned": result.anonymousContactTombstoned,
        ]
    }

    // MARK: - PushPermissionStatus → JS string

    /// Map `PushPermissionStatus` (SDK enum) to the JS-side string
    /// contract. `.authorized` collapses to "granted" because that's the
    /// term the docs and dashboards use across platforms; `.ephemeral`
    /// (iOS App Clips) collapses to "granted" too — the JS contract
    /// doesn't distinguish, and from the app's perspective the OS will
    /// deliver until the clip is dismissed.
    public static func statusString(_ status: PushPermissionStatus) -> String {
        switch status {
        case .authorized:    return "granted"
        case .denied:        return "denied"
        case .provisional:   return "provisional"
        case .notDetermined: return "notDetermined"
        case .ephemeral:     return "granted"
        }
    }

    // MARK: - LogLevel parsing

    /// Parse the JS-side log-level string into the SDK enum. Returns
    /// `nil` for unrecognised inputs so the caller can produce a typed
    /// `invalid_argument` rejection.
    ///
    /// Note: `LogLevel.none` is fully qualified inside the switch.
    /// Without the qualification, `.none` is ambiguous with
    /// `Optional<LogLevel>.none` (the return type's nil-marker) and
    /// the compiler silently chose Optional, mapping the JS "none"
    /// string to nil — i.e. the "invalid log level" path instead of
    /// the "no logging" path. Discovered while wiring the SPM-based
    /// helper tests; bridge bug fix.
    public static func parseLogLevel(_ raw: String) -> LogLevel? {
        switch raw {
        case "debug":   return .debug
        case "info":    return .info
        case "warning": return .warning
        case "error":   return .error
        case "none":    return LogLevel.none
        default:        return nil
        }
    }

    // MARK: - PushPermissionOptions assembly

    /// Build `UNAuthorizationOptions` from the three JS boolean flags.
    /// Mirrors the iOS SDK's `requestPushPermission` default-on shape.
    public static func authorizationOptions(
        alert: Bool, sound: Bool, badge: Bool
    ) -> UNAuthorizationOptions {
        var options: UNAuthorizationOptions = []
        if alert { options.insert(.alert) }
        if sound { options.insert(.sound) }
        if badge { options.insert(.badge) }
        return options
    }

    // MARK: - Error → JS contract mapping

    /// Map a typed `PyrxError` to the JS-visible `(code, message)` pair
    /// documented in `NativePyrxSynapse.ts`. The React-dependent shim in
    /// `PyrxSynapseImpl` wraps this and calls `RCTPromiseRejectBlock`
    /// with the result + the original `error` as the underlying cause.
    public static func mapErrorToContract(_ error: PyrxError) -> (code: String, message: String) {
        switch error {
        case .notInitialized:
            return ("not_initialized", "Pyrx.initialize() has not been called yet")
        case .invalidConfig(let reason):
            return ("invalid_argument", reason)
        case .network(let underlying):
            return ("network_error", "\(underlying)")
        case .keychainFailure(let status, let operation):
            // PyrxError.keychainFailure carries (status: Int32, operation:
            // String). Surface them in the message so customer bug
            // reports include the actionable OSStatus value — Apple
            // documents the codes at https://developer.apple.com/documentation/security/1542001-security_framework_result_codes.
            return ("internal_error", "keychain \(operation) failed (OSStatus \(status))")
        case .alreadyInitialized:
            // Treated as invalid_argument because the only way it surfaces
            // is the caller passing a config that differs from a prior call.
            return ("invalid_argument", "initialize already called with a different config")
        }
        // No default: `PyrxError` is closed (not @frozen but effectively
        // sealed by the package). If the SDK adds a case in a future
        // release, this switch becomes non-exhaustive at compile time
        // and CI catches the regression — preferable to a silent
        // "internal_error" fallback that hides new failure modes.
    }
}
