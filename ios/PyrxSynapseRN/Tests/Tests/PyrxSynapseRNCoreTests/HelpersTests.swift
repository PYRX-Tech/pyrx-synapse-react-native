/*
 * HelpersTests.swift
 * Tests for the non-marshalling helpers in `PyrxSynapseImplHelpers`:
 *   - PyrxError → (code, message) contract mapping
 *   - PushPermissionStatus → JS string mapping
 *   - IdentityResult → dict mapping
 *
 * These are the JS-facing contracts customers rely on. A regression in
 * the error code mapping would silently change the SynapseError.code
 * value JS sees, breaking any switch-statement in customer code (and
 * any analytics dashboards aggregating by code). A regression in the
 * status mapping would do the same to push-permission UI.
 *
 * For the higher-level "did the bridge actually call wrapper.identify
 * with the marshalled args?" tests, see the Xcode test target in
 * .github/workflows/ci.yml's `ios-xctest` job — those require the
 * React framework and cannot run via SPM.
 */

import XCTest
@testable import PyrxSynapseRNCore
import PYRXSynapse

final class HelpersTests: XCTestCase {

    // MARK: - PyrxError → (code, message) contract

    func test_mapErrorToContract_notInitialized() {
        let (code, message) = PyrxSynapseImplHelpers.mapErrorToContract(.notInitialized)
        XCTAssertEqual(code, "not_initialized")
        XCTAssertEqual(message, "Pyrx.initialize() has not been called yet")
    }

    func test_mapErrorToContract_invalidConfig_carriesReason() {
        let (code, message) = PyrxSynapseImplHelpers.mapErrorToContract(
            .invalidConfig(reason: "workspaceId is not a UUID")
        )
        XCTAssertEqual(code, "invalid_argument")
        XCTAssertEqual(message, "workspaceId is not a UUID")
    }

    func test_mapErrorToContract_network_httpStatus() {
        // PyrxError.network wraps PyrxNetworkError (a typed sum, NOT an
        // arbitrary Error). httpStatus carries the response code which
        // the customer's JS layer can use to decide between retry /
        // surface error / re-auth.
        let (code, message) = PyrxSynapseImplHelpers.mapErrorToContract(
            .network(.httpStatus(statusCode: 503, body: Data()))
        )
        XCTAssertEqual(code, "network_error")
        XCTAssertTrue(
            message.contains("503"),
            "message should embed status code; got: \(message)"
        )
    }

    func test_mapErrorToContract_network_invalidResponse() {
        let (code, message) = PyrxSynapseImplHelpers.mapErrorToContract(
            .network(.invalidResponse)
        )
        XCTAssertEqual(code, "network_error")
        XCTAssertFalse(message.isEmpty)
    }

    func test_mapErrorToContract_keychainFailure_carriesStatusAndOperation() {
        // PyrxError.keychainFailure has (status: Int32, operation: String).
        // The mapper must surface BOTH in the message so customer bug
        // reports include the actionable OSStatus + which Keychain op
        // failed. The original bridge code discarded both — fixed as a
        // bridge bug caught by these tests.
        let (code, message) = PyrxSynapseImplHelpers.mapErrorToContract(
            .keychainFailure(status: -25300, operation: "set")
        )
        XCTAssertEqual(code, "internal_error")
        XCTAssertTrue(message.contains("set"), "message should name the op; got: \(message)")
        XCTAssertTrue(message.contains("-25300"), "message should include OSStatus; got: \(message)")
    }

    func test_mapErrorToContract_alreadyInitialized_isInvalidArgument() {
        // Surfaced only when initialize is called twice with differing
        // configs — treating it as invalid_argument lets JS callers
        // surface a clean "you can't change config after init" error.
        let (code, message) = PyrxSynapseImplHelpers.mapErrorToContract(.alreadyInitialized)
        XCTAssertEqual(code, "invalid_argument")
        XCTAssertEqual(message, "initialize already called with a different config")
    }

    // MARK: - PushPermissionStatus → JS string

