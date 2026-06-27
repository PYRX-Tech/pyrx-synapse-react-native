/**
 * HomeScreen — the demo's single screen.
 *
 * Goal: demonstrate every public surface of `@pyrx/synapse-react-native`
 * in one screen that a customer can read top-to-bottom and copy from.
 * Intentionally NOT styled beyond default RN primitives so the SDK
 * usage is visually unobscured.
 *
 * What this screen shows:
 *   1. Provider lifecycle state (`useSynapse().status`, `error`).
 *   2. Identity flow (`useIdentify`).
 *   3. Identity-change banner (`useIdentityChanged`, new in 0.2.0).
 *   4. Event tracking (`useSynapse().track`).
 *   5. Push permission flow (`usePushPermission`).
 *   6. Foreground push receipt (`usePushReceived`).
 *   7. Cold-start push route (`usePushReceivedColdStart`, new in 0.2.0).
 *   8. Push click + deep link handling (`useDeepLink`).
 *   9. Debug info inspection (`useSynapse().debugInfo`).
 *
 * Anti-patterns this screen deliberately avoids:
 *   - Showing a notification permission prompt on mount (Apple rejects
 *     apps that do this — the prompt must be tied to a user gesture
 *     that explains the value).
 *   - Auto-calling Linking.openURL from useDeepLink without giving
 *     the customer a visible "Open" button (a real app would route
 *     silently; this demo surfaces the link so customers see the
 *     handoff).
 *   - Hardcoding workspace credentials (they come from app.config.ts).
 */

