import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { getAccountIdSync, onAccountIdentityChanged } from "../lib/db-tx";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { formatTimestamp } from "../lib/format";
import { t } from "../lib/i18n";
import type { PersonalCloudProviderId, PersonalCloudStatus } from "../lib/personal-cloud-backup";
import { radius, space, TOUCH_MIN, typography } from "../lib/tokens";
import { Button } from "./Button";
import { useToast } from "./Toast";

type BackupService = typeof import("../lib/personal-cloud-backup");
type SetupView = {
  scope: number;
  accountId: string | null;
  destinations: PersonalCloudProviderId[];
  statuses: Partial<Record<PersonalCloudProviderId, PersonalCloudStatus>>;
  service: BackupService;
};

function destinationLabel(id: PersonalCloudProviderId) {
  return t(id === "icloudDrive" ? "backups.icloudDrive" : "backups.googleDrive");
}

function setupError(code: string | undefined, id: PersonalCloudProviderId) {
  switch (code) {
    case "empty":
      return t("backups.autoBackupEmpty");
    case "busy":
      return t("backups.error.busy");
    case "offline":
      return t("backups.providerOffline");
    case "reconnect":
      return t(id === "icloudDrive" ? "backups.icloudUnavailable" : "backups.reconnectHint");
    case "sessionChanged":
      return t("backups.error.sessionChanged");
    default:
      return t("backups.providerError");
  }
}

function backupStatus(id: PersonalCloudProviderId, status: PersonalCloudStatus) {
  if (status.running) return t("backups.backingUp");
  if (status.error) return setupError(status.error, id);
  if (!status.savedAt) return t("backups.noBackupYet");
  return t(status.pending ? "backups.backupQueued" : "backups.lastBackup", {
    when: formatTimestamp(status.savedAt),
  });
}

