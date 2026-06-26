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
 *   service from the synapse-push module). The plugin (PR-3) registers
 *   it in the customer's AndroidManifest.xml; bare-RN customers add
 *   one entry by hand. The JS layer never sees the token.
 * - Cold-start push attribution — captured by MainActivity.onCreate
 *   on the customer side (one-line `Pyrx.recordColdStartLaunch(intent)`
 *   call). PR-3 sample app demonstrates the wiring.
 * - handleNotificationTap — fired natively from MainActivity.onNewIntent
 *   by the customer; the resulting `pyrx:push:click` event surfaces
 *   to JS via the NativeEventEmitter (wired in PR-2).
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
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import tech.pyrx.synapse.LogLevel
import tech.pyrx.synapse.Pyrx
import tech.pyrx.synapse.PyrxConfig
import tech.pyrx.synapse.PyrxEnvironment
import tech.pyrx.synapse.PyrxError
import tech.pyrx.synapse.network.JSONValue
import java.util.UUID

class PyrxSynapseModule(reactContext: ReactApplicationContext) :
    NativePyrxSynapseSpec(reactContext) {

    private val appContext: ReactApplicationContext = reactContext

    /** SupervisorJob so a failed dispatch doesn't cancel sibling work. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Bookkeeping for the NativeEventEmitter symmetry contract. */
    private var listenerCount: Int = 0

    /**
     * Pending push-permission result. Set when JS calls
     * `requestPushPermission()` on API 33+ and the OS dialog is
     * launched; consumed in [onRequestPermissionsResult] (wired below
     * via the PermissionAwareActivity hook).
     */
    private var pendingPushPermissionPromise: Promise? = null

    private val json = Json { ignoreUnknownKeys = true }

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
    // NativeEventEmitter symmetry
    // ---------------------------------------------------------------------

    override fun addListener(eventType: String) {
        listenerCount += 1
    }

    override fun removeListeners(count: Double) {
        listenerCount = maxOf(0, listenerCount - count.toInt())
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

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
