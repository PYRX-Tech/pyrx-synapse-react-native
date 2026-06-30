/**
 * `Synapse` namespace — the imperative public surface customers consume.
 *
 *   import { Synapse } from '@pyrx/synapse-react-native';
 *   await Synapse.initialize({ workspaceId, apiKey, environment: 'production' });
 *   await Synapse.identify('user_123', { plan: 'pro' });
 *
 * This module is intentionally a thin transform-and-delegate layer over
 * the TurboModule spec in `./NativePyrxSynapse`. The transforms it
 * applies, ordered by purpose:
 *
 *   1. **Friendlier types at the JS boundary.** The TurboModule spec is
 *      constrained by RN codegen — no union string literals on object
 *      properties, no arbitrary `Record<K, V>` cargo across the bridge.
 *      The namespace re-types those as their natural TypeScript shapes
 *      (`environment: 'production' | 'sandbox'`, `traits: SynapseTraits`),
 *      then narrows / encodes before invoking the bridge.
 *
 *   2. **JSON envelope for traits / properties.** Arbitrary maps cross
 *      the bridge as JSON strings (`identify(externalId, traitsJson)`).
 *      The namespace JSON-encodes before calling and decodes server-side
 *      results — keeping the asymmetry confined to one file.
 *
 *   3. **Error lifting.** Native rejections become `SynapseError`
 *      instances via `fromNativeError`, giving callers a stable
 *      `instanceof` check + a typed `code`.
 *
 *   4. **Input validation that fails fast.** Empty strings, NaN-numbered
 *      `maxQueueSize`, and other invalid arguments reject with
 *      `SynapseError('invalid_argument', ...)` before crossing the
 *      bridge — saves a native round-trip and gives a JS-side stack.
 *
 * No state is held in this module. The TurboModule + native SDK own
 * everything; this file is stateless transforms.
 */

import NativePyrxSynapse, {
  type PushPermissionStatus as RawPushPermissionStatus,
  type SynapseDebugInfo,
  type SynapseIdentifyResult,
} from './NativePyrxSynapse';
import { SynapseError, fromNativeError } from './SynapseError';
import { inApp as inAppNamespace } from './inApp';

// ----------------------------------------------------------------------
// Public types — re-exported so customers only import from one place
// ----------------------------------------------------------------------

/**
 * Trait / property value shape allowed across the bridge. Mirrors the
 * native SDKs' wire contract: string-keyed, primitive-or-null values,
 * arrays of primitives, and shallow nested objects of the same shape.
 * Dates serialise as ISO-8601 strings.
 */
export type SynapsePropertyValue =
  | string
  | number
  | boolean
  | null
  | SynapsePropertyValue[]
  | { [key: string]: SynapsePropertyValue };

/** A bag of traits for `identify` or properties for `track` / `screen`. */
export type SynapseProperties = Record<string, SynapsePropertyValue>;

/**
 * Environment discriminator for `initialize`. The native SDKs map this
 * to the wire-level `live` / `test` divider.
 */
export type SynapseEnvironment = 'production' | 'sandbox';

/** Verbosity discriminator for `setLogLevel` / initial `logLevel`. */
export type SynapseLogLevel = 'debug' | 'info' | 'warning' | 'error' | 'none';

/** Push permission discriminator. `provisional` is iOS-only. */
export type PushPermissionStatus = RawPushPermissionStatus;

/** Options forwarded to `requestPushPermission()`. */
export type PushPermissionOptions = {
  alert?: boolean;
  sound?: boolean;
  badge?: boolean;
};

/**
 * Config object for `Synapse.initialize`. Customer-friendly version of
 * the raw `SynapseInitConfig` — `environment` and `logLevel` are real
 * union types here even though the bridge spec must use plain strings.
 */
export type SynapseInitConfig = {
  workspaceId: string;
  apiKey: string;
  environment: SynapseEnvironment;
  baseUrl?: string;
  logLevel?: SynapseLogLevel;
  maxQueueSize?: number;
};

export type { SynapseDebugInfo, SynapseIdentifyResult };

// ----------------------------------------------------------------------
// Validation helpers (fail-fast at JS boundary)
// ----------------------------------------------------------------------