/** Lets the user choose an automatic backup destination without opening Settings. */
export function PersonalBackupSetup({
  placement = "home",
  onDismiss,
  onOfferChange,
  onConnectingChange,
  disabled = false,
}: {
  placement?: "home" | "onboarding";
  onDismiss?: () => void;
  onOfferChange?: (visible: boolean) => void;
  onConnectingChange?: (connecting: boolean) => void;
  disabled?: boolean;
}) {
  const rtl = useIsRTL();
  const { push: pushToast } = useToast();
  const scope = useRef(0);
  const mounted = useRef(true);
  const operation = useRef(false);
  const [view, setView] = useState<SetupView | null>(null);
  const [connecting, setConnecting] = useState<PersonalCloudProviderId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useFocusEffect(useCallback(() => {
    if (Platform.OS !== "android" && Platform.OS !== "ios") return;
    let active = true;
    let readVersion = 0;
    let stopIdentity: (() => void) | undefined;
    let stopStatus: (() => void) | undefined;
    scope.current++;
    setView(null);
    setNotice(null);

    void import("../lib/personal-cloud-backup").then((service) => {
      if (!active) return;
      const candidates: PersonalCloudProviderId[] =
        Platform.OS === "ios" ? ["icloudDrive", "googleDrive"] : ["googleDrive"];
      const destinations = candidates.filter(service.isPersonalCloudBackupSupported);
      if (!destinations.length) return;

      async function refresh() {
        const requestedScope = scope.current;
        const accountId = getAccountIdSync();
        const version = ++readVersion;
        try {
          const statuses = await service.readPersonalCloudBackupStatuses();
          const available = placement === "home" || destinations.some((id) => statuses[id]) ||
            await service.shouldOfferPersonalCloudBackup(accountId);
          if (active && scope.current === requestedScope && readVersion === version &&
              getAccountIdSync() === accountId) {
            setView(available ? { scope: requestedScope, accountId, destinations, statuses, service } : null);
          }
        } catch {
          if (active && scope.current === requestedScope && readVersion === version) setView(null);
        }
      }

      stopIdentity = onAccountIdentityChanged(() => {
        scope.current++;
        setView(null);
        setNotice(null);
        void refresh();
      });
      stopStatus = service.subscribePersonalCloudBackup(() => void refresh());
      void refresh();
    }).catch(() => {});

    return () => {
      active = false;
      scope.current++;
      stopIdentity?.();
      stopStatus?.();
    };
  }, [placement]));

  const connected = view?.destinations.find((id) => view.statuses[id]);
  const offerVisible = !!view && !connected && view.scope === scope.current &&
    view.accountId === getAccountIdSync();
  useEffect(() => {
    onOfferChange?.(offerVisible);
  }, [offerVisible, onOfferChange]);

  async function connect(id: PersonalCloudProviderId) {
    if (!view || view.scope !== scope.current || view.accountId !== getAccountIdSync() ||
        disabled || operation.current ||
        AppState.currentState !== "active") return;
    const { scope: started, service } = view;
    operation.current = true;
    setConnecting(id);
    onConnectingChange?.(true);
    setNotice(null);
    try {
      // Cancellation returns false. A confirmed connection publishes status
      // through the same service used by the scheduler and Backups screen.
      const enabled = await service.enablePersonalCloudBackup(id, view.accountId);
      if (enabled && placement === "home" && mounted.current &&
          scope.current === started && view.accountId === getAccountIdSync()) {
        pushToast(t("backups.automaticOn"), "success");
      }
    } catch (error) {
      if (mounted.current && scope.current === started) {
        const code = error instanceof service.PersonalBackupError ||
          error instanceof service.PersonalCloudProviderError
          ? error.code
          : undefined;
        setNotice(setupError(code, id));
      }
    } finally {
      operation.current = false;
      if (mounted.current) {
        setConnecting(null);
        onConnectingChange?.(false);
      }
    }
  }

  if (!view || view.scope !== scope.current) return null;
  if (connected) {
    if (placement === "home") return null;
    const status = view.statuses[connected]!;
    return (
      <View style={[styles.card, styles.onboardingCard]} accessibilityLiveRegion="polite">
        <Text style={[styles.title, textDir(rtl)]}>
          {t(status.error === "reconnect" ? "backups.automaticPaused" : "backups.automaticOn")}
        </Text>
        <Text style={[styles.body, textDir(rtl)]}>{destinationLabel(connected)}</Text>
        <Text style={[styles.hint, textDir(rtl)]}>{backupStatus(connected, status)}</Text>
      </View>
    );
  }

  const unavailable = disabled || connecting !== null;
  return (
    <View style={[styles.card, placement === "onboarding" ? styles.onboardingCard : styles.homeCard]}>
      <View style={[styles.heading, rowDir(rtl)]}>
        <Text style={[styles.title, styles.headingTitle, textDir(rtl)]}>{t("backups.setup.title")}</Text>
        {onDismiss ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            accessibilityState={{ disabled: unavailable }}
            disabled={unavailable}
            onPress={() => {
              if (view.scope === scope.current && view.accountId === getAccountIdSync() &&
                  !operation.current) onDismiss();
            }}
            style={styles.dismiss}
          >
            <Ionicons name="close" size={20} color={colors.textSubtle} />
          </Pressable>
        ) : null}
      </View>
      <Text style={[styles.body, textDir(rtl)]}>{t("backups.setup.body")}</Text>
      <Text style={[styles.hint, textDir(rtl)]}>{t("backups.readableBackup")}</Text>
      <View style={styles.actions}>
        {view.destinations.map((id, index) => (
          <Button
            key={id}
            label={t("backups.connect", { destination: destinationLabel(id) })}
            icon={id === "icloudDrive" ? "logo-apple" : "logo-google"}
            variant={placement === "home" && index === 0 ? "primary" : "secondary"}
            loading={connecting === id}
            disabled={unavailable}
            onPress={() => void connect(id)}
            showLabelWhileLoading
            wrapLabel
            fullWidth
          />
        ))}
      </View>
      {notice ? (
        <Text style={[styles.error, textDir(rtl)]} accessibilityLiveRegion="polite">{notice}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgMuted,
  },
  onboardingCard: { marginTop: space.md },
  homeCard: { marginHorizontal: 16, marginBottom: 12 },
  heading: { alignItems: "center", gap: space.sm },
  headingTitle: { flex: 1, minWidth: 0 },
  title: { ...typography.labelBold, color: colors.textEmphasis, flexShrink: 1 },
  body: { ...typography.bodySm, color: colors.textSubtle },
  hint: { ...typography.caption, color: colors.textMuted },
  error: { ...typography.caption, color: colors.danger },
  actions: { gap: space.sm, marginTop: space.sm },
  dismiss: {
    width: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
