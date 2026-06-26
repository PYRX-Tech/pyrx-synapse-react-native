/**
 * Expo config for the Synapse RN demo app.
 *
 * Demonstrates how a customer wires the `@pyrx/synapse-react-native`
 * config plugin into their Expo project. Two things this file is
 * showing off:
 *
 *   1. The plugin reference in `plugins` is the package name
 *      (`@pyrx/synapse-react-native`). Expo resolves the package's
 *      `app.plugin.js` automatically; customers don't need to touch
 *      the `plugin/build/` path.
 *
 *   2. Plugin options are passed as the second tuple element. Here
 *      we use `iosMode: "development"` because this sample is meant
 *      for dev devices / simulator; for an App Store / TestFlight
 *      build, customers would switch to `"production"` (typically via
 *      an EAS profile-specific config override).
 *
 * Customers using the sample as a starting point should change:
 *   - `name`, `slug`, `bundleIdentifier`, `package`
 *   - `extra.pyrxWorkspaceId` and `extra.pyrxApiKey` (or wire them
 *     via env vars per their team's secrets policy)
 *   - `ios.entitlements` — the plugin handles `aps-environment`, but
 *     customers may need additional entitlements
 *   - `android.googleServicesFile` — point at your real
 *     `google-services.json`
 */

import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Synapse RN Demo',
  slug: 'synapse-rn-demo',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,

  ios: {
    bundleIdentifier: 'tech.pyrx.synapse.rndemo',
    supportsTablet: true,
    // Plugin manages `aps-environment` and `UIBackgroundModes`.
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },

  android: {
    package: 'tech.pyrx.synapse.rndemo',
    // Customers MUST provide their own google-services.json. We
    // intentionally do not ship a stub — Firebase project IDs are
    // workspace-specific and baking one in would mislead.
    //
    // Place your google-services.json at the project root and
    // uncomment the next line:
    // googleServicesFile: './google-services.json',
  },

  plugins: [
    [
      '@pyrx/synapse-react-native',
      {
        // Use 'production' for App Store / TestFlight; 'development'
        // for simulator and EAS development profile.
        iosMode: 'development',
        // Adds POST_NOTIFICATIONS to the Android manifest. Set to false
        // only if another plugin already declares it.
        androidPostNotificationsPermission: true,
      },
    ],
  ],

  extra: {
    // Surfaced to the JS layer via Constants.expoConfig.extra.
    // Override via EAS environment variables in production builds.
    pyrxWorkspaceId: process.env.EXPO_PUBLIC_PYRX_WORKSPACE_ID ?? '',
    pyrxApiKey: process.env.EXPO_PUBLIC_PYRX_API_KEY ?? '',
    pyrxEnvironment:
      (process.env.EXPO_PUBLIC_PYRX_ENVIRONMENT as 'production' | 'sandbox') ??
      'sandbox',
  },
};

export default config;