function requireNonEmptyString(
  name: string,
  value: unknown
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SynapseError(
      'invalid_argument',
      `${name} must be a non-empty string`,
      { received: value }
    );
  }
}

function requirePlainObject(
  name: string,
  value: unknown
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SynapseError(
      'invalid_argument',
      `${name} must be a plain object`,
      { received: value }
    );
  }
}

function encodeOptionalPayload(
  value: SynapseProperties | undefined
): string | null {
  if (value === undefined) {
    return null;
  }
  requirePlainObject('properties', value);
  try {
    return JSON.stringify(value);
  } catch (err) {
    throw new SynapseError(
      'invalid_argument',
      'properties failed to serialise as JSON',
      { cause: String(err) }
    );
  }
}

/**
 * Centralised error-handling wrapper. Every method goes through this so
 * the rejection contract is uniform. Validation throws propagate as
 * `SynapseError`s; bridge rejections become `SynapseError`s via
 * `fromNativeError`.
 */
async function bridged<T>(invoke: () => Promise<T>): Promise<T> {
  try {
    return await invoke();
  } catch (err) {
    throw fromNativeError(err);
  }
}

// ----------------------------------------------------------------------
// The Synapse namespace
// ----------------------------------------------------------------------

/**
 * Imperative SDK surface. Mirrors every method on the native iOS + Android
 * SDKs 1:1. Inside React components, prefer the hooks in `./hooks/` for
 * reactive ergonomics; use `Synapse.*` from non-component callers
 * (Redux middleware, sagas, plain utility modules).
 */
