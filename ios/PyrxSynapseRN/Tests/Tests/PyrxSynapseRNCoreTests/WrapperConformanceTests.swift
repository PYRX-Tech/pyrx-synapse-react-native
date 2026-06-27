/*
 * WrapperConformanceTests.swift
 * Tests that `ProductionPyrxWrapper` correctly conforms to `PyrxWrapper`
 * and that a test-side mock can satisfy the same protocol.
 *
 * These are primarily compile-time assertions promoted to runtime by
 * XCTest. The intent is to lock the wrapper protocol shape against
 * accidental drift — if someone adds a method to `PyrxSynapseImpl` that
 * forwards to `Pyrx.shared` but forgets to add it to `PyrxWrapper`, the
 * production code will compile (because they used `Pyrx.shared`
 * directly, skipping the wrapper) and tests will be unable to mock it.
 * This file is the "did the protocol grow?" canary.
 *
 * NOTE: We cannot construct ProductionPyrxWrapper().identify(...) etc.
 * here because that would actually call Pyrx.shared and touch Keychain
 * + the network. The tests below verify the protocol shape via type
 * coercion + the mock's method recording, not by invoking production
 * forwarders.
 */

import XCTest
@testable import PyrxSynapseRNCore
import PYRXSynapse
import UserNotifications

/// Mock `PyrxWrapper` that records every call. Tests assert on
/// `recordedCalls` to verify the bridge invoked the expected method
/// with the expected args. Each method that throws / returns can be
/// programmed to throw / return via the `*Throws` and `*Returns`
/// properties.
@MainActor
final class RecordingPyrxWrapper: PyrxWrapper {
    enum Call: Equatable {
        case initialize(workspaceId: String, apiKey: String, environment: String)
        case setLogLevel(LogLevel)
        case debugInfo
        case identify(externalId: String, hasTraits: Bool)
        case alias(newExternalId: String)
        case logout
        case track(eventName: String, hasProperties: Bool)
        case screen(screenName: String, hasProperties: Bool)
        case requestPushPermission(alert: Bool, sound: Bool, badge: Bool)
        case setTrackingEnabled(Bool)
        case deleteUser
    }

    var recordedCalls: [Call] = []

    /// If set, `initialize` (and only initialize) throws this error.
    var initializeThrows: Error?

    /// Returned by `debugInfo` and `identify`/`alias` calls when not throwing.
    var debugInfoReturns: PyrxDebugInfo = PyrxDebugInfo(
        initialized: false,
        anonymousId: nil,
        hasExternalId: false,
        hasDeviceToken: false,
        eventQueueDepth: 0,
        sdkVersion: "0.0.0",
        platform: "test",
        trackingEnabled: true
    )

    var identityResultReturns: IdentityResult = IdentityResult(
        contactId: UUID(),
        path: .firstSighting,
        aliasedExternalId: nil,
        eventsReattributed: 0,
        devicesReattributed: 0,
        anonymousContactTombstoned: false
    )

    var pushStatusReturns: PushPermissionStatus = .notDetermined

    func initialize(config: PyrxConfig) async throws {
        recordedCalls.append(
            .initialize(
                workspaceId: config.workspaceId.uuidString.lowercased(),
                apiKey: config.apiKey,
                environment: config.environment == .production ? "production" : "sandbox"
            )
        )
        if let err = initializeThrows { throw err }
    }

    func setLogLevel(_ level: LogLevel) async {
        recordedCalls.append(.setLogLevel(level))
    }

    func debugInfo() async -> PyrxDebugInfo {
        recordedCalls.append(.debugInfo)
        return debugInfoReturns
    }

    func identify(externalId: String, traits: [String: JSONValue]?) async throws -> IdentityResult {
        recordedCalls.append(.identify(externalId: externalId, hasTraits: traits != nil))
        return identityResultReturns
    }

    func alias(newExternalId: String) async throws -> IdentityResult {
        recordedCalls.append(.alias(newExternalId: newExternalId))
        return identityResultReturns
    }

