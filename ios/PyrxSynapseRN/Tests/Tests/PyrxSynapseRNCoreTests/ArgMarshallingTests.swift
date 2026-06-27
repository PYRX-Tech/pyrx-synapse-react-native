/*
 * ArgMarshallingTests.swift
 * Tests for `PyrxSynapseImplHelpers` — the pure marshalling layer
 * between JS-side types (JSON strings, `Any` dictionaries, boolean
 * flags) and SDK-side types (`JSONValue`, `LogLevel`,
 * `UNAuthorizationOptions`).
 *
 * Why these tests matter
 * ----------------------
 * The bridge's correctness depends on round-tripping values cleanly
 * across the type boundary. A silent demotion (e.g. `Int64` flattened
 * to `Int`, `bool` mis-tagged as `int`, `null` collapsed to `0`) would
 * not surface as a compile error or runtime crash — it would just
 * produce a wrong value in the dashboard's contact properties.
 *
 * These tests exhaustively cover the edge cases discovered while
 * implementing the helpers:
 *   - `null` vs missing vs empty inputs (three distinct cases)
 *   - Bool vs Int discrimination (NSNumber's CFBooleanType trap)
 *   - Int64 boundary values (JSONValue.int is Int64; Swift Int may be
 *     32-bit on legacy platforms)
 *   - Unicode strings (CJK, RTL, emoji)
 *   - Nested objects and arrays
 *   - Malformed / non-object JSON inputs
 *   - Unsupported types (Date) — must round-trip via String(describing:),
 *     never silently drop
 */

import XCTest
@testable import PyrxSynapseRNCore
import PYRXSynapse

final class ArgMarshallingTests: XCTestCase {

    // MARK: - parseJSONValueObject — null/empty/invalid handling

    func test_parseJSONValueObject_returnsNil_forNilInput() {
        XCTAssertNil(PyrxSynapseImplHelpers.parseJSONValueObject(nil))
    }

    func test_parseJSONValueObject_returnsNil_forEmptyString() {
        XCTAssertNil(PyrxSynapseImplHelpers.parseJSONValueObject(""))
    }

    func test_parseJSONValueObject_returnsNil_forMalformedJSON() {
        XCTAssertNil(PyrxSynapseImplHelpers.parseJSONValueObject("{not json"))
    }

    func test_parseJSONValueObject_returnsNil_forArrayRoot() {
        // JS-side encodes `Record<string, V>`; an array root is a
        // misuse and should be rejected (returning nil = "treat as no
        // traits" per SDK contract).
        XCTAssertNil(PyrxSynapseImplHelpers.parseJSONValueObject("[1, 2, 3]"))
    }

    func test_parseJSONValueObject_returnsNil_forPrimitiveRoot() {
        XCTAssertNil(PyrxSynapseImplHelpers.parseJSONValueObject("\"just a string\""))
        XCTAssertNil(PyrxSynapseImplHelpers.parseJSONValueObject("42"))
        XCTAssertNil(PyrxSynapseImplHelpers.parseJSONValueObject("true"))
    }

