/*
 * PyrxWrapper.swift
 * @pyrx/synapse-react-native — testability indirection for the published
 * `PYRXSynapse` SDK.
 *
 * Why this exists
 * ---------------
 * `PyrxSynapseImpl.swift` historically called `Pyrx.shared` directly.
 * That made the impl uniteable: `Pyrx.shared` is a process-wide actor
 * that owns Keychain state, network sessions, and the event queue, and
 * it cannot be substituted at the call site. Tests had no way to assert
 * "given JS sent { externalId, traits }, did the impl call
 * Pyrx.shared.identify with the right marshalled args?" without
 * actually performing identify — which would touch Keychain and the
 * network.
 *
 * The wrapper is a thin protocol that mirrors every Pyrx.shared method
 * the bridge calls. Production code injects `ProductionPyrxWrapper`,
 * which forwards 1:1 to `Pyrx.shared`. Tests inject a mock conforming
 * to the same protocol, asserting on the recorded calls.
 *
 * Scope
 * -----
 * Only the methods the bridge actually calls live here — additions to
 * the public Pyrx surface (e.g. observer APIs from Phase 9.2.1) will
 * grow this protocol when they are needed. Keeping it narrow keeps the
 * impl easy to mock without forcing tests to satisfy methods they don't
 * touch.
 *
 * Not a long-term abstraction
 * ---------------------------
 * This is a testability seam, NOT a public extension point. Customers
 * never see it; the impl never reaches across it for anything except
 * delegation. If the SDK ever splits public APIs (e.g. push observer
 * gets its own type), this file follows.
 */

import Foundation
import PYRXSynapse
import UserNotifications

/// Mockable surface around `Pyrx.shared`. Mirrors the methods
/// `PyrxSynapseImpl` calls — nothing more.
///
/// All methods are `async` because the underlying actor methods are; the
/// production wrapper just awaits and forwards. The protocol is not
/// `Sendable`-constrained: callers (the impl) already run on
/// `@MainActor`, and the production wrapper's forwarding methods inherit
/// the caller's isolation. A mock implementation MUST be safe to call
/// from `@MainActor` context (in practice every mock used in tests just
/// records calls on a serial array — trivially safe).
@MainActor
public protocol PyrxWrapper {
    func initialize(config: PyrxConfig) async throws
    func setLogLevel(_ level: LogLevel) async
    func debugInfo() async -> PyrxDebugInfo
    func identify(
        externalId: String,
        traits: [String: JSONValue]?
    ) async throws -> IdentityResult
    func alias(newExternalId: String) async throws -> IdentityResult
    func logout() async throws
    func track(eventName: String, properties: [String: JSONValue]?) async throws
    func screen(screenName: String, properties: [String: JSONValue]?) async throws
    func requestPushPermission(
        options: UNAuthorizationOptions
    ) async -> PushPermissionStatus
    func setTrackingEnabled(_ enabled: Bool) async
    func deleteUser() async throws
}

/// Production wrapper — forwards every call to `Pyrx.shared`. Exists so
/// the impl's default initializer can keep its no-arg form for the
/// `[PyrxSynapseImpl shared]` ObjC entry point.
@MainActor
public final class ProductionPyrxWrapper: PyrxWrapper {
    public init() {}

    public func initialize(config: PyrxConfig) async throws {
        try await Pyrx.shared.initialize(config: config)
    }

    public func setLogLevel(_ level: LogLevel) async {
        await Pyrx.shared.setLogLevel(level)
    }

    public func debugInfo() async -> PyrxDebugInfo {
        await Pyrx.shared.debugInfo()
    }

    public func identify(
        externalId: String,
        traits: [String: JSONValue]?
    ) async throws -> IdentityResult {
        try await Pyrx.shared.identify(externalId: externalId, traits: traits)
    }

    public func alias(newExternalId: String) async throws -> IdentityResult {
        try await Pyrx.shared.alias(newExternalId: newExternalId)
    }

    public func logout() async throws {
        try await Pyrx.shared.logout()
    }

    public func track(
        eventName: String,
        properties: [String: JSONValue]?
    ) async throws {
        try await Pyrx.shared.track(eventName: eventName, properties: properties)
    }

    public func screen(
        screenName: String,
        properties: [String: JSONValue]?
    ) async throws {
        try await Pyrx.shared.screen(screenName: screenName, properties: properties)
    }

    public func requestPushPermission(
        options: UNAuthorizationOptions
    ) async -> PushPermissionStatus {
        await Pyrx.shared.requestPushPermission(options: options)
    }

    public func setTrackingEnabled(_ enabled: Bool) async {
        await Pyrx.shared.setTrackingEnabled(enabled)
    }

    public func deleteUser() async throws {
        try await Pyrx.shared.deleteUser()
    }
}