import {
  useDeepLink,
  useIdentify,
  useIdentityChanged,
  usePushPermission,
  usePushReceived,
  usePushReceivedColdStart,
  useSynapse,
  type IdentityChangedEvent,
  type PushReceivedColdStartEvent,
} from '@pyrx/synapse-react-native';
import * as Linking from 'expo-linking';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const {
    status,
    error,
    debugInfo,
    anonymousId,
    queueDepth,
    refreshDebugInfo,
    track,
  } = useSynapse();
  const { identify, logout, isIdentified, externalId } = useIdentify();
  const {
    status: pushStatus,
    isPending: pushPending,
    request,
    refresh,
  } = usePushPermission();
  const { lastPushClick, clear: clearClick } = useDeepLink();

  // ---- Identify form ----
  const [externalIdInput, setExternalIdInput] = useState('demo-user-1');
  const [emailInput, setEmailInput] = useState('demo@pyrx.tech');

  const handleIdentify = useCallback(async () => {
    try {
      await identify(externalIdInput, { email: emailInput });
      Alert.alert('Identified', `Linked to ${externalIdInput}`);
    } catch (err) {
      Alert.alert('Identify failed', String(err));
    }
  }, [identify, externalIdInput, emailInput]);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
      Alert.alert('Logged out', 'Identity cleared');
    } catch (err) {
      Alert.alert('Logout failed', String(err));
    }
  }, [logout]);

  // ---- Event tracking ----
  const [eventCount, setEventCount] = useState(0);

  const handleTrack = useCallback(async () => {
    try {
      const n = eventCount + 1;
      await track('demo.button.pressed', {
        ordinal: n,
        platform: 'react-native',
      });
      setEventCount(n);
    } catch (err) {
      Alert.alert('Track failed', String(err));
    }
  }, [track, eventCount]);

  // ---- Push permission ----
  const handleRequestPush = useCallback(async () => {
    try {
      const next = await request({ alert: true, sound: true, badge: true });
      if (next === 'denied') {
        Alert.alert(
          'Push denied',
          'You can change this in Settings → Notifications.'
        );
      }
    } catch (err) {
      Alert.alert('Push permission failed', String(err));
    }
  }, [request]);

  // ---- Foreground push receipt ----
  const [receivedTitle, setReceivedTitle] = useState<string | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);

  usePushReceived((event) => {
    setReceivedTitle(event.title || '(no title)');
    setReceivedAt(Date.now());
  });

  // ---- Cold-start push (NEW in 0.2.0) ----
  // Distinct from useDeepLink because cold-start launches need to wait
  // for navigation to mount. The native SDKs replay the most-recent 4
  // events for late subscribers, so this hook reliably catches the
  // cold-start payload even when the JS bridge mounts after the OS
  // delivered the tap.
  const [coldStartPush, setColdStartPush] =
    useState<PushReceivedColdStartEvent | null>(null);

  usePushReceivedColdStart((event) => {
    setColdStartPush(event);
  });

  // ---- Identity change banner (NEW in 0.2.0) ----
  // Dashboard-style apps use this to refetch user data on login state
  // change without polling useIdentify in a useEffect. We surface a
  // short-lived banner showing the most recent transition so the
  // customer can see the hook actually fired.
  const [lastIdentityEvent, setLastIdentityEvent] =
    useState<IdentityChangedEvent | null>(null);

  useIdentityChanged((event) => {
    setLastIdentityEvent(event);
  });

  // ---- Deep link handling ----
  const handleOpenDeepLink = useCallback(() => {
    if (lastPushClick?.deepLink) {
      // Linking.openURL returns a Promise — we don't await here because
      // the URL handoff to the OS is fire-and-forget from the app's
      // perspective.
      Linking.openURL(lastPushClick.deepLink).catch((err) => {
        Alert.alert('Open URL failed', String(err));
      });
      clearClick();
    }
  }, [lastPushClick, clearClick]);

  // ---- Debug snapshot tick ----
  // Refresh the debugInfo snapshot every 5s so the displayed queue
  // depth and anonymous id stay roughly current. In a real app you'd
  // only call this on-demand from a debug screen.
  useEffect(() => {
    const id = setInterval(() => {
      // Fire-and-forget — failures here are non-actionable for the user.
      refreshDebugInfo().catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, [refreshDebugInfo]);

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top + 12 }]}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.h1}>PYRX Synapse RN Demo</Text>

      <Section title="SDK Status">
        <KV k="status" v={status} />
        <KV k="error" v={error ? `${error.code}: ${error.message}` : '—'} />
        <KV k="anonymousId" v={anonymousId ?? '—'} />
        <KV k="externalId" v={externalId ?? '—'} />
        <KV k="queueDepth" v={String(queueDepth)} />
        <KV k="sdkVersion" v={debugInfo?.sdkVersion ?? '—'} />
      </Section>

      <Section title="Identity">
        <Text style={styles.label}>External ID</Text>
        <TextInput
          style={styles.input}
          value={externalIdInput}
          onChangeText={setExternalIdInput}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isIdentified}
        />
        <Text style={styles.label}>Email (trait)</Text>
        <TextInput
          style={styles.input}
          value={emailInput}
          onChangeText={setEmailInput}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isIdentified}
        />
        <View style={styles.row}>
          <Button
            title="Identify"
            disabled={status !== 'initialized' || isIdentified}
            onPress={handleIdentify}
          />
          <Button
            title="Logout"
            disabled={!isIdentified}
            onPress={handleLogout}
          />
        </View>
      </Section>

      <Section title="Identity change (useIdentityChanged, 0.2.0)">
        {lastIdentityEvent ? (
          <>
            <KV
              k="transition"
              v={describeIdentityTransition(lastIdentityEvent)}
            />
            <KV
              k="before.externalId"
              v={lastIdentityEvent.before?.externalId ?? '— (none)'}
            />
            <KV
              k="after.externalId"
              v={lastIdentityEvent.after.externalId ?? '— (logged out)'}
            />
            <Pressable onPress={() => setLastIdentityEvent(null)}>
              <Text style={styles.dismiss}>Dismiss</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.muted}>
            No identity transitions yet. Hit Identify or Logout above to
            trigger one — the hook fires once per successful identify /
            alias / logout.
          </Text>
        )}
      </Section>

      <Section title="Events">
        <Text style={styles.label}>
          Sent {eventCount} demo event{eventCount === 1 ? '' : 's'}
        </Text>
        <Button
          title="Track demo.button.pressed"
          disabled={status !== 'initialized'}
          onPress={handleTrack}
        />
      </Section>

      <Section title="Push permission">
        <KV k="status" v={pushStatus} />
        <KV k="isPending" v={String(pushPending)} />
        <View style={styles.row}>
          <Button
            title="Request push"
            disabled={pushPending}
            onPress={handleRequestPush}
          />
          <Button
            title="Re-read"
            disabled={pushPending}
            onPress={() => refresh()}
          />
        </View>
      </Section>

      <Section title="Foreground push receipt">
        {receivedTitle ? (
          <>
            <KV k="title" v={receivedTitle} />
            <KV
              k="receivedAt"
              v={receivedAt ? new Date(receivedAt).toLocaleTimeString() : '—'}
            />
            <Pressable onPress={() => setReceivedTitle(null)}>
              <Text style={styles.dismiss}>Dismiss</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.muted}>
            None received yet. Send a push from the PYRX dashboard with this app
            in the foreground.
          </Text>
        )}
      </Section>

      <Section title="Cold-start push (usePushReceivedColdStart, 0.2.0)">
        {coldStartPush ? (
          <>
            <KV k="title" v={coldStartPush.title || '(no title)'} />
            <KV k="pushLogId" v={coldStartPush.pushLogId ?? '—'} />
            <KV
              k="deep_link"
              v={
                (coldStartPush.pyrxAttrs?.deep_link as string | undefined) ??
                '—'
              }
            />
            <KV k="receivedAt" v={coldStartPush.receivedAt} />
            <Text style={styles.muted}>
              Fired because the OS launched the app from a notification
              tap. usePushClicked does NOT fire for this payload (native
              dedup).
            </Text>
            <Pressable onPress={() => setColdStartPush(null)}>
              <Text style={styles.dismiss}>Dismiss</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.muted}>
            No cold-start push yet. Fully terminate the app (swipe up to
            kill, NOT just background), then tap a notification from the
            tray — the OS will launch the app and this section will
            populate.
          </Text>
        )}
      </Section>

      <Section title="Push click / deep link">
        {lastPushClick ? (
          <>
            <KV k="pushLogId" v={lastPushClick.pushLogId} />
            <KV k="deepLink" v={lastPushClick.deepLink ?? '—'} />
            <KV k="actionId" v={lastPushClick.actionId ?? '—'} />
            {lastPushClick.deepLink ? (
              <Button title="Open deep link" onPress={handleOpenDeepLink} />
            ) : null}
            <Button title="Clear" onPress={clearClick} />
          </>
        ) : (
          <Text style={styles.muted}>
            No clicks yet. Tap a push notification to see its payload here.
          </Text>
        )}
      </Section>

      <View style={{ height: insets.bottom + 24 }} />
    </ScrollView>
  );
}

