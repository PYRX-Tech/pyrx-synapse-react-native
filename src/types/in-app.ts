/**
 * In-App Messaging — public TypeScript types (Phase 10 PR-2b RN).
 *
 * Mirrors the browser SDK's `InAppMessage` / `InAppCta` /
 * `InAppCtaActionType` shapes at `packages/sdk/src/types.ts:193 / :159
 * / :143` field-for-field. Same wire shape, same field names,
 * snake_case verbatim from the backend `InAppMessageSdkPayload`
 * schema (`synapse-api/app/schemas/in_app.py`). No client-side
 * mapping — keeping the JS surface symmetric with the browser SDK
 * makes cross-SDK docs reusable (the cross-SDK symmetric contract
 * per ADR-0009 D5).
 *
 * Native iOS / Android SDKs idiomatically expose camelCase
 * properties (e.g. `imageUrl`, `messageId`); the bridge serializes
 * back to snake_case on the JS side so RN consumers see the same
 * shape as their browser counterparts. This decision matches the
 * official @react-native-firebase SDK's approach (wire shape over
 * idiom for the JS surface).
 *
 * **The SDK does NOT render these messages.** The host app
 * receives the typed payload via the `useInAppMessage(placement,
 * callback)` hook (or the `Synapse.inApp.show(...)` imperative
 * surface) and draws the UI in whatever style fits its design
 * system (typical RN pattern: a controlled `<Modal>` or `<View>`
 * driven by component state). PYRX UI Kit pre-built components are
 * deferred to Phase 10.x per ADR-0008 D2.
 */

/**
 * Action types a CTA can carry. Matches the backend's
 * `_CTA_ACTION_TYPE` literal (`synapse-api/app/schemas/in_app.py`).
 *
 * The SDK does NOT execute these actions — it surfaces them to the
 * host app via the rendering callback. The host app is responsible
 * for the actual navigation / webview / dismiss / callback wiring
 * (typical RN pattern: switch on `action_type` and either
 * `Linking.openURL(action_payload)`, push a webview screen via your
 * navigator, or fire `Synapse.inApp.dismiss(...)`).
 */
export type InAppCtaActionType =
  | 'deep_link'
  | 'dismiss'
  | 'webview'
  | 'callback';

/**
 * A rendered CTA delivered to the SDK. Symmetric across all 5 SDKs
 * per ADR-0009 D5. NLT source has already been resolved against the
 * current contact at fetch time — `label` and `action_payload` are
 * ready to render verbatim.
 *
 * Wire shape mirrors backend `InAppCtaRendered`
 * (`synapse-api/app/schemas/in_app.py:123`).
 */
export interface InAppCta {
  /** Stable identifier passed back via `markInteracted` on tap. */
  id: string;
  /** NLT-rendered label text. */
  label: string;
  /** How the host app should handle the tap. */
  action_type: InAppCtaActionType;
  /**
   * NLT-rendered action payload. URL string for `deep_link` / `webview`;
   * opaque string for `callback`; `null` (or omitted) for `dismiss`.
   */
  action_payload: string | null;
}

/**
 * One in-app message delivered to the host app's render callback.
 *
 * Wire shape mirrors backend `InAppMessageSdkPayload`
 * (`synapse-api/app/schemas/in_app.py:416`). Same shape as the
 * browser SDK's `InAppMessage` (`packages/sdk/src/types.ts:193`).
 *
 * Field cheat-sheet:
 *
 *   - `id`           — server-issued **assignment** id. Pass back via
 *                      `markInteracted(id, ctaId)` / `dismiss(id)`.
 *                      Stable across re-renders of the same assignment;
 *                      DIFFERENT from `message_id` because the same
 *                      template can be assigned multiple times
 *                      (frequency caps, A/B).
 *   - `message_id`   — `in_app_messages.id` — stable across
 *                      assignments. Use for host-side dedupe when the
 *                      same template can be re-assigned.
 *   - `placement_key`— placement key the host app maps to a UI
 *                      surface (`"home_banner"`, `"settings_modal"`).
 *   - `title` /
 *     `body`         — NLT-rendered; ready to render verbatim.
 *   - `image_url`    — NLT-rendered URL, or `null`.
 *   - `ctas`         — 0–2 CTAs (Phase 10 v1 scope).
 *   - `custom`       — host-app-driven custom JSON. Never NLT-rendered
 *                      server-side; the host uses these fields for
 *                      custom analytics tags, structured product lists
 *                      for host-rendered carousels, etc.
 *   - `expires_at`   — ISO-8601 expiry instant, or `null`. The SDK does
 *                      NOT auto-evict expired messages — the next poll
 *                      drops them server-side.
 *   - `priority`     — host-app sort / queue priority. Higher = more
 *                      important. `Synapse.inApp.getActive` returns
 *                      results sorted priority desc, then expiry asc.
 */