export const Synapse = {
  // ------------------- Lifecycle -------------------

  /**
   * Initialize the SDK. Must be called once at app start before any
   * other method. Calling a second time with the same config is a no-op;
   * calling with a differing config rejects with `invalid_argument`.
   */
  async initialize(config: SynapseInitConfig): Promise<void> {
    requireNonEmptyString('config.workspaceId', config.workspaceId);
    requireNonEmptyString('config.apiKey', config.apiKey);
    requireNonEmptyString('config.environment', config.environment);
    if (
      config.environment !== 'production' &&
      config.environment !== 'sandbox'
    ) {
      throw new SynapseError(
        'invalid_argument',
        "config.environment must be 'production' or 'sandbox'",
        { received: config.environment }
      );
    }
    if (
      config.maxQueueSize !== undefined &&
      (!Number.isFinite(config.maxQueueSize) || config.maxQueueSize <= 0)
    ) {
      throw new SynapseError(
        'invalid_argument',
        'config.maxQueueSize must be a positive finite number',
        { received: config.maxQueueSize }
      );
    }

    // Build the bridge-shaped config. Optional fields are omitted (not
    // set to `undefined`) so the codegen-shaped struct fields stay tidy
    // on the native side.
    const raw: {
      workspaceId: string;
      apiKey: string;
      environment: string;
      baseUrl?: string;
      logLevel?: string;
      maxQueueSize?: number;
    } = {
      workspaceId: config.workspaceId,
      apiKey: config.apiKey,
      environment: config.environment,
    };
    if (config.baseUrl !== undefined) {
      requireNonEmptyString('config.baseUrl', config.baseUrl);
      raw.baseUrl = config.baseUrl;
    }
    if (config.logLevel !== undefined) {
      raw.logLevel = config.logLevel;
    }
    if (config.maxQueueSize !== undefined) {
      raw.maxQueueSize = config.maxQueueSize;
    }

    return bridged(() => NativePyrxSynapse.initialize(raw));
  },

  /** Update runtime verbosity. */
  async setLogLevel(level: SynapseLogLevel): Promise<void> {
    requireNonEmptyString('level', level);
    return bridged(() => NativePyrxSynapse.setLogLevel(level));
  },

  /** Diagnostic snapshot — useful for debug menus + bug reports. */
  async debugInfo(): Promise<SynapseDebugInfo> {
    return bridged(() => NativePyrxSynapse.debugInfo());
  },

  // ------------------- Identity -------------------

  /**
   * Bind the current device to an external identity. The native SDKs
   * handle the anonymous-to-known merge on the server side.
   */
  async identify(
    externalId: string,
    traits?: SynapseProperties
  ): Promise<SynapseIdentifyResult> {
    requireNonEmptyString('externalId', externalId);
    const traitsJson = encodeOptionalPayload(traits);
    return bridged(() => NativePyrxSynapse.identify(externalId, traitsJson));
  },

  /**
   * Rename the active external identity. Same return shape as
   * `identify` so callers can branch on the merge `path` field.
   */
  async alias(newExternalId: string): Promise<SynapseIdentifyResult> {
    requireNonEmptyString('newExternalId', newExternalId);
    return bridged(() => NativePyrxSynapse.alias(newExternalId));
  },

  /** Drop the current identity and roll a fresh anonymousId. */
  async logout(): Promise<void> {
    return bridged(() => NativePyrxSynapse.logout());
  },

  // ------------------- Events -------------------

  /**
   * Track a custom event. Returns once the event has been enqueued —
   * NOT once it has been delivered to the backend (the native queue
   * owns delivery + retry + drop semantics).
   */
  async track(
    eventName: string,
    properties?: SynapseProperties
  ): Promise<void> {
    requireNonEmptyString('eventName', eventName);
    const propertiesJson = encodeOptionalPayload(properties);
    return bridged(() => NativePyrxSynapse.track(eventName, propertiesJson));
  },

  /** Track a screen view. */
  async screen(
    screenName: string,
    properties?: SynapseProperties
  ): Promise<void> {
    requireNonEmptyString('screenName', screenName);
    const propertiesJson = encodeOptionalPayload(properties);
    return bridged(() => NativePyrxSynapse.screen(screenName, propertiesJson));
  },

  // ------------------- Push: registration -------------------

  /**
   * Ask the OS for permission to send push notifications and register
   * for remote notifications. Token capture is automatic on both
   * platforms — see the iOS `PyrxSynapseAppDelegate` and Android
   * `PyrxMessagingService` base classes that PR-1 ships.
   *
   * `options` defaults to `{ alert: true, sound: true, badge: true }`.
   */
  async requestPushPermission(
    options?: PushPermissionOptions
  ): Promise<PushPermissionStatus> {
    const resolved: PushPermissionOptions = {
      alert: options?.alert ?? true,
      sound: options?.sound ?? true,
      badge: options?.badge ?? true,
    };
    return bridged(() => NativePyrxSynapse.requestPushPermission(resolved));
  },

  /**
   * Read-only — current push permission state without prompting the
   * user. Use this to decide whether to show a soft-ask UI before
   * triggering the OS dialog.
   */
  async getPushPermissionStatus(): Promise<PushPermissionStatus> {
    return bridged(() => NativePyrxSynapse.getPushPermissionStatus());
  },

  // ------------------- Privacy / kill switch -------------------

  /**
   * Toggle the SDK's tracking gate. `false` drains the queue and
   * disables future event capture; identity is preserved.
   */
  async setTrackingEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') {
      throw new SynapseError('invalid_argument', 'enabled must be a boolean', {
        received: enabled,
      });
    }
    return bridged(() => NativePyrxSynapse.setTrackingEnabled(enabled));
  },

  /**
   * GDPR delete — drops local identity, wipes the encrypted store,
   * drains the queue, and asks the backend to forget the contact.
   * Irreversible.
   */
  async deleteUser(): Promise<void> {
    return bridged(() => NativePyrxSynapse.deleteUser());
  },

  // ------------------- In-App Messaging (0.3.0, Phase 10 PR-2b) -------------------

  /**
   * In-app messaging namespace. Five methods — `show` / `getActive` /
   * `dismiss` / `markInteracted` / `refresh`. Cross-SDK symmetric per
   * ADR-0009 D5.
   *
   * The SDK delivers `InAppMessage` data to the host app's render
   * callback (registered via `Synapse.inApp.show(placement, callback)`).
   * The SDK does NOT render — the host draws the UI in whatever style
   * fits its design system (typical RN pattern: a `<Modal>` driven by
   * component state populated from the callback).
   *
   * Inside React components, prefer the hooks `useInAppMessage`,
   * `useInAppMessageReceived`, `useInAppMessageDismissed` for
   * subscription lifecycle ergonomics.
   */
  inApp: inAppNamespace,
} as const;

/**
 * Type alias for the namespace itself. Allows callers to type-annotate
 * mock implementations: `const fake: SynapseAPI = { ... }`.
 */
export type SynapseAPI = typeof Synapse;
