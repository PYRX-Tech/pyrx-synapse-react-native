/**
 * @pyrx/synapse-react-native — Expo config plugin (entry).
 *
 * This is the customer-facing entry point. In a customer's `app.json` /
 * `app.config.ts`:
 *
 *     {
 *       "expo": {
 *         "plugins": ["@pyrx/synapse-react-native"]
 *       }
 *     }
 *
 * Or with options:
 *
 *     {
 *       "expo": {
 *         "plugins": [
 *           ["@pyrx/synapse-react-native", {
 *             "iosMode": "production",          // "production" | "development"
 *             "androidPostNotificationsPermission": true
 *           }]
 *         ]
 *       }
 *     }
 *
 * What this plugin does, top-level
 * --------------------------------
 * **iOS** (via withAppDelegate + withDangerousMod + withEntitlementsPlist + withInfoPlist):
 *   1. Edits the customer's `AppDelegate.swift` (SDK 53+) or
 *      `AppDelegate.mm` (SDK 52) to change its inheritance from
 *      `ExpoAppDelegate` / `RCTAppDelegate` → `PyrxSynapseAppDelegate`,
 *      adding the `PyrxSynapseRN` import. Customers with a custom
 *      AppDelegate parent must use the bare-install path (see
 *      docs/INSTALL-BARE.md).
 *   2. Adds `aps-environment` = "production" (or "development") to the
 *      iOS entitlements.
 *   3. Adds `UIBackgroundModes: ["remote-notification"]` to Info.plist.
 *
 * **Android** (via withAndroidManifest):
 *   1. Adds `POST_NOTIFICATIONS` permission (Android 13+).
 *
 *   Notably the plugin does NOT add a `<service>` entry for
 *   `PyrxMessagingService` — the published `synapse-push:0.1.3+` AAR
 *   already declares that service in its own manifest and Android's
 *   manifest merger picks it up automatically. (See
 *   `pyrx-synapse-android/synapse-push/src/main/AndroidManifest.xml`.)
 *
 * Notably NOT handled by this plugin
 * ----------------------------------
 * - `google-services.json` placement — this is a Firebase secret owned
 *   by the customer's Firebase console. The plugin documents where the
 *   customer puts it (`./google-services.json` at the project root, or
 *   referenced from `app.json` via `android.googleServicesFile`) but
 *   never bakes in a Firebase project ID.
 * - Firebase plugin registration — customers must add
 *   `@react-native-firebase/app` (or use Expo's Firebase tooling) per
 *   their own preference; the wrapper is FCM-agnostic at the JS layer.
 * - APNs key / team ID — these live in EAS Build secrets or the
 *   customer's App Store Connect account; the plugin only sets the
 *   `aps-environment` entitlement value.
 *
 * Failure modes
 * -------------
 * The plugin is conservative: if the AppDelegate file's structure isn't
 * what we expect (e.g., customer already has a non-standard parent
 * class), we throw a clear error rather than silently producing a
 * half-patched file. Customers see the failure during `expo prebuild`
 * and can switch to the bare-install path.
 */

import {
  type ConfigPlugin,
  withAppDelegate,
  withAndroidManifest,
  withEntitlementsPlist,
  withInfoPlist,
  AndroidConfig,
} from '@expo/config-plugins';

import { patchAppDelegateObjC, patchAppDelegateSwift } from './ios/appDelegate';

const { addPermission } = AndroidConfig.Permissions;

/**
 * Customer-facing options for the plugin.
 *
 * All fields are optional and have sensible defaults that work for the
 * majority of apps.
 */
export interface PyrxSynapsePluginOptions {
  /**
   * APNs environment for the iOS `aps-environment` entitlement.
   *
   * - `"development"` — uses APNs sandbox. Required for builds targeting
   *   the iOS simulator and for development-distribution / Ad Hoc
   *   builds installed on devices. Apple silently drops push to a
   *   wrongly-environmented build.
   * - `"production"` — uses APNs production. Required for App Store and
   *   TestFlight builds.
   *
   * Default: `"development"`. Customers must set `"production"` for
   * App Store / TestFlight EAS profiles.
   *
   * @see https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment
   */
  iosMode?: 'development' | 'production';

  /**
   * Whether to add `POST_NOTIFICATIONS` to the Android manifest.
   *
   * Android 13+ (API 33+) requires the host app to declare and request
   * this permission at runtime before pushes can be displayed. The
   * synapse-push AAR intentionally does NOT declare this in its own
   * manifest (so Play Store metadata correctly attributes it to the
   * host app, not to the SDK).
   *
   * Default: `true`. Set to `false` only if your app already declares
   * the permission elsewhere (e.g., via another notification library's
   * plugin).
   */
  androidPostNotificationsPermission?: boolean;
}

const PLUGIN_NAME = '@pyrx/synapse-react-native';

/**
 * The Expo config plugin entry point. Exported as the default export
 * so customers can reference the plugin by package name in app.json.
 */
const withPyrxSynapse: ConfigPlugin<PyrxSynapsePluginOptions | void> = (
  config,
  options
) => {
  const opts: Required<PyrxSynapsePluginOptions> = {
    iosMode: options?.iosMode ?? 'development',
    androidPostNotificationsPermission:
      options?.androidPostNotificationsPermission ?? true,
  };

  // ---- iOS ----
  // 1. AppDelegate inheritance swap. Handles both Swift (SDK 53+) and
  //    ObjC (SDK 52) AppDelegates; throws if the file shape isn't
  //    recognized.
  config = withAppDelegate(config, (mod) => {
    const { contents, language } = mod.modResults;
    if (language === 'swift') {
      mod.modResults.contents = patchAppDelegateSwift(contents, PLUGIN_NAME);
    } else if (language === 'objc' || language === 'objcpp') {
      mod.modResults.contents = patchAppDelegateObjC(contents, PLUGIN_NAME);
    } else {
      // Defensive: future Expo AppDelegate languages should be added
      // explicitly rather than silently passed through.
      throw new Error(
        `[${PLUGIN_NAME}] Unsupported AppDelegate language: ${String(
          language
        )}. ` +
          `Either upgrade @pyrx/synapse-react-native or switch to the bare-install path ` +
          `(docs/INSTALL-BARE.md).`
      );
    }
    return mod;
  });

  // 2. APNs entitlement.
  config = withEntitlementsPlist(config, (mod) => {
    mod.modResults['aps-environment'] = opts.iosMode;
    return mod;
  });

  // 3. UIBackgroundModes — required for silent / background push and
  //    background fetch result completion. We add `remote-notification`
  //    idempotently (don't duplicate if already present).
  config = withInfoPlist(config, (mod) => {
    const existing = (mod.modResults.UIBackgroundModes as string[]) ?? [];
    if (!existing.includes('remote-notification')) {
      mod.modResults.UIBackgroundModes = [...existing, 'remote-notification'];
    }
    return mod;
  });

  // ---- Android ----
  if (opts.androidPostNotificationsPermission) {
    config = withAndroidManifest(config, (mod) => {
      addPermission(mod.modResults, 'android.permission.POST_NOTIFICATIONS');
      return mod;
    });
  }

  return config;
};

export default withPyrxSynapse;