    func test_statusString_authorizedCollapsesToGranted() {
        // "granted" is the cross-platform consumer-facing term; "authorized"
        // is iOS-internal vocabulary. The JS contract uses "granted".
        XCTAssertEqual(PyrxSynapseImplHelpers.statusString(.authorized), "granted")
    }

    func test_statusString_denied() {
        XCTAssertEqual(PyrxSynapseImplHelpers.statusString(.denied), "denied")
    }

    func test_statusString_provisional_iOSOnly() {
        XCTAssertEqual(PyrxSynapseImplHelpers.statusString(.provisional), "provisional")
    }

    func test_statusString_notDetermined() {
        XCTAssertEqual(PyrxSynapseImplHelpers.statusString(.notDetermined), "notDetermined")
    }

    func test_statusString_ephemeralCollapsesToGranted() {
        // App-clip "delivers until clip dismissed" is functionally
        // granted from the customer's perspective; the JS contract
        // doesn't distinguish.
        XCTAssertEqual(PyrxSynapseImplHelpers.statusString(.ephemeral), "granted")
    }

    // MARK: - IdentityResult → dict (JS-side `SynapseIdentifyResult`)

    func test_identityResultDict_includesAllFields_minimal() {
        let result = IdentityResult(
            contactId: UUID(uuidString: "550e8400-e29b-41d4-a716-446655440000")!,
            path: .firstSighting,
            aliasedExternalId: nil,
            eventsReattributed: 0,
            devicesReattributed: 0,
            anonymousContactTombstoned: false
        )
        let dict = PyrxSynapseImplHelpers.identityResultDict(result)

        XCTAssertEqual(dict["contactId"] as? String, "550e8400-e29b-41d4-a716-446655440000")
        XCTAssertEqual(dict["path"] as? String, "first_sighting")
        XCTAssertTrue(dict["aliasedExternalId"] is NSNull, "nil should map to NSNull")
        XCTAssertEqual(dict["eventsReattributed"] as? Int, 0)
        XCTAssertEqual(dict["devicesReattributed"] as? Int, 0)
        XCTAssertEqual(dict["anonymousContactTombstoned"] as? Bool, false)
    }

    func test_identityResultDict_includesAllFields_populated() {
        let result = IdentityResult(
            contactId: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!,
            path: .knownExists,
            aliasedExternalId: "old-external-id",
            eventsReattributed: 42,
            devicesReattributed: 3,
            anonymousContactTombstoned: true
        )
        let dict = PyrxSynapseImplHelpers.identityResultDict(result)

        XCTAssertEqual(dict["contactId"] as? String, "11111111-2222-3333-4444-555555555555")
        XCTAssertEqual(dict["path"] as? String, "known_exists")
        XCTAssertEqual(dict["aliasedExternalId"] as? String, "old-external-id")
        XCTAssertEqual(dict["eventsReattributed"] as? Int, 42)
        XCTAssertEqual(dict["devicesReattributed"] as? Int, 3)
        XCTAssertEqual(dict["anonymousContactTombstoned"] as? Bool, true)
    }

    func test_identityResultDict_lowercasesUUID() {
        // Foundation's UUID.uuidString returns uppercase by default;
        // the SDK contract and dashboard expectation is lowercase
        // (matches Postgres `gen_random_uuid()` output).
        let result = IdentityResult(
            contactId: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!,
            path: .noAnonymous,
            aliasedExternalId: nil,
            eventsReattributed: 0,
            devicesReattributed: 0,
            anonymousContactTombstoned: false
        )
        let dict = PyrxSynapseImplHelpers.identityResultDict(result)
        let id = dict["contactId"] as? String
        XCTAssertEqual(id, id?.lowercased())
        XCTAssertEqual(id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    }

    func test_identityResultDict_path_noAnonymous() {
        let result = IdentityResult(
            contactId: UUID(),
            path: .noAnonymous,
            aliasedExternalId: nil,
            eventsReattributed: 0,
            devicesReattributed: 0,
            anonymousContactTombstoned: false
        )
        let dict = PyrxSynapseImplHelpers.identityResultDict(result)
        XCTAssertEqual(dict["path"] as? String, "no_anonymous")
    }
}