    func test_parseJSONValueObject_returnsEmptyMap_forEmptyObject() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject("{}")
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.count, 0)
    }

    // MARK: - parseJSONValueObject — primitive value types

    func test_parseJSONValueObject_decodesString() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(#"{"name":"alice"}"#)
        XCTAssertEqual(result?["name"], .string("alice"))
    }

    func test_parseJSONValueObject_decodesEmptyString_distinctFromNull() {
        // JS callers commonly pass `""` for "user cleared the field" —
        // must NOT collapse to null. The wire sends an empty string.
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(#"{"middle_name":""}"#)
        XCTAssertEqual(result?["middle_name"], .string(""))
    }

    func test_parseJSONValueObject_decodesNull() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(#"{"deleted_at":null}"#)
        XCTAssertEqual(result?["deleted_at"], .null)
    }

    func test_parseJSONValueObject_decodesBoolTrue() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(#"{"is_admin":true}"#)
        XCTAssertEqual(result?["is_admin"], .bool(true))
    }

    func test_parseJSONValueObject_decodesBoolFalse() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(#"{"is_admin":false}"#)
        XCTAssertEqual(result?["is_admin"], .bool(false))
    }

    // MARK: - parseJSONValueObject — numeric edge cases

    func test_parseJSONValueObject_decodesPositiveInteger() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(#"{"count":42}"#)
        XCTAssertEqual(result?["count"], .int(42))
    }

    func test_parseJSONValueObject_decodesZero_asInt() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(#"{"n":0}"#)
        XCTAssertEqual(result?["n"], .int(0))
    }

    func test_parseJSONValueObject_decodesNegativeInteger() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(#"{"temp":-273}"#)
        XCTAssertEqual(result?["temp"], .int(-273))
    }

    func test_parseJSONValueObject_decodesInt64Max() {
        // JSON allows arbitrary precision; we cap at Int64.
        // Int64.max = 9223372036854775807
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(
            #"{"big":9223372036854775807}"#
        )
        XCTAssertEqual(result?["big"], .int(9223372036854775807))
    }

    func test_parseJSONValueObject_decodesDouble() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(#"{"pi":3.14159}"#)
        if case .double(let d) = result?["pi"] {
            XCTAssertEqual(d, 3.14159, accuracy: 0.00001)
        } else {
            XCTFail("Expected .double, got \(String(describing: result?["pi"]))")
        }
    }

    func test_parseJSONValueObject_decodesNegativeDouble() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(#"{"x":-0.5}"#)
        if case .double(let d) = result?["x"] {
            XCTAssertEqual(d, -0.5, accuracy: 0.001)
        } else {
            XCTFail("Expected .double")
        }
    }

    func test_parseJSONValueObject_doesNotConfuseBoolAndInt() {
        // The CFBooleanGetTypeID trap: NSNumber wraps both Bool and Int,
        // and without the CFType discrimination they'd be
        // indistinguishable. Worth a dedicated test because regressions
        // here would corrupt every boolean trait.
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(
            #"{"truthy":true,"one":1,"zero":0,"falsy":false}"#
        )
        XCTAssertEqual(result?["truthy"], .bool(true))
        XCTAssertEqual(result?["one"], .int(1))
        XCTAssertEqual(result?["zero"], .int(0))
        XCTAssertEqual(result?["falsy"], .bool(false))
    }

    // MARK: - parseJSONValueObject — unicode

    func test_parseJSONValueObject_decodesCJKString() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(
            #"{"city":"東京"}"#
        )
        XCTAssertEqual(result?["city"], .string("東京"))
    }

    func test_parseJSONValueObject_decodesEmojiString() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(
            #"{"status":"happy 🎉"}"#
        )
        XCTAssertEqual(result?["status"], .string("happy 🎉"))
    }

    func test_parseJSONValueObject_decodesRTLString() {
        // Arabic — right-to-left script. The encoding/decoding must
        // preserve byte order; visual rendering is the consumer's job.
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(
            #"{"name":"مرحبا"}"#
        )
        XCTAssertEqual(result?["name"], .string("مرحبا"))
    }

    // MARK: - parseJSONValueObject — nested structures

    func test_parseJSONValueObject_decodesNestedObject() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(
            #"{"profile":{"name":"alice","age":30}}"#
        )
        guard case .object(let nested) = result?["profile"] else {
            XCTFail("Expected .object")
            return
        }
        XCTAssertEqual(nested["name"], .string("alice"))
        XCTAssertEqual(nested["age"], .int(30))
    }

    func test_parseJSONValueObject_decodesArrayOfPrimitives() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(
            #"{"tags":["a","b","c"]}"#
        )
        guard case .array(let items) = result?["tags"] else {
            XCTFail("Expected .array")
            return
        }
        XCTAssertEqual(items, [.string("a"), .string("b"), .string("c")])
    }

    func test_parseJSONValueObject_decodesArrayOfMixedTypes() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(
            #"{"mixed":[1,"two",true,null]}"#
        )
        guard case .array(let items) = result?["mixed"] else {
            XCTFail("Expected .array")
            return
        }
        XCTAssertEqual(items.count, 4)
        XCTAssertEqual(items[0], .int(1))
        XCTAssertEqual(items[1], .string("two"))
        XCTAssertEqual(items[2], .bool(true))
        XCTAssertEqual(items[3], .null)
    }

    func test_parseJSONValueObject_decodesDeeplyNested() {
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(
            #"{"a":{"b":{"c":{"d":"deep"}}}}"#
        )
        guard case .object(let a) = result?["a"],
              case .object(let b) = a["b"],
              case .object(let c) = b["c"] else {
            XCTFail("Expected nested objects")
            return
        }
        XCTAssertEqual(c["d"], .string("deep"))
    }

    // MARK: - parseJSONValueObject — large payloads

    func test_parseJSONValueObject_decodesManyKeys() {
        // 100 keys; ensures the value-by-value mapping doesn't have
        // an O(n^2) blow-up or per-key allocation issue.
        var dict: [String: Int] = [:]
        for i in 0..<100 {
            dict["key_\(i)"] = i
        }
        let data = try! JSONSerialization.data(withJSONObject: dict)
        let json = String(data: data, encoding: .utf8)!
        let result = PyrxSynapseImplHelpers.parseJSONValueObject(json)
        XCTAssertEqual(result?.count, 100)
        XCTAssertEqual(result?["key_42"], .int(42))
    }

    // MARK: - toJSONValue — unsupported types fall through to String

    func test_toJSONValue_dateRoundsToString() {
        // JSON doesn't have a native Date; the helpers fall through
        // to `String(describing:)` rather than silently dropping.
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let value = PyrxSynapseImplHelpers.toJSONValue(date)
        guard case .string(let s) = value else {
            XCTFail("Expected .string")
            return
        }
        // Don't assert exact format; just that it didn't collapse to null.
        XCTAssertFalse(s.isEmpty)
    }

    // MARK: - parseLogLevel — every documented input

    func test_parseLogLevel_acceptsAllDocumented() {
        XCTAssertEqual(PyrxSynapseImplHelpers.parseLogLevel("debug"), .debug)
        XCTAssertEqual(PyrxSynapseImplHelpers.parseLogLevel("info"), .info)
        XCTAssertEqual(PyrxSynapseImplHelpers.parseLogLevel("warning"), .warning)
        XCTAssertEqual(PyrxSynapseImplHelpers.parseLogLevel("error"), .error)
        XCTAssertEqual(PyrxSynapseImplHelpers.parseLogLevel("none"), .none)
    }

    func test_parseLogLevel_rejectsUnknown() {
        // Returning nil (NOT defaulting to .info) lets the bridge
        // surface a typed `invalid_argument` rejection to JS instead
        // of silently behaving differently.
        XCTAssertNil(PyrxSynapseImplHelpers.parseLogLevel("verbose"))
        XCTAssertNil(PyrxSynapseImplHelpers.parseLogLevel("DEBUG")) // case-sensitive
        XCTAssertNil(PyrxSynapseImplHelpers.parseLogLevel(""))
        XCTAssertNil(PyrxSynapseImplHelpers.parseLogLevel("trace"))
    }

    // MARK: - authorizationOptions — flag combinations

    func test_authorizationOptions_allTrue() {
        let opts = PyrxSynapseImplHelpers.authorizationOptions(
            alert: true, sound: true, badge: true
        )
        XCTAssertTrue(opts.contains(.alert))
        XCTAssertTrue(opts.contains(.sound))
        XCTAssertTrue(opts.contains(.badge))
    }

    func test_authorizationOptions_allFalse() {
        let opts = PyrxSynapseImplHelpers.authorizationOptions(
            alert: false, sound: false, badge: false
        )
        // An empty option set means "request, but ask for no presentation
        // privileges" — which is rarely useful but is a valid OS-level
        // request (silent push only). The shim must NOT default-on for
        // false flags.
        XCTAssertFalse(opts.contains(.alert))
        XCTAssertFalse(opts.contains(.sound))
        XCTAssertFalse(opts.contains(.badge))
    }

    func test_authorizationOptions_mixed() {
        let opts = PyrxSynapseImplHelpers.authorizationOptions(
            alert: true, sound: false, badge: true
        )
        XCTAssertTrue(opts.contains(.alert))
        XCTAssertFalse(opts.contains(.sound))
        XCTAssertTrue(opts.contains(.badge))
    }
}