export interface InAppMessage {
  /** Server-issued assignment id. Pass back via `markInteracted` / `dismiss`. */
  id: string;
  /** The `in_app_messages.id` — stable across assignments. */
  message_id: string;
  /** Placement key the host app maps to a UI surface. */
  placement_key: string;
  /** NLT-rendered title. */
  title: string;
  /** NLT-rendered body. */
  body: string;
  /** NLT-rendered image URL, or null. */
  image_url: string | null;
  /** 0–2 CTAs (Phase 10 v1 scope). */
  ctas: InAppCta[];
  /**
   * Host-app-driven custom JSON. Never NLT-rendered server-side; the
   * host uses these fields for custom analytics tags, structured
   * product lists for host-rendered carousels, etc. The native bridge
   * surfaces an empty object (`{}`) when the backend payload omits
   * the field — matches the browser SDK's contract.
   */
  custom: Record<string, unknown>;
  /** ISO-8601 expiry timestamp, or null for no expiry. */
  expires_at: string | null;
  /** Host-app sort / queue priority. Higher = more important. */
  priority: number;
}

/**
 * Reason passed by the host app to
 * `Synapse.inApp.dismiss(messageId, reason?)`.
 *
 * Free-form string — the SDK does not validate or interpret it.
 * Suggested conventions:
 *   - `'user_dismissed'` — explicit close (X button)
 *   - `'cta_dismissed'`  — a DISMISS-type CTA was tapped
 *   - `'expired'`        — host-side auto-dismiss after some timeout
 *
 * Per ADR-0008 D2 this value does NOT cross the wire (the PR-1
 * backend `/v1/in-app/log` schema has no `reason` field and would
 * 422). It is surfaced on the `inAppMessageDismissed` observer event
 * for analytics middleware. Reserved for forward-compat — a future
 * backend revision may carry it.
 */
export type InAppDismissReason = string;

/**
 * Callback signature for `Synapse.inApp.show(placement, callback)`
 * and `useInAppMessage(placement, callback)`.
 *
 * Invoked once per fresh message matching the registered `placement`.
 * The callback's return value is ignored — the host app is
 * responsible for triggering its own rendering logic inside the
 * callback (typical RN pattern: `setState` to populate a `<Modal>`).
 *
 * The SDK does NOT execute the CTA actions automatically — when a
 * CTA is tapped the host app should call `Synapse.inApp.markInteracted(id, ctaId)`
 * for telemetry, then act on `cta.action_type` itself.
 */
export type InAppRenderCallback = (message: InAppMessage) => void;

/**
 * Callback signature for the `inAppMessageReceived` observer event.
 *
 * Fired whenever the SDK fetches and surfaces a new eligible message
 * for ANY registered placement. Distinct from the placement-specific
 * render callbacks: fires once per new message globally, for hosts
 * that want a single subscription to all in-app activity (analytics
 * middleware, debug overlays, etc.).
 *
 * Symmetric with the native SDKs' `inAppMessageReceived` case on
 * `Pyrx.shared.events()` / `Pyrx.events` per ADR-0009 D5.
 */
export type InAppMessageReceivedHandler = (message: InAppMessage) => void;

/**
 * Callback signature for the `inAppMessageDismissed` observer event.
 *
 * Fired whenever `Synapse.inApp.dismiss(messageId, reason?)` is called
 * — including dismissals the host app did NOT directly initiate
 * (e.g., a future expiry-driven auto-dismiss the SDK fires internally).
 *
 * `reason` is `null` (not `undefined`) when the caller did not provide
 * one. The native bridges produce `null` consistently so the JS shape
 * is stable across iOS + Android.
 *
 * Symmetric with the native SDKs' `inAppMessageDismissed` case on
 * `Pyrx.shared.events()` / `Pyrx.events` per ADR-0009 D5.
 */
export type InAppMessageDismissedHandler = (
  messageId: string,
  reason: string | null
) => void;
