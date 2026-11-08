import { CameraView, useCameraPermissions } from "expo-camera";
import * as Network from "expo-network";
import { useIsFocused, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import QRCode from "react-native-qrcode-svg";
import { Button } from "../../components/Button";
import { PeopleScreen } from "../../components/PeopleScreen";
import { ScreenHeader } from "../../components/SettingsScreen";
import { applyForCurrentSession, captureCurrentSession, fetchAccountMe } from "../../lib/auth";
import { colors } from "../../lib/colors";
import { getSessionAccountIdSync, onAccountIdentityChanged } from "../../lib/db-tx";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { t } from "../../lib/i18n";
import { decodePeopleQr, encodePeopleQr } from "../../lib/people-qr";
import { radius, typography } from "../../lib/tokens";

function subscribeToAppState(notify: () => void) {
  const subscription = AppState.addEventListener("change", notify);
  return () => subscription.remove();
}

const getAppState = () => AppState.currentState;

export default function PeopleQrScreen() {
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const [scanning, setScanning] = useState(mode === "scan");
  const rtl = useIsRTL();
  const focused = useIsFocused();
  const foreground =
    useSyncExternalStore(subscribeToAppState, getAppState, getAppState) === "active";
  const accountId = useSyncExternalStore(
    onAccountIdentityChanged,
    getSessionAccountIdSync,
    getSessionAccountIdSync,
  );
  const network = Network.useNetworkState();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  return (
    <PeopleScreen>
      <ScreenHeader
        title={t("peopleQr.title")}
        isRTL={rtl}
        onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {!accountId ? (
          <View style={styles.panel}>
            <QrMessage rtl={rtl}>{t("peopleProfile.signIn")}</QrMessage>
            <Button
              label={t("peopleProfile.signInAction")}
              onPress={() => router.replace("/sign-in")}
            />
          </View>
        ) : (
          <>
            <View style={[styles.modes, rowDir(rtl)]}>
              <View style={styles.mode}>
                <Button
                  label={t("peopleQr.myCode")}
                  variant={scanning ? "secondary" : "primary"}
                  wrapLabel
                  icon="qr-code-outline"
                  onPress={() => setScanning(false)}
                />
              </View>
              <View style={styles.mode}>
                <Button
                  label={t("peopleQr.scanCode")}
                  variant={scanning ? "primary" : "secondary"}
                  wrapLabel
                  icon="scan-outline"
                  onPress={() => setScanning(true)}
                />
              </View>
            </View>
            {offline ? (
              <QrMessage rtl={rtl}>{t("peopleProfile.offline")}</QrMessage>
            ) : focused && foreground ? (
              scanning ? (
                <PeopleQrScanner key={accountId} accountId={accountId} rtl={rtl} />
              ) : (
                <MyPeopleQr key={accountId} accountId={accountId} rtl={rtl} />
              )
            ) : null}
          </>
        )}
      </ScrollView>
    </PeopleScreen>
  );
}

function MyPeopleQr({ accountId, rtl }: { accountId: string; rtl: boolean }) {
  const { width } = useWindowDimensions();
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "visible" | "hidden" | "failed">("loading");
  const code = encodePeopleQr(accountId);

  useEffect(() => {
    let alive = true;
    const current = () => alive && getSessionAccountIdSync() === accountId;
    if (!code) return;
    void (async () => {
      const session = await captureCurrentSession();
      if (!current() || session.accountId !== accountId) return;
      const { discoveryEnabled } = await fetchAccountMe(session);
      await applyForCurrentSession(session, async () => {
        if (current()) setStatus(discoveryEnabled ? "visible" : "hidden");
      });
    })().catch(() => {
      if (current()) setStatus("failed");
    });
    return () => {
      alive = false;
    };
  }, [accountId, attempt, code]);

  if (!code) return <QrMessage rtl={rtl}>{t("peopleQr.loadFailed")}</QrMessage>;
  if (status === "loading") return <ActivityIndicator color={colors.textEmphasis} />;
  if (status === "hidden") return <QrMessage rtl={rtl}>{t("peopleQr.hidden")}</QrMessage>;
  if (status === "failed")
    return (
      <View style={styles.panel}>
        <QrMessage rtl={rtl} alert>
          {t("peopleQr.loadFailed")}
        </QrMessage>
        <Button
          label={t("peopleProfile.retry")}
          variant="secondary"
          onPress={() => {
            setStatus("loading");
            setAttempt((value) => value + 1);
          }}
        />
      </View>
    );
  return (
    <View style={styles.panel}>
      <View accessible accessibilityRole="image" accessibilityLabel={t("peopleQr.codeLabel")}>
        <QRCode
          value={code}
          size={Math.min(224, width - 80)}
          quietZone={16}
          color="#000000"
          backgroundColor="#ffffff"
        />
      </View>
      <QrMessage rtl={rtl}>{t("peopleQr.showHint")}</QrMessage>
    </View>
  );
}

function PeopleQrScanner({ accountId, rtl }: { accountId: string; rtl: boolean }) {
  const navigation = useNavigation();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [issue, setIssue] = useState<
    "peopleQr.invalid" | "peopleQr.own" | "peopleQr.cameraFailed" | null
  >(null);
  const mounted = useRef(false);
  const handled = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const claimScan = () => {
    if (
      handled.current ||
      !mounted.current ||
      !navigation.isFocused() ||
      getSessionAccountIdSync() !== accountId ||
      AppState.currentState !== "active"
    )
      return false;
    handled.current = true;
    return true;
  };

  if (issue)
    return (
      <View style={styles.panel}>
        <QrMessage rtl={rtl} alert>
          {t(issue)}
        </QrMessage>
        <Button
          label={t("peopleQr.scanAgain")}
          variant="secondary"
          onPress={() => {
            handled.current = false;
            setIssue(null);
          }}
        />
      </View>
    );
  if (!permission) return <ActivityIndicator color={colors.textEmphasis} />;
  if (!permission.granted)
    return (
      <View style={styles.panel}>
        <QrMessage rtl={rtl}>{t("peopleQr.cameraHint")}</QrMessage>
        <Button
          label={t(
            permission.canAskAgain
              ? "vaultPairScan.permission.allow"
              : "settings.appLock.openSettings",
          )}
          onPress={() => {
            const request = permission.canAskAgain ? requestPermission() : Linking.openSettings();
            void request.catch(() => {
              if (mounted.current) setIssue("peopleQr.cameraFailed");
            });
          }}
        />
      </View>
    );
  return (
    <View style={styles.panel}>
      <View style={styles.cameraFrame}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onMountError={() => {
            if (claimScan()) setIssue("peopleQr.cameraFailed");
          }}
          onBarcodeScanned={({ data }) => {
            if (!claimScan()) return;
            const person = decodePeopleQr(data);
            if (!person) {
              setIssue("peopleQr.invalid");
            } else if (person === accountId) {
              setIssue("peopleQr.own");
            } else {
              // The profile still resolves visibility on the server and offers Add friend.
              router.replace({ pathname: "/people/[accountId]", params: { accountId: person } });
            }
          }}
        />
        <View pointerEvents="none" style={styles.reticle} />
      </View>
      <QrMessage rtl={rtl}>{t("peopleQr.scanHint")}</QrMessage>
    </View>
  );
}

function QrMessage({ rtl, alert, children }: { rtl: boolean; alert?: boolean; children: string }) {
  return (
    <Text
      style={[styles.message, textDir(rtl), styles.centered]}
      accessibilityRole={alert ? "alert" : undefined}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, paddingVertical: 24, gap: 24 },
  modes: { gap: 10 },
  mode: { flex: 1 },
  panel: { gap: 18, alignItems: "center" },
  message: { ...typography.body, color: colors.textSubtle },
  centered: { textAlign: "center" },
  cameraFrame: {
    width: "100%",
    maxWidth: 360,
    aspectRatio: 1,
    borderRadius: radius.lg,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#171717",
  },
  reticle: {
    width: "70%",
    aspectRatio: 1,
    borderWidth: 2,
    borderRadius: radius.md,
    borderColor: "#ffffff",
  },
});
