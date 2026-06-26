/**
 * Typed error contract for `@pyrx/synapse-react-native`.
 *
 * Every method on the `Synapse` namespace returns a `Promise<T>`. On
 * failure the promise rejects with a `SynapseError` whose `code` mirrors
 * the native SDKs' `PyrxError` enum:
 *
 *   - "not_initialized"     — Synapse.initialize() not called yet
 *   - "permission_denied"   — push permission rejected by user/OS
 *   - "network_error"       — transport failure or 5xx from backend
 *   - "invalid_argument"    — caller supplied bad input
 *   - "internal_error"      — unexpected SDK-side error; see message
 *
 * The native bridge rejects with an `Error` whose `code` property
 * carries the discriminator string; `fromNativeError` lifts that into a
 * proper `SynapseError` for ergonomic catching in JS. The lift is
 * defensive: if the native side ever rejects with a plain `Error` that
 * lacks a `code`, we default to `"internal_error"` so calling code can
 * still pattern-match safely.
 */

/** Discriminator for `SynapseError.code`. Mirrors `PyrxError` cases. */
export type SynapseErrorCode =
  | 'not_initialized'
  | 'permission_denied'
  | 'network_error'
  | 'invalid_argument'
  | 'internal_error';

const KNOWN_CODES: ReadonlySet<SynapseErrorCode> = new Set([
  'not_initialized',
  'permission_denied',
  'network_error',
  'invalid_argument',
  'internal_error',
]);

/**
 * Public error class thrown (well — rejected with) by every `Synapse.*`
 * method. The class extends `Error` so existing `try/catch` works and
 * `instanceof SynapseError` discriminates SDK errors from caller bugs.
 */
export class SynapseError extends Error {
  public readonly code: SynapseErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: SynapseErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SynapseError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
    // Restore prototype chain when transpiled with older targets — RN's
    // Hermes is modern enough that this is usually a no-op, but it
    // matters for Jest's older `target=es5` snapshot environments.
    Object.setPrototypeOf(this, SynapseError.prototype);
  }
}

/**
 * Lift an arbitrary thrown value (the native bridge can reject with
 * anything) into a `SynapseError`. Used at the JS-side seam in
 * `Synapse.*` method wrappers.
 *
 * Heuristics:
 *   1. If `err` is already a `SynapseError`, return it.
 *   2. If `err.code` is a known discriminator, use it.
 *   3. Otherwise fall back to `"internal_error"`.
 */
export function fromNativeError(err: unknown): SynapseError {
  if (err instanceof SynapseError) {
    return err;
  }

  let message = 'Unknown native error';
  let code: SynapseErrorCode = 'internal_error';
  let details: Record<string, unknown> | undefined;

  if (err instanceof Error) {
    message = err.message || message;
    const maybeCode = (err as Error & { code?: unknown }).code;
    if (
      typeof maybeCode === 'string' &&
      KNOWN_CODES.has(maybeCode as SynapseErrorCode)
    ) {
      code = maybeCode as SynapseErrorCode;
    }
    const maybeDetails = (err as Error & { userInfo?: unknown }).userInfo;
    if (maybeDetails && typeof maybeDetails === 'object') {
      details = maybeDetails as Record<string, unknown>;
    }
  } else if (typeof err === 'string') {
    message = err;
  }

  return new SynapseError(code, message, details);
}
