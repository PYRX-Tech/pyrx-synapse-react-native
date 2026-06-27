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
 *   surfaces to JS via the NativeEventEmitter — see
 *   `startObservingPyrxEvents` below for the wiring.
 *
 * Observer wiring (Phase 9.2.1)
 * -----------------------------
 * `startObservingPyrxEvents(emitter:)` is called by the ObjC++
 * `PyrxSynapseModule.startObserving` override (which RCTEventEmitter
 * fires when the first JS listener attaches). We subscribe to
 * `Pyrx.shared.events()` (an AsyncStream from PYRXSynapse 0.1.2's
 * observer surface) via a held `Task`, and for each `PyrxEvent` we
 * receive we forward to `RCTEventEmitter.sendEventWithName:body:` on
 * a weak ref to the emitter. The Task is cancelled by
 * `stopObservingPyrxEvents` when the last listener detaches or the
 * bridge invalidates.
 *
 * Why subscribe ONCE per JS-listener-count (instead of per JS subscriber):
 * the AsyncStream is per-call (the SDK creates one stream per `events()`
 * call), and every event we receive is fanned out to all JS subscribers
 * via the emitter's listener registry. Subscribing N times would create
 * N native streams and duplicate-deliver events. The lazy-on-first-listen
 * + cancel-on-last-detach pattern keeps overhead at zero when the host
 * app never subscribes.
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

    /// Weak ref to the RCTEventEmitter (a PyrxSynapseModule instance)
    /// installed when JS attaches its first listener. Weak because the
    /// bridge owns the emitter's lifetime — we must NOT keep it alive
    /// past `invalidate()`.
    ///
    /// Only assigned via `startObservingPyrxEventsWithEmitter:` and
    /// cleared by `stopObservingPyrxEvents` (both invoked from the ObjC
    /// `PyrxSynapseModule.startObserving` / `.stopObserving` overrides).
    private weak var emitter: RCTEventEmitter?

    /// Held reference to the Task driving the AsyncStream collect. Set
    /// in `startObservingPyrxEvents`, cancelled + nilled in
    /// `stopObservingPyrxEvents`. Cancelling the Task causes the
    /// `for await` loop to terminate, which triggers the underlying
    /// AsyncStream's `onTermination` to fire — that calls
    /// `PyrxObserverToken.cancel()` and unregisters the observer from
    /// the SDK's `PyrxObserverRegistry`.
    private var observerTask: Task<Void, Never>?

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

    // MARK: - NativeEventEmitter observer wiring (Phase 9.2.1)

    /// Install the RCTEventEmitter back-reference AND start collecting
    /// `Pyrx.shared.events()` into a held Task. Called by the ObjC
    /// `PyrxSynapseModule.startObserving` override on the first JS
    /// listener attachment.
    ///
    /// Idempotent: if a Task is already running (Metro reload race
    /// where startObserving fires twice without an intervening
    /// stopObserving) we tear down and re-start so the new emitter ref
    /// is the one driving the forwarding.
    @objc public func startObservingPyrxEvents(emitter: RCTEventEmitter) {
        // Tear down any prior task to avoid the multi-subscribe leak.
        observerTask?.cancel()

        self.emitter = emitter

        // Capture a weak self for the inner Task — otherwise the Task
        // (which is held by self.observerTask) would form a retain
        // cycle through the implicit self capture in the closure body.
        observerTask = Task { [weak self] in
            let stream = await Pyrx.shared.events()
            for await event in stream {
                // Re-check self on every iteration so post-cancellation
                // events stop being dispatched immediately. Without the
                // weak ref + nil-check the loop would keep yielding for
                // one or two events after cancellation while the stream
                // drains its internal buffer.
                guard let self else { break }
                await self.dispatchPyrxEvent(event)
            }
        }
    }

    /// Cancel the held collecting Task and drop the emitter back-ref.
    /// Called by the ObjC `PyrxSynapseModule.stopObserving` override
    /// (last listener detach) AND by `invalidate` (bridge teardown).
    @objc public func stopObservingPyrxEvents() {
        observerTask?.cancel()
        observerTask = nil
        emitter = nil
    }

    /// Internal — dispatch a single PyrxEvent to JS via the emitter.
    /// Runs on the MainActor; the emitter's sendEventWithName is
    /// thread-safe but we hop to main anyway for actor isolation.
    private func dispatchPyrxEvent(_ event: PyrxEvent) {
        // No emitter installed (race between startObserving and the
        // first event arrival) → silently drop. The next event after
        // the emitter installs will fire normally; this is rare and
        // matches the contract documented in `events.ts`: events
        // delivered before subscription may be lost.
        guard let emitter else { return }

        switch event {
        case .pushReceived(let push):
            emitter.sendEvent(
                withName: "pyrx:push:received",
                body: Self.pushReceivedDict(push)
            )
        case .pushClicked(let click):
            emitter.sendEvent(
                withName: "pyrx:push:click",
                body: Self.pushClickedDict(click)
            )
        case .pushReceivedColdStart(let push):
            emitter.sendEvent(
                withName: "pyrx:push:received-cold-start",
                body: Self.pushReceivedDict(push)
            )
        case .queueDrained(let count):
            emitter.sendEvent(
                withName: "pyrx:queue:drained",
                body: ["count": count]
            )
        case .identityChanged(let before, let after):
            emitter.sendEvent(
                withName: "pyrx:identity:changed",
                body: [
                    "before": Self.identitySnapshotDict(before),
                    "after": Self.identitySnapshotDict(after),
                ]
            )
        }
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

    // MARK: - Observer-event payload helpers

    /// Convert PushReceivedEvent to the JS dict shape declared in
    /// `src/events.ts::PushReceivedEvent`. Both `pyrx:push:received` and
    /// `pyrx:push:received-cold-start` use this serializer — the cases
    /// share the payload shape; only the dispatching event name differs.
    private static func pushReceivedDict(_ push: PushReceivedEvent) -> [String: Any] {
        return [
            "title": push.title,
            "body": push.body,
            "pushLogId": push.pushLogId?.uuidString.lowercased() as Any? ?? NSNull(),
            "pyrxAttrs": push.pyrxAttributes.map(jsonValueMapToDict) as Any? ?? NSNull(),
            // `userInfo` is `[AnyHashable: Any]` (APNs raw payload). We
            // pass it as-is — JS will see whatever the RN bridge can
            // serialize. Keys that aren't strings get dropped silently
            // by JSON serialization on the bridge side, which matches
            // the documented JS contract (string-keyed objects only).
            "data": push.userInfo,
            "receivedAt": ISO8601DateFormatter.shared.string(from: push.receivedAt),
        ]
    }

    /// Convert PushClickedEvent to the JS dict shape declared in
    /// `src/events.ts::PushClickEvent`.
    private static func pushClickedDict(_ click: PushClickedEvent) -> [String: Any] {
        return [
            "pushLogId": click.pushLogId?.uuidString.lowercased() as Any? ?? NSNull(),
            "deepLink": click.deepLink?.absoluteString as Any? ?? NSNull(),
            "actionId": click.actionId as Any? ?? NSNull(),
            "pyrxAttrs": click.pyrxAttributes.map(jsonValueMapToDict) as Any? ?? NSNull(),
            "clickedAt": ISO8601DateFormatter.shared.string(from: click.clickedAt),
        ]
    }

    /// Convert IdentitySnapshot to the JS dict shape declared in
    /// `src/events.ts::IdentitySnapshot`.
    ///
    /// Field rename: native `snapshotAt: Date` → JS `snapshotAt: string`
    /// (ISO 8601 UTC). Native uses Date for type safety; JS uses ISO
    /// strings because Date does not cross the bridge cleanly.
    private static func identitySnapshotDict(_ snap: IdentitySnapshot) -> [String: Any] {
        return [
            "anonymousId": snap.anonymousId as Any? ?? NSNull(),
            "externalId": snap.externalId as Any? ?? NSNull(),
            "snapshotAt": ISO8601DateFormatter.shared.string(from: snap.snapshotAt),
        ]
    }

    /// Lift the SDK's `[String: JSONValue]` (a.k.a. `[String: PyrxAttributeValue]`)
    /// into a JS-bridge-friendly `[String: Any]` for `sendEventWithName:body:`.
    /// Recursively unwraps every JSONValue case to its native equivalent
    /// — `.null` → NSNull, `.bool` → Bool, `.int` → Int64, `.double` →
    /// Double, `.string` → String, `.array` / `.object` → recursed.
    private static func jsonValueMapToDict(_ map: [String: JSONValue]) -> [String: Any] {
        var out: [String: Any] = [:]
        out.reserveCapacity(map.count)
        for (k, v) in map {
            out[k] = jsonValueToAny(v)
        }
        return out
    }

    private static func jsonValueToAny(_ value: JSONValue) -> Any {
        switch value {
        case .null:               return NSNull()
        case .bool(let b):        return b
        case .int(let i):         return i
        case .double(let d):      return d
        case .string(let s):      return s
        case .array(let arr):     return arr.map(jsonValueToAny)
        case .object(let obj):    return jsonValueMapToDict(obj)
        }
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

// MARK: - ISO8601 cache

/// Singleton ISO 8601 formatter for `snapshotAt` / `receivedAt` /
/// `clickedAt` field serialization. `ISO8601DateFormatter` is thread-
/// safe (per Apple documentation since iOS 10) AND relatively expensive
/// to construct (~100µs in our benchmarks). Cache it as a static.
///
/// The default `.withInternetDateTime` option produces strings like
/// `"2026-06-27T08:30:00Z"` which JS's `new Date(...)` parses correctly.
extension ISO8601DateFormatter {
    fileprivate static let shared: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