// ----------------------------------------------------------------------
// Tiny presentational helpers — kept inline to keep the demo single-file
// ----------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>{title}</Text>
      {children}
    </View>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvKey}>{k}</Text>
      <Text style={styles.kvVal} numberOfLines={2}>
        {v}
      </Text>
    </View>
  );
}

/**
 * Map an IdentityChangedEvent payload to a human-readable label. Used
 * only by the demo's identity-change banner. Mirrors the consumer-
 * side classification logic documented in the `useIdentityChanged`
 * JSDoc — kept inline so customers can copy this directly.
 */
function describeIdentityTransition(event: IdentityChangedEvent): string {
  const beforeId = event.before?.externalId ?? null;
  const afterId = event.after.externalId ?? null;
  if (event.before === null) return 'first identify (fresh install)';
  if (beforeId === null && afterId !== null) return 'login';
  if (beforeId !== null && afterId === null) return 'logout';
  if (beforeId !== null && afterId !== null && beforeId !== afterId) {
    return `user switch (${beforeId} → ${afterId})`;
  }
  return 'no-op (same identity)';
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  content: { padding: 16, gap: 16 },
  h1: { fontSize: 22, fontWeight: '700' },
  h2: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  section: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  label: { fontSize: 13, color: '#555' },
  input: {
    borderWidth: 1,
    borderColor: '#cccccc',
    borderRadius: 6,
    padding: 8,
    fontSize: 14,
    backgroundColor: '#fafafa',
  },
  kv: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
  },
  kvKey: { fontSize: 13, color: '#666', fontWeight: '500' },
  kvVal: { fontSize: 13, color: '#111', flexShrink: 1, textAlign: 'right' },
  muted: { fontSize: 13, color: '#888' },
  dismiss: { color: '#0066cc', marginTop: 8 },
});
