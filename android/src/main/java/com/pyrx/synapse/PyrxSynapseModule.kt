/*
 * PyrxSynapseModule.kt
 * @pyrx/synapse-react-native — Android TurboModule bridge.
 *
 * Bridges JS calls into the published `tech.pyrx.synapse:synapse-core`
 * + `:synapse-push` SDKs from Maven Central. Every public method here
 * is the Kotlin mirror of the iOS `PyrxSynapseImpl.swift` impl —
 * cross-platform parity is enforced by both the codegen spec
 * (`src/NativePyrxSynapse.ts`) and the docstrings on each method.
 *
 * Why no separate "impl" file like iOS?
 * -------------------------------------
 * On iOS we split because the TurboModule contract is ObjC++ and the
 * SDK is Swift — bridging requires an `.mm` shim. On Android both
 * sides are Kotlin, so the TurboModule subclass IS the impl. The
 * one-file split would be ceremony for no clarity win.
 *
 * Concurrency
 * -----------
 * The `Pyrx` object's mutating methods are `suspend` — every one of
 * them serializes through a per-instance Mutex inside the SDK. We
 * use a `CoroutineScope(SupervisorJob() + Dispatchers.Default)` so a
 * failed dispatch doesn't cancel sibling work. Promises resolve on
 * whichever thread the coroutine winds up on; RN's TurboModule
 * machinery is thread-safe wrt promise callbacks.
 *
 * Error mapping (see also iOS `PyrxSynapseImpl.swift`)
 * ----------------------------------------------------
 * - PyrxError.NotInitialized   → "not_initialized"
 * - PyrxError.InvalidConfig    → "invalid_argument"
 * - PyrxError.Network          → "network_error"
 * - PyrxError.StorageFailure   → "internal_error"
 * - PyrxError.AlreadyInitialized (only fires when configs differ)
 *                              → "invalid_argument"
 * - <anything else>            → "internal_error"
 *
 * What's intentionally NOT here
 * ----------------------------
 * - handleDeviceToken — wired by `PyrxMessagingService` (the FCM
 *   service from the synapse-push module). The plugin registers it in
 *   the customer's AndroidManifest.xml; bare-RN customers add one
 *   entry by hand. The JS layer never sees the token.
 * - Cold-start push attribution — captured by MainActivity.onCreate
 *   on the customer side (one-line `Pyrx.recordColdStartLaunch(intent)`
 *   call). The sample app demonstrates the wiring.
 * - handleNotificationTap — fired natively from MainActivity.onNewIntent
 *   by the customer; the resulting `pyrx:push:click` event surfaces
 *   to JS via the observer-wiring `collect` below (wired in 0.2.0).
 *
 * Observer wiring (Phase 9.2.1)
 * -----------------------------
 * On the first JS NativeEventEmitter subscriber attach, we launch a
 * coroutine in [observerScope] that collects `Pyrx.events` (a
 * SharedFlow exposed by synapse-core 0.1.4's observer surface) and
 * forwards each PyrxEvent case to RN's DeviceEventManagerModule.
 * RCTDeviceEventEmitter. The collect Job is cancelled when the last
 * listener detaches (`removeListeners` brings the count to 0) and on
 * `invalidate()` (bridge teardown / Metro reload).
 *
 * Why one coroutine per module instance (not per JS subscriber): the
 * underlying SharedFlow fans out to every collector independently;
 * subscribing N times would duplicate-deliver each event. The
 * RCTDeviceEventEmitter handles JS-side multi-subscriber fan-out for
 * us — one native collect is enough.
 *
 * Permission flow
 * ---------------
 * `requestPushPermission` is more nuanced on Android than iOS because
 * the runtime permission (`POST_NOTIFICATIONS`) only exists on API 33+.
 * On older OS versions we return "granted" immediately. On API 33+ we
 * launch `ActivityCompat.requestPermissions` against the current
 * Activity (resolved via `currentActivity` on the
 * ReactApplicationContext) and surface the result via an
 * `ActivityEventListener` that catches the grant callback.
 */

package com.pyrx.synapse

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolOrNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import tech.pyrx.synapse.LogLevel
import tech.pyrx.synapse.Pyrx
import tech.pyrx.synapse.PyrxConfig
import tech.pyrx.synapse.PyrxEnvironment
import tech.pyrx.synapse.PyrxError
import tech.pyrx.synapse.inapp.InAppMessage
import tech.pyrx.synapse.inapp.ShowToken
import tech.pyrx.synapse.network.JSONValue
import tech.pyrx.synapse.observer.IdentitySnapshot as PyrxIdentitySnapshot
import tech.pyrx.synapse.observer.PushClickedEvent as PyrxPushClickedEvent
import tech.pyrx.synapse.observer.PushReceivedEvent as PyrxPushReceivedEvent
import tech.pyrx.synapse.observer.PyrxEvent
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