    func logout() async throws {
        recordedCalls.append(.logout)
    }

    func track(eventName: String, properties: [String: JSONValue]?) async throws {
        recordedCalls.append(.track(eventName: eventName, hasProperties: properties != nil))
    }

    func screen(screenName: String, properties: [String: JSONValue]?) async throws {
        recordedCalls.append(.screen(screenName: screenName, hasProperties: properties != nil))
    }

    func requestPushPermission(options: UNAuthorizationOptions) async -> PushPermissionStatus {
        recordedCalls.append(.requestPushPermission(
            alert: options.contains(.alert),
            sound: options.contains(.sound),
            badge: options.contains(.badge)
        ))
        return pushStatusReturns
    }

    func setTrackingEnabled(_ enabled: Bool) async {
        recordedCalls.append(.setTrackingEnabled(enabled))
    }

    func deleteUser() async throws {
        recordedCalls.append(.deleteUser)
    }
}

@MainActor
final class WrapperConformanceTests: XCTestCase {

    func test_productionWrapper_conformsToProtocol() {
        // Just verifies the protocol-typed reference accepts the
        // production wrapper. Construction itself is harmless — the
        // wrapper does no work until a method is invoked.
        let prod: PyrxWrapper = ProductionPyrxWrapper()
        // Use the reference to keep the optimiser from eliding it.
        XCTAssertNotNil(prod as AnyObject)
    }

    func test_mockWrapper_recordsIdentifyCall() async throws {
        let mock = RecordingPyrxWrapper()
        _ = try await mock.identify(externalId: "u1", traits: nil)
        XCTAssertEqual(
            mock.recordedCalls,
            [.identify(externalId: "u1", hasTraits: false)]
        )
    }

    func test_mockWrapper_recordsTraitsPresence() async throws {
        let mock = RecordingPyrxWrapper()
        _ = try await mock.identify(
            externalId: "u1",
            traits: ["plan": .string("pro")]
        )
        XCTAssertEqual(
            mock.recordedCalls,
            [.identify(externalId: "u1", hasTraits: true)]
        )
    }

    func test_mockWrapper_recordsLogLevel() async {
        let mock = RecordingPyrxWrapper()
        await mock.setLogLevel(.debug)
        await mock.setLogLevel(.error)
        XCTAssertEqual(mock.recordedCalls, [.setLogLevel(.debug), .setLogLevel(.error)])
    }

    func test_mockWrapper_recordsPushPermissionFlags() async {
        let mock = RecordingPyrxWrapper()
        _ = await mock.requestPushPermission(options: [.alert, .sound])
        XCTAssertEqual(
            mock.recordedCalls,
            [.requestPushPermission(alert: true, sound: true, badge: false)]
        )
    }

    func test_mockWrapper_throwsOnDemand() async {
        let mock = RecordingPyrxWrapper()
        mock.initializeThrows = PyrxError.notInitialized
        let config = PyrxConfig(
            workspaceId: UUID(),
            apiKey: "psk_test_x",
            environment: .sandbox,
            sdkVariant: "rn"
        )
        do {
            try await mock.initialize(config: config)
            XCTFail("expected throw")
        } catch {
            // Verify the error type is what we set.
            guard let pyrxError = error as? PyrxError, case .notInitialized = pyrxError else {
                XCTFail("expected .notInitialized, got \(error)")
                return
            }
        }
    }

    func test_mockWrapper_recordsAllInitializeFields() async throws {
        let mock = RecordingPyrxWrapper()
        let ws = UUID()
        let config = PyrxConfig(
            workspaceId: ws,
            apiKey: "psk_live_abc",
            environment: .production,
            sdkVariant: "rn"
        )
        try await mock.initialize(config: config)
        XCTAssertEqual(
            mock.recordedCalls,
            [.initialize(
                workspaceId: ws.uuidString.lowercased(),
                apiKey: "psk_live_abc",
                environment: "production"
            )]
        )
    }
}
