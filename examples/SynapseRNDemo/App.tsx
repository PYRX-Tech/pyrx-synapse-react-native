/**
 * Synapse RN Demo — root component.
 *
 * Wires up <SynapseProvider> with credentials sourced from
 * `app.config.ts` `extra` (which in turn reads EXPO_PUBLIC_PYRX_*
 * env vars). Customers using this sample as a starting point can
 * substitute their own credential-loading strategy.
 *
 * The actual UI lives in `src/HomeScreen.tsx` — keeping App.tsx tiny
 * makes the provider wiring obvious and isolates the customer-edit
 * points (config) from the demonstration logic.
 */

import { SynapseProvider } from '@pyrx/synapse-react-native';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import HomeScreen from './src/HomeScreen';

const extra = (Constants.expoConfig?.extra ?? {}) as {
  pyrxWorkspaceId?: string;
  pyrxApiKey?: string;
  pyrxEnvironment?: 'production' | 'sandbox';
};

const workspaceId = extra.pyrxWorkspaceId ?? '';
const apiKey = extra.pyrxApiKey ?? '';
const environment = extra.pyrxEnvironment ?? 'sandbox';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <SynapseProvider
        config={{
          workspaceId,
          apiKey,
          environment,
          logLevel: 'info',
        }}
        onError={(err) => {
          // In a real app, surface this through your error reporter.
          console.warn('[SynapseRNDemo] init error', err.code, err.message);
        }}
      >
        <HomeScreen />
      </SynapseProvider>
    </SafeAreaProvider>
  );
}