class PyrxSynapseModule(reactContext: ReactApplicationContext) :
    NativePyrxSynapseSpec(reactContext) {

    private val appContext: ReactApplicationContext = reactContext

    /** SupervisorJob so a failed dispatch doesn't cancel sibling work. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * Dedicated scope for the [Pyrx.events] collect (Phase 9.2.1
     * observer wiring). Held separately from [scope] so we can cancel
     * the observer Job WITHOUT cancelling in-flight identify/track
     * calls — failures in one path must not bring down the other.
     */
    private val observerScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * Count of JS subscribers attached via NativeEventEmitter. Used to
     * lazily start the observer collect on the first listener and stop
     * it on the last detach (cost-aware: apps that never subscribe pay
     * zero coroutine overhead).
     */
    private var listenerCount: Int = 0

    /**
     * Handle to the running [Pyrx.events] collect coroutine. Non-null
     * when at least one JS subscriber is attached; null otherwise.
     * Cancelled in [stopObservingPyrxEvents] / [invalidate].
     */
    private var observerJob: Job? = null

    /**
     * Pending push-permission result. Set when JS calls
     * `requestPushPermission()` on API 33+ and the OS dialog is
     * launched; consumed in [onRequestPermissionsResult] (wired below
     * via the PermissionAwareActivity hook).
     */
    private var pendingPushPermissionPromise: Promise? = null

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * In-app message payload encoder (Phase 10 PR-2b — 0.3.0). The
     * default `Json` instance plus `InAppMessage`'s `@SerialName`
     * annotations produce the snake_case wire shape the JS layer
     * expects (mirrors the backend `InAppMessageSdkPayload`).
     *
     * Kept separate from [json] (which has
     * `ignoreUnknownKeys = true` for safer trait decoding) because
     * the in-app encoder side never needs that lenience and we want
     * an obvious explicit serializer.
     */
    private val inAppJson = Json { encodeDefaults = true }

    /**
     * JS-side subscription registry for `Pyrx.inApp.show(...)`. Keyed
     * by the integer the JS hook layer holds; each entry retains the
     * native [ShowToken] so it stays alive until JS calls
     * `inAppHideAll(id)`.
     *
     * `ConcurrentHashMap` because the JS bridge can call from any
     * worker thread; the alternative (synchronized block) would
     * serialise every in-app dispatch through one lock.
     */
    private val inAppShowTokens: ConcurrentHashMap<Int, ShowToken> = ConcurrentHashMap()

    /** Monotonic source for the JS-side subscription id. */
    private val nextInAppSubscriptionId: AtomicInteger = AtomicInteger(1)

    companion object {
        const val NAME = NativePyrxSynapseSpec.NAME
        private const val PUSH_PERMISSION_REQUEST_CODE = 9_104_001
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    override fun initialize(config: ReadableMap, promise: Promise) {
        val workspaceIdRaw = config.getString("workspaceId")
        if (workspaceIdRaw.isNullOrEmpty()) {
            promise.reject("invalid_argument", "workspaceId must be a non-empty string")
            return
        }
        val workspaceId = try {
            UUID.fromString(workspaceIdRaw)
        } catch (_: IllegalArgumentException) {
            promise.reject("invalid_argument", "workspaceId must be a UUID string")
            return
        }
        val apiKey = config.getString("apiKey")
        if (apiKey.isNullOrEmpty()) {
            promise.reject("invalid_argument", "apiKey must be a non-empty string")
            return
        }
        val envRaw = config.getString("environment")
        val environment = when (envRaw) {
            "production" -> PyrxEnvironment.PRODUCTION
            "sandbox"    -> PyrxEnvironment.SANDBOX
            else -> {
                promise.reject(
                    "invalid_argument",
                    "environment must be 'production' or 'sandbox' (got '$envRaw')",
                )
                return
            }
        }
        val baseUrl = config.getString("baseUrl") ?: PyrxConfig.DEFAULT_BASE_URL
        val logLevel = when (config.getString("logLevel")) {
            "debug"   -> LogLevel.DEBUG
            "info"    -> LogLevel.INFO
            "warning" -> LogLevel.WARNING
            "error"   -> LogLevel.ERROR
            "none"    -> LogLevel.NONE
            null      -> LogLevel.INFO
            else      -> LogLevel.INFO
        }
        val maxQueueSize = if (config.hasKey("maxQueueSize")) {
            config.getInt("maxQueueSize")
        } else {
            PyrxConfig.DEFAULT_MAX_QUEUE_SIZE
        }

        // sdkVariant = "rn" produces wire `sdk_platform = "android+rn"`.
        // See pyrx-synapse-android#17 (PyrxConfig.sdkVariant landing).
        val pyrxConfig = PyrxConfig(
            workspaceId = workspaceId,
            apiKey = apiKey,
            environment = environment,
            baseUrl = baseUrl,
            logLevel = logLevel,
            maxQueueSize = maxQueueSize,
            sdkVariant = "rn",
        )

        scope.launch {
            try {
                Pyrx.initialize(context = appContext.applicationContext, config = pyrxConfig)
                // Install the push bridge so the FCM token callback in
                // `PyrxMessagingService` can route into the SDK. Safe
                // to call here because `initialize` has already completed
                // — PyrxPush.install asserts on it.
                tech.pyrx.synapse.push.PyrxPush.install(appContext.applicationContext)
                // Install the in-app bridge (Phase 10 PR-2b — 0.3.0).
                // `PyrxInApp.install` requires `Pyrx.initialize` to have
                // completed — same precondition as `PyrxPush.install`
                // above. The function returns `true` on first install
                // and silently replaces an existing bridge on hot-
                // reload; either case is fine for the RN wrapper.
                tech.pyrx.synapse.inapp.PyrxInApp.install(appContext.applicationContext)
                promise.resolve(null)
            } catch (e: PyrxError) {
                rejectWith(promise, e)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "initialize failed", e)
            }
        }
    }

    override fun setLogLevel(level: String, promise: Promise) {
        val parsed = when (level) {
            "debug"   -> LogLevel.DEBUG
            "info"    -> LogLevel.INFO
            "warning" -> LogLevel.WARNING
            "error"   -> LogLevel.ERROR
            "none"    -> LogLevel.NONE
            else -> {
                promise.reject(
                    "invalid_argument",
                    "logLevel must be one of debug|info|warning|error|none (got '$level')",
                )
                return
            }
        }
        // setLogLevel is synchronous on the Android Pyrx object.
        Pyrx.setLogLevel(parsed)
        promise.resolve(null)
    }

    override fun debugInfo(promise: Promise) {
        scope.launch {
            try {
                val info = Pyrx.debugInfo()
                val result = com.facebook.react.bridge.Arguments.createMap().apply {
                    putBoolean("initialized", info.initialized)
                    info.anonymousId?.let { putString("anonymousId", it) } ?: putNull("anonymousId")
                    // PyrxDebugInfo only exposes hasExternalId (Bool), not
                    // the string — mirror iOS impl decision (see comment
                    // in PyrxSynapseImpl.swift).
                    putNull("externalId")
                    putBoolean("hasDeviceToken", info.hasDeviceToken)
                    putInt("queueDepth", info.eventQueueDepth)
                    putString("sdkVersion", info.sdkVersion)
                    putString("sdkPlatform", info.platform)
                    putBoolean("trackingEnabled", info.trackingEnabled)
                }
                promise.resolve(result)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "debugInfo failed", e)
            }
        }
    }

    // ---------------------------------------------------------------------
    // Identity
    // ---------------------------------------------------------------------

    override fun identify(externalId: String, traitsJson: String?, promise: Promise) {
        val traits = parseTraits(traitsJson)
        scope.launch {
            try {
                val result = Pyrx.identify(externalId = externalId, traits = traits)
                promise.resolve(identityResultMap(result))
            } catch (e: PyrxError) {
                rejectWith(promise, e)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "identify failed", e)
            }
        }
    }

    override fun alias(newExternalId: String, promise: Promise) {
        scope.launch {
            try {
                val result = Pyrx.alias(newExternalId = newExternalId)
                promise.resolve(identityResultMap(result))
            } catch (e: PyrxError) {
                rejectWith(promise, e)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "alias failed", e)
            }
        }
    }

    override fun logout(promise: Promise) {
        scope.launch {
            try {
                Pyrx.logout()
                promise.resolve(null)
            } catch (e: PyrxError) {
                rejectWith(promise, e)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "logout failed", e)
            }
        }
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    override fun track(eventName: String, propertiesJson: String?, promise: Promise) {
        val properties = parseTraits(propertiesJson)
        scope.launch {
            try {
                Pyrx.track(eventName = eventName, properties = properties)
                promise.resolve(null)
            } catch (e: PyrxError) {
                rejectWith(promise, e)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "track failed", e)
            }
        }
    }

    override fun screen(screenName: String, propertiesJson: String?, promise: Promise) {
        val properties = parseTraits(propertiesJson)
        scope.launch {
            try {
                Pyrx.screen(screenName = screenName, properties = properties)
                promise.resolve(null)
            } catch (e: PyrxError) {
                rejectWith(promise, e)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "screen failed", e)
            }
        }
    }

    // ---------------------------------------------------------------------
    // Push permission
    // ---------------------------------------------------------------------

    override fun requestPushPermission(options: ReadableMap, promise: Promise) {
        // The `options` ReadableMap (alert/sound/badge) is iOS-only —
        // Android FCM ignores the mask entirely (the OS-level
        // notification channel + the system's own UI controls per-app
        // sound/badge/banner). We accept it for API parity and ignore
        // it on this platform.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // Pre-Android 13: notification permission is granted at
            // install time when the manifest declares the permission;
            // there is no runtime gate. Report granted.
            promise.resolve("granted")
            return
        }
        val granted = ContextCompat.checkSelfPermission(
            appContext,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) {
            promise.resolve("granted")
            return
        }
        val activity = appContext.currentActivity
        if (activity == null) {
            // No foreground activity to anchor the dialog on. The host
            // app should call requestPushPermission() while a screen is
            // visible; surface the precondition as notDetermined so the
            // caller can retry.
            promise.resolve("notDetermined")
            return
        }
        // Store the promise; resolve it when the OS dialog returns. The
        // resolution path runs through the customer's MainActivity ->
        // an ActivityCompat.OnRequestPermissionsResultCallback that
        // the example app wires (PR-3 docs).
        pendingPushPermissionPromise = promise
        ActivityCompat.requestPermissions(
            activity,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            PUSH_PERMISSION_REQUEST_CODE,
        )
    }

    /**
     * Hook the customer's MainActivity calls to deliver the OS
     * permission outcome. Bare-RN customers wire this in MainActivity
     * .onRequestPermissionsResult; the Expo plugin (PR-3) generates the
     * glue.
     *
     * Public so the customer's MainActivity can call it directly:
     *
     *     override fun onRequestPermissionsResult(...) {
     *         super.onRequestPermissionsResult(...)
     *         PyrxSynapseModule.deliverPermissionResult(reactContext, requestCode, grantResults)
     *     }
     */
    fun onActivityPermissionResult(requestCode: Int, grantResults: IntArray) {
        if (requestCode != PUSH_PERMISSION_REQUEST_CODE) return
        val promise = pendingPushPermissionPromise ?: return
        pendingPushPermissionPromise = null
        val granted = grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        promise.resolve(if (granted) "granted" else "denied")
    }

    override fun getPushPermissionStatus(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            promise.resolve("granted")
            return
        }
        val granted = ContextCompat.checkSelfPermission(
            appContext,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) {
            promise.resolve("granted")
            return
        }
        // ShouldShowRequestPermissionRationale returns true after the
        // user has denied once; we collapse to "denied" in that case
        // and "notDetermined" if the prompt has never been shown.
        val activity: Activity? = appContext.currentActivity
        val showRationale = activity != null &&
            ActivityCompat.shouldShowRequestPermissionRationale(
                activity, Manifest.permission.POST_NOTIFICATIONS
            )
        promise.resolve(if (showRationale) "denied" else "notDetermined")
    }

    // ---------------------------------------------------------------------
    // Privacy
    // ---------------------------------------------------------------------

    override fun setTrackingEnabled(enabled: Boolean, promise: Promise) {
        scope.launch {
            try {
                Pyrx.setTrackingEnabled(enabled)
                promise.resolve(null)
            } catch (e: PyrxError) {
                rejectWith(promise, e)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "setTrackingEnabled failed", e)
            }
        }
    }

    override fun deleteUser(promise: Promise) {
        scope.launch {
            try {
                Pyrx.deleteUser()
                promise.resolve(null)
            } catch (e: PyrxError) {
                rejectWith(promise, e)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "deleteUser failed", e)
            }
        }
    }

    // ---------------------------------------------------------------------
    // NativeEventEmitter — observer wiring (Phase 9.2.1)
    // ---------------------------------------------------------------------

    /**
     * Called by RN's NativeEventEmitter machinery when JS attaches a
     * listener. We lazily start the observer collect on the first
     * subscriber so apps that never observe pay zero coroutine cost.
     */
    override fun addListener(eventType: String) {
        listenerCount += 1
        if (listenerCount == 1 && observerJob == null) {
            startObservingPyrxEvents()
        }
    }

    /**
     * Counterpart to [addListener]. When the count returns to zero we
     * cancel the collect so the underlying SharedFlow's subscriber
     * count drops.
     */
    override fun removeListeners(count: Double) {
        listenerCount = maxOf(0, listenerCount - count.toInt())
        if (listenerCount == 0) {
            stopObservingPyrxEvents()
        }
    }

    /**
     * Bridge teardown — Metro fast-reload or app termination. Cancel
     * the observer collect so a new bridge instance gets a clean slate
     * (no leaked coroutine from the previous bridge).
     *
     * Also cancels the imperative-call scope so any in-flight
     * identify/track promises reject cleanly instead of resolving
     * against a dead bridge.
     */
    override fun invalidate() {
        stopObservingPyrxEvents()
        // Drop every in-app placement registration so a Metro reload
        // doesn't leak native callbacks past the dead bridge. Each
        // token is `close()`-idempotent, so a JS-side `inAppHideAll`
        // that races with bridge teardown is harmless.
        inAppShowTokens.values.forEach { token ->
            try {
                token.close()
            } catch (_: Throwable) {
                // close() is documented idempotent; defensive.
            }
        }
        inAppShowTokens.clear()
        scope.coroutineContext[Job]?.cancel()
        observerScope.coroutineContext[Job]?.cancel()
        super.invalidate()
    }

    /**
     * Start collecting [Pyrx.events] in [observerScope] and forwarding
     * each event to RN's RCTDeviceEventEmitter. Idempotent — if a Job
     * is already running we tear it down first to avoid duplicate
     * collects on Metro reload race conditions.
     */
    private fun startObservingPyrxEvents() {
        observerJob?.cancel()
        observerJob = observerScope.launch {
            // The SharedFlow's replay buffer (4) means a freshly-
            // attached collector immediately receives the most-recent
            // events — useful for the cold-start race where the JS
            // bridge mounts after a push has already landed.
            Pyrx.events.collect { event ->
                dispatchPyrxEvent(event)
            }
        }
    }

    /**
     * Cancel the held collect Job. Idempotent — calling twice is safe.
     */
    private fun stopObservingPyrxEvents() {
        observerJob?.cancel()
        observerJob = null
    }

    /**
     * Forward a single [PyrxEvent] to the JS layer via RN's
     * RCTDeviceEventEmitter. The event names mirror those in
     * `src/events.ts::SynapseEventMap` exactly — a typo here
     * silently strands the event on the JS side.
     *
     * Wrapped in try/catch because:
     *   1. `getJSModule()` throws if the React instance is being torn
     *      down between our `addListener` and the actual JS attach.
     *   2. The map-conversion helpers below should not throw, but a
     *      defensive net here prevents one bad payload from killing
     *      the entire collect loop.
     */
    private fun dispatchPyrxEvent(event: PyrxEvent) {
        try {
            val emitter = appContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            when (event) {
                is PyrxEvent.PushReceived ->
                    emitter.emit("pyrx:push:received", pushReceivedMap(event.event))
                is PyrxEvent.PushClicked ->
                    emitter.emit("pyrx:push:click", pushClickedMap(event.event))
                is PyrxEvent.PushReceivedColdStart ->
                    emitter.emit("pyrx:push:received-cold-start", pushReceivedMap(event.event))
                is PyrxEvent.QueueDrained ->
                    emitter.emit("pyrx:queue:drained", Arguments.createMap().apply {
                        putInt("count", event.count)
                    })
                is PyrxEvent.IdentityChanged ->
                    emitter.emit("pyrx:identity:changed", Arguments.createMap().apply {
                        if (event.before != null) {
                            putMap("before", identitySnapshotMap(event.before!!))
                        } else {
                            putNull("before")
                        }
                        putMap("after", identitySnapshotMap(event.after))
                    })
                is PyrxEvent.InAppMessageReceived ->
                    emitter.emit("pyrx:in-app:received", inAppMessageMap(event.message))
                is PyrxEvent.InAppMessageDismissed ->
                    emitter.emit("pyrx:in-app:dismissed", Arguments.createMap().apply {
                        putString("messageId", event.messageId)
                        event.reason?.let { putString("reason", it) } ?: putNull("reason")
                    })
            }
        } catch (_: Throwable) {
            // Swallow — see method doc. The next event after the JS
            // instance comes back up will fire normally.
        }
    }

    // ---------------------------------------------------------------------
    // In-App Messaging (Phase 10 PR-2b — 0.3.0)
    // ---------------------------------------------------------------------

    override fun inAppShow(placement: String, promise: Promise) {
        if (placement.isEmpty()) {
            promise.reject("invalid_argument", "placement must be a non-empty string")
            return
        }
        // `Pyrx.inApp.show` registers a placement render callback AND
        // kicks polling for that placement per lifecycle rule 2. We
        // pass an empty callback because the per-message delivery to
        // JS already flows through the observer event
        // `pyrx:in-app:received` (see [dispatchPyrxEvent]). The JS
        // hook (`useInAppMessage(placement, cb)`) filters by
        // placement_key on the bridge-emitted event. Routing through
        // both the render callback AND the observer event would
        // duplicate-deliver to JS.
        val token = Pyrx.inApp.show(placement = placement, callback = { /* no-op */ })
        val id = nextInAppSubscriptionId.getAndIncrement()
        inAppShowTokens[id] = token
        promise.resolve(id)
    }

    override fun inAppHideAll(subscriptionId: Double, promise: Promise) {
        val id = subscriptionId.toInt()
        val token = inAppShowTokens.remove(id)
        if (token != null) {
            try {
                token.close()
            } catch (_: Throwable) {
                // close() is documented idempotent.
            }
        }
        promise.resolve(null)
    }

    override fun inAppGetActive(placement: String?, promise: Promise) {
        val filter = placement?.takeIf { it.isNotEmpty() }
        scope.launch {
            try {
                val messages = Pyrx.inApp.getActive(filter)
                // Serialize through kotlinx-serialization into the
                // backend-wire shape (snake_case keys via
                // `@SerialName`). The JS layer JSON.parses and
                // returns typed InAppMessage[] — same envelope trick
                // identify/track use for the same codegen-type
                // discipline reason: a typed Array<{... custom: any}>
                // is not expressible in the codegen contract.
                val jsonString = inAppJson.encodeToString(
                    kotlinx.serialization.builtins.ListSerializer(InAppMessage.serializer()),
                    messages,
                )
                promise.resolve(jsonString)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "inAppGetActive failed", e)
            }
        }
    }

    override fun inAppDismiss(messageId: String, reason: String?, promise: Promise) {
        if (messageId.isEmpty()) {
            promise.reject("invalid_argument", "messageId must be a non-empty string")
            return
        }
        // Empty-string reason maps to null so the bridge has a
        // uniform null envelope across iOS + Android.
        val normalizedReason = reason?.takeIf { it.isNotEmpty() }
        scope.launch {
            try {
                Pyrx.inApp.dismiss(messageId = messageId, reason = normalizedReason)
                promise.resolve(null)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "inAppDismiss failed", e)
            }
        }
    }

    override fun inAppMarkInteracted(messageId: String, ctaId: String, promise: Promise) {
        if (messageId.isEmpty()) {
            promise.reject("invalid_argument", "messageId must be a non-empty string")
            return
        }
        if (ctaId.isEmpty()) {
            promise.reject("invalid_argument", "ctaId must be a non-empty string")
            return
        }
        scope.launch {
            try {
                Pyrx.inApp.markInteracted(messageId = messageId, ctaId = ctaId)
                promise.resolve(null)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "inAppMarkInteracted failed", e)
            }
        }
    }

    override fun inAppRefresh(promise: Promise) {
        scope.launch {
            try {
                Pyrx.inApp.refresh()
                promise.resolve(null)
            } catch (e: Throwable) {
                promise.reject("internal_error", e.message ?: "inAppRefresh failed", e)
            }
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /**
     * Serialize an [InAppMessage] to a [WritableMap] for emission on
     * `pyrx:in-app:received`. Re-encodes through kotlinx-serialization
     * to JSON first, then parses into a [WritableMap] via [Arguments]
     * — the alternative (hand-building the dict) would silently drift
     * from the InAppMessage data class as new fields land.
     *
     * Why two-step (Json string → JSONObject → WritableMap): RN
     * `Arguments` does not accept arbitrary `Map<String, Any>` —
     * fields must be put with type-specific `putString`/`putMap`/etc.
     * The JSON-object intermediate gives us a uniform recursive
     * walker that knows how to translate every JSON primitive.
     */
    private fun inAppMessageMap(message: InAppMessage): WritableMap {
        val jsonString = inAppJson.encodeToString(InAppMessage.serializer(), message)
        val jsonElement = json.parseToJsonElement(jsonString)
        return jsonElementToWritableMap(jsonElement.jsonObject)
    }

    /**
     * Recursive walker — kotlinx [JsonObject] → RN [WritableMap].
     * Nested arrays and objects recurse through
     * [jsonElementToWritableArray] / [jsonElementToWritableMap].
     */
    private fun jsonElementToWritableMap(obj: JsonObject): WritableMap {
        val out = Arguments.createMap()
        for ((k, v) in obj) {
            putJsonElement(out, k, v)
        }
        return out
    }

    private fun jsonElementToWritableArray(arr: List<JsonElement>): WritableArray {
        val out = Arguments.createArray()
        for (v in arr) {
            pushJsonElement(out, v)
        }
        return out
    }

    private fun putJsonElement(target: WritableMap, key: String, value: JsonElement) {
        when (value) {
            is JsonObject -> target.putMap(key, jsonElementToWritableMap(value))
            is JsonPrimitive -> when {
                value is JsonPrimitive && value.contentOrNull == null -> target.putNull(key)
                value.isString -> target.putString(key, value.content)
                value.boolOrNull != null -> target.putBoolean(key, value.boolean)
                value.intOrNull != null -> target.putInt(key, value.int)
                value.doubleOrNull != null -> target.putDouble(key, value.double)
                else -> target.putString(key, value.content)
            }
            else -> {
                try {
                    target.putArray(key, jsonElementToWritableArray(value.jsonArray))
                } catch (_: Throwable) {
                    target.putNull(key)
                }
            }
        }
    }

    private fun pushJsonElement(target: WritableArray, value: JsonElement) {
        when (value) {
            is JsonObject -> target.pushMap(jsonElementToWritableMap(value))
            is JsonPrimitive -> when {
                value.contentOrNull == null -> target.pushNull()
                value.isString -> target.pushString(value.content)
                value.boolOrNull != null -> target.pushBoolean(value.boolean)
                value.intOrNull != null -> target.pushInt(value.int)
                value.doubleOrNull != null -> target.pushDouble(value.double)
                else -> target.pushString(value.content)
            }
            else -> {
                try {
                    target.pushArray(jsonElementToWritableArray(value.jsonArray))
                } catch (_: Throwable) {
                    target.pushNull()
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Observer-event payload helpers (Phase 9.2.1)
    // ---------------------------------------------------------------------

    /**
     * Serialize a [PyrxPushReceivedEvent] to the JS shape declared in
     * `src/events.ts::PushReceivedEvent`. Used for both `pyrx:push:received`
     * and `pyrx:push:received-cold-start` — payload shape is identical;
     * only the dispatching event name differs.
     */
    private fun pushReceivedMap(event: PyrxPushReceivedEvent): WritableMap =
        Arguments.createMap().apply {
            putString("title", event.title)
            putString("body", event.body)
            putString("pushLogId", event.pushLogId)
            putMap("pyrxAttrs", jsonValueMapToWritable(event.pyrxAttributes))
            putMap("data", jsonValueMapToWritable(event.userInfo))
            putString("receivedAt", event.receivedAt.toString())
        }

    /**
     * Serialize a [PyrxPushClickedEvent] to the JS shape declared in
     * `src/events.ts::PushClickEvent`.
     */
    private fun pushClickedMap(event: PyrxPushClickedEvent): WritableMap =
        Arguments.createMap().apply {
            putString("pushLogId", event.pushLogId)
            event.deepLink?.let { putString("deepLink", it) } ?: putNull("deepLink")
            event.actionId?.let { putString("actionId", it) } ?: putNull("actionId")
            putMap("pyrxAttrs", jsonValueMapToWritable(event.pyrxAttributes))
            putString("clickedAt", event.clickedAt.toString())
        }

    /**
     * Serialize a [PyrxIdentitySnapshot] to the JS shape declared in
     * `src/events.ts::IdentitySnapshot`.
     *
     * Field rename: native `resolvedAt: Instant` → JS `snapshotAt: string`.
     * The wire shape uses `snapshotAt` to keep iOS/Android/JS symmetric
     * (the iOS field is `snapshotAt: Date`); we collapse the Android
     * `resolvedAt` spelling to the cross-platform name here.
     */
    private fun identitySnapshotMap(snap: PyrxIdentitySnapshot): WritableMap =
        Arguments.createMap().apply {
            snap.anonymousId?.let { putString("anonymousId", it) } ?: putNull("anonymousId")
            snap.externalId?.let { putString("externalId", it) } ?: putNull("externalId")
            putString("snapshotAt", snap.resolvedAt.toString())
        }

    /**
     * Lift a `Map<String, JSONValue>` (a.k.a. `PyrxAttributeValue`) into
     * a [WritableMap] for the JS bridge. Each leaf is converted to its
     * RN-bridge type: Null → JS null, Bool → boolean, Int → number,
     * Num (Double) → number, Str → string, Arr / Obj → recursed.
     */
    private fun jsonValueMapToWritable(map: Map<String, JSONValue>): WritableMap =
        Arguments.createMap().apply {
            for ((k, v) in map) {
                when (v) {
                    is JSONValue.Null -> putNull(k)
                    is JSONValue.Bool -> putBoolean(k, v.value)
                    is JSONValue.Int -> putDouble(k, v.value.toDouble())
                    is JSONValue.Num -> putDouble(k, v.value)
                    is JSONValue.Str -> putString(k, v.value)
                    is JSONValue.Arr -> putArray(k, jsonValueListToWritable(v.value))
                    is JSONValue.Obj -> putMap(k, jsonValueMapToWritable(v.value))
                }
            }
        }

    /** Companion to [jsonValueMapToWritable] for [JSONValue.Arr] payloads. */
    private fun jsonValueListToWritable(list: List<JSONValue>): WritableArray =
        Arguments.createArray().apply {
            for (v in list) {
                when (v) {
                    is JSONValue.Null -> pushNull()
                    is JSONValue.Bool -> pushBoolean(v.value)
                    is JSONValue.Int -> pushDouble(v.value.toDouble())
                    is JSONValue.Num -> pushDouble(v.value)
                    is JSONValue.Str -> pushString(v.value)
                    is JSONValue.Arr -> pushArray(jsonValueListToWritable(v.value))
                    is JSONValue.Obj -> pushMap(jsonValueMapToWritable(v.value))
                }
            }
        }

    /**
     * Convert an `IdentityResult` to the JS dict shape declared in
     * `NativePyrxSynapse.ts::SynapseIdentifyResult`.
     */
    private fun identityResultMap(result: tech.pyrx.synapse.identity.IdentityResult) =
        com.facebook.react.bridge.Arguments.createMap().apply {
            putString("contactId", result.contactId)
            putString("path", identifyPathWire(result.path))
            result.aliasedExternalId?.let { putString("aliasedExternalId", it) }
                ?: putNull("aliasedExternalId")
            putInt("eventsReattributed", result.eventsReattributed)
            putInt("devicesReattributed", result.devicesReattributed)
            putBoolean("anonymousContactTombstoned", result.anonymousContactTombstoned)
        }

    /**
     * Map the [tech.pyrx.synapse.network.IdentifyPath] enum to the wire
     * string the backend / iOS / JS consumers see (`"known_exists"` /
     * `"first_sighting"` / `"no_anonymous"`). The enum carries `@SerialName`
     * annotations for serialization but doesn't expose them via a `.value`
     * property — mapping here is the cheapest path that keeps a single
     * source of truth (the backend literal contract).
     */
    private fun identifyPathWire(path: tech.pyrx.synapse.network.IdentifyPath): String =
        when (path) {
            tech.pyrx.synapse.network.IdentifyPath.KNOWN_EXISTS   -> "known_exists"
            tech.pyrx.synapse.network.IdentifyPath.FIRST_SIGHTING -> "first_sighting"
            tech.pyrx.synapse.network.IdentifyPath.NO_ANONYMOUS   -> "no_anonymous"
        }

    /**
     * Decode a JSON-encoded object payload from JS into the
     * `Map<String, JSONValue>?` shape the Pyrx object accepts. Returns
     * null for nil / empty / invalid input — the SDK treats null
     * identically to "no traits".
     */
    private fun parseTraits(raw: String?): Map<String, JSONValue>? {
        if (raw.isNullOrEmpty()) return null
        val element = try {
            json.parseToJsonElement(raw)
        } catch (_: Throwable) {
            return null
        }
        val obj = (element as? JsonObject) ?: return null
        return obj.entries.associate { (k, v) -> k to toJSONValue(v) }
    }

    /**
     * Lift a kotlinx-serialization `JsonElement` into the SDK's
     * `JSONValue` sum. Mirrors the iOS toJSONValue helper.
     */
    private fun toJSONValue(el: JsonElement): JSONValue = when (el) {
        is JsonObject -> JSONValue.Obj(el.entries.associate { (k, v) -> k to toJSONValue(v) })
        is JsonPrimitive -> when {
            el.isString -> JSONValue.Str(el.content)
            el.boolOrNull != null -> JSONValue.Bool(el.boolean)
            el.intOrNull != null -> JSONValue.Int(el.int)
            el.doubleOrNull != null -> JSONValue.Num(el.double)
            el.contentOrNull == "null" -> JSONValue.Null
            else -> JSONValue.Str(el.content)
        }
        else -> {
            // JsonArray fall-through — the SDK's JSONValue.Arr expects a
            // List<JSONValue>; both kotlinx and the SDK use the same
            // ordering semantics.
            try {
                val arr = el.jsonArray
                JSONValue.Arr(arr.map { toJSONValue(it) })
            } catch (_: Throwable) {
                JSONValue.Null
            }
        }
    }

    /**
     * Map a typed `PyrxError` to the JS-visible error contract documented
     * in `NativePyrxSynapse.ts`.
     */
    private fun rejectWith(promise: Promise, error: PyrxError) {
        val code: String
        val message: String
        when (error) {
            is PyrxError.NotInitialized -> {
                code = "not_initialized"
                message = "Pyrx.initialize() has not been called yet"
            }
            is PyrxError.InvalidConfig -> {
                code = "invalid_argument"
                message = error.reason
            }
            is PyrxError.Network -> {
                code = "network_error"
                message = error.message ?: "network error"
            }
            is PyrxError.StorageFailure -> {
                code = "internal_error"
                message = error.message ?: "storage failure"
            }
            is PyrxError.AlreadyInitialized -> {
                code = "invalid_argument"
                message = "initialize already called with a different config"
            }
        }
        promise.reject(code, message, error)
    }
}
