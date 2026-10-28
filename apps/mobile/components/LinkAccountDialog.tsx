import { SheetBackdrop } from "./SheetBackdrop";
import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import {
  getLocale,
  getShareLangPref,
  resolveShareLang,
  t,
  tIn,
  type LocaleCode,
} from "../lib/i18n";
import { getTabLinkForPerson } from "../lib/tabs/db";
import { linkContact, shareTabLinkOnWhatsApp } from "../lib/tabs/link";
import {
  TabAlreadyLinkedError,
  TabApiError,
  TabAuthUnavailableError,
  TabPermissionError,
} from "../lib/tabs/errors";
import type { TabLink, TabRecordingMode } from "../lib/tabs/types";
import { radius, TOUCH_MIN, typography } from "../lib/tokens";
import { getCurrentCurrencyCode } from "../lib/currency";
import { getAccountIdSync, getActiveVaultIdSyncMaybe } from "../lib/db-tx";

const recordingModeLabel = {
  notify: "tab.recordingMode.notify",
  review: "tab.recordingMode.review",
  notify_one_way: "tab.recordingMode.oneWay",
} as const;
const recordingModeHint = {
  notify: "tab.recordingMode.notifyHint",
  review: "tab.recordingMode.reviewHint",
  notify_one_way: "tab.recordingMode.oneWayHint",
} as const;

/** One surface from confirmation through creation/sharing, including retries.
 * A saved phone goes straight to its WhatsApp compose window, never a chooser. */
export function LinkAccountDialog(props: {
  visible: boolean;
  person: { id: string; name: string; phone: string | null };
  myLabel: string;
  link: TabLink | null;
  currency?: string;
  onLinked: (link: TabLink) => void;
  onDismiss: () => void;
  onAuthRequired: () => void;
}) {
  const rtl = useIsRTL();
  const toast = useToast();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareFailed, setShareFailed] = useState(false);
  const [language, setLanguage] = useState<LocaleCode>(getLocale);
  const [askLanguage, setAskLanguage] = useState(false);
  const [languageReady, setLanguageReady] = useState(false);
  const [recordingMode, setRecordingMode] = useState<TabRecordingMode>("notify");
  const target = useRef<TabLink | null>(null);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const authTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasPhone = !!props.person.phone?.trim();
  const currency = props.currency ?? getCurrentCurrencyCode();
  const vaultId = getActiveVaultIdSyncMaybe(),
    accountId = getAccountIdSync();
  const context = JSON.stringify([vaultId, accountId, props.person.id, currency]);
  const currentContext = useRef(context);
  currentContext.current = context;

  useEffect(
    () => () => {
      if (authTimer.current) clearTimeout(authTimer.current);
    },
    [],
  );
  useEffect(() => {
    const run = ++generation.current;
    if (!props.visible) return;
    if (authTimer.current) clearTimeout(authTimer.current);
    target.current = props.link;
    busyRef.current = false;
    setBusy(false);
    setReady(!!props.link?.invite_url);
    setError(null);
    setShareFailed(false);
    setLanguageReady(false);
    setLanguage(getLocale());
    setAskLanguage(false);
    setRecordingMode(props.link?.recording_mode ?? "notify");
    void getShareLangPref()
      .then((pref) => {
        if (generation.current !== run) return;
        setAskLanguage(pref === "ask");
        setLanguage(pref === "ask" ? getLocale() : resolveShareLang(pref));
        setLanguageReady(true);
      })
      .catch(() => {
        if (generation.current === run) setLanguageReady(true);
      });
    return () => {
      generation.current++;
    };
    // Snapshot the link when OPENED. onLinked changes the parent prop, but must
    // not reset this same dialog (or clear its in-flight sharing guard).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible, context]);

  const dismiss = () => {
    if (!busyRef.current) props.onDismiss();
  };
  async function run(action: "create" | "whatsapp" | "copy") {
    if (
      busyRef.current ||
      !languageReady ||
      !props.visible ||
      currentContext.current !== context ||
      getActiveVaultIdSyncMaybe() !== vaultId ||
      getAccountIdSync() !== accountId
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const session = generation.current;
    const active = () =>
      session === generation.current &&
      currentContext.current === context &&
      getActiveVaultIdSyncMaybe() === vaultId &&
      getAccountIdSync() === accountId;
    try {
      let fresh = target.current;
      if (!fresh) {
        try {
          fresh = (
            await linkContact(props.person.id, { myLabel: props.myLabel, currency, recordingMode })
          ).link;
        } catch (err) {
          if (!(err instanceof TabAlreadyLinkedError)) throw err;
          // Another phone (or a lost create response) already linked it.
          // Reuse that invitation, never create a second opening balance.
          fresh = await getTabLinkForPerson(props.person.id, currency);
          if (!fresh) throw err;
        }
        if (!active()) return;
        target.current = fresh;
        setReady(!!fresh.invite_url);
        props.onLinked(fresh);
      }
      if (!fresh.invite_url) {
        setError(t("tab.link.inviteUnavailable"));
        return;
      }
      if (action === "create" && !hasPhone) return; // same modal now shows delivery choices
      if (action === "copy") {
        await Clipboard.setStringAsync(fresh.invite_url);
        if (!active()) return;
        props.onDismiss();
        toast.push(t("tab.copied"), "success");
      } else {
        // Use the object returned by creation, not the parent's stale link state.
        const text = tIn(
          language,
          fresh.recording_mode === "notify_one_way"
            ? "tab.invite.oneWayMessage"
            : fresh.recording_mode === "notify"
              ? "tab.invite.notifyMessage"
              : "tab.invite.message",
          {
            name: fresh.my_label || props.myLabel,
            url: fresh.invite_url,
          },
        );
        const opened = await shareTabLinkOnWhatsApp(fresh, props.person, text);
        if (!active()) return;
        if (opened)
          props.onDismiss(); // composed, not automatically sent
        else {
          setShareFailed(true);
          setError(t("share.whatsappUnavailable"));
        }
      }
    } catch (err) {
      if (!active()) return;
      if (err instanceof TabAuthUnavailableError) {
        props.onDismiss();
        // Let this native Modal disappear before presenting the sign-in route.
        authTimer.current = setTimeout(props.onAuthRequired, 220);
      } else {
        if (target.current?.invite_url && action !== "copy") setShareFailed(true);
        setError(
          err instanceof TabApiError &&
            (err.code === "notification_only_unsupported" ||
              err.code === "one_way_tallies_unsupported")
            ? t("tab.link.serverUpdate")
            : err instanceof TabApiError && err.code === "recording_upgrade_required"
              ? t("tab.link.clientUpdate")
              : err instanceof TabApiError && err.code === "shared_history_pending"
                ? t("tab.history.pending")
                : err instanceof TabApiError && err.code === "shared_history_changed"
                  ? t("tab.history.changed")
                  : err instanceof TabApiError && err.code === "shared_history_opening_required"
                    ? t("tab.history.openingRequired")
                    : err instanceof TabPermissionError
                      ? t("entry.roleDenied")
                      : target.current?.invite_url
                        ? t(action === "copy" ? "entry.saveFailed" : "share.whatsappUnavailable")
                        : t("tab.link.failed"),
        );
      }
    } finally {
      if (active()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  if (!props.visible) return null;
  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <View style={styles.overlay}>
        <SheetBackdrop onDismiss={dismiss} />
        <SafeAreaView style={styles.center} pointerEvents="box-none">
          <View style={styles.card} accessibilityViewIsModal>
            <ScrollView bounces={false} contentContainerStyle={styles.content}>
              <Text accessibilityRole="header" style={[styles.title, textDir(rtl)]}>
                {t(ready ? "tab.link.ready" : "tab.link.confirm.title")}
              </Text>
              <Text style={[styles.description, textDir(rtl)]}>
                {t(
                  ready
                    ? "tab.link.readyBody"
                    : recordingMode === "notify_one_way"
                      ? "tab.link.confirm.oneWayBody"
                      : recordingMode === "notify"
                        ? "tab.link.confirm.notifyBody"
                        : "tab.link.confirm.body",
                  {
                    name: props.person.name,
                  },
                )}
              </Text>
              {ready ? (
                <Text style={[styles.description, textDir(rtl)]}>
                  {target.current?.recording_mode_known === 0
                    ? t("tab.recordingMode.unknown")
                    : t("tab.recordingMode.fixed", {
                        mode: t(
                          target.current?.recording_mode === "notify_one_way"
                            ? "tab.recordingMode.oneWayFixed"
                            : recordingModeLabel[target.current?.recording_mode ?? "review"],
                        ),
                      })}
                </Text>
              ) : (
                <View
                  style={styles.language}
                  accessibilityRole="radiogroup"
                  accessibilityLabel={t("tab.recordingMode.label")}
                >
                  {(["notify", "review", "notify_one_way"] as const).map((mode) => (
                    <Pressable
                      key={mode}
                      disabled={busy}
                      accessibilityRole="radio"
                      accessibilityLabel={t(recordingModeLabel[mode])}
                      accessibilityState={{ checked: recordingMode === mode, disabled: busy }}
                      onPress={() => {
                        if (!busyRef.current) setRecordingMode(mode);
                      }}
                      style={[styles.modeOption, recordingMode === mode && styles.selected]}
                    >
                      <Text style={[styles.modeLabel, textDir(rtl)]}>
                        {t(recordingModeLabel[mode])}
                      </Text>
                      <Text style={[styles.hint, textDir(rtl)]}>{t(recordingModeHint[mode])}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              {askLanguage ? (
                <View style={styles.language}>
                  <Text style={[styles.hint, textDir(rtl)]}>{t("share.askLang.title")}</Text>
                  <View style={[styles.languageOptions, rowDir(rtl)]}>
                    {(["fa", "ps", "en"] as const).map((lang) => (
                      <Pressable
                        key={lang}
                        disabled={busy}
                        accessibilityRole="radio"
                        accessibilityLabel={t(`settings.language.option.${lang}`)}
                        accessibilityState={{ checked: language === lang, disabled: busy }}
                        onPress={() => setLanguage(lang)}
                        style={[styles.languageOption, language === lang && styles.selected]}
                      >
                        <Text style={styles.optionText}>
                          {t(`settings.language.option.${lang}`)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : null}
              {error ? (
                <Text accessibilityRole="alert" style={[styles.error, textDir(rtl)]}>
                  {error}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <Button
                  fullWidth
                  loading={busy}
                  disabled={!languageReady}
                  label={t(
                    ready
                      ? "tab.share.whatsapp"
                      : hasPhone
                        ? "tab.link.whatsapp"
                        : "tab.link.action",
                  )}
                  icon={hasPhone || ready ? "logo-whatsapp" : "link-outline"}
                  onPress={() => void run(ready ? "whatsapp" : "create")}
                />
                {ready && (!hasPhone || shareFailed) ? (
                  <Button
                    fullWidth
                    variant="secondary"
                    disabled={busy}
                    label={t("tab.share.copy")}
                    icon="copy-outline"
                    onPress={() => void run("copy")}
                  />
                ) : null}
                <Pressable
                  onPress={dismiss}
                  disabled={busy}
                  accessibilityRole="button"
                  style={styles.cancel}
                >
                  <Text style={styles.optionText}>{t("common.cancel")}</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  card: {
    width: "100%",
    maxWidth: 380,
    maxHeight: "100%",
    backgroundColor: colors.bgDefault,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    overflow: "hidden",
  },
  content: { padding: 22 },
  title: { ...typography.title, color: colors.textEmphasis },
  description: { ...typography.bodySm, color: colors.textSubtle, marginTop: 8 },
  hint: { ...typography.hint, color: colors.textSubtle },
  language: { marginTop: 18, gap: 8 },
  languageOptions: { gap: 8 },
  languageOption: {
    flex: 1,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  selected: { backgroundColor: colors.bgMuted, borderColor: colors.actionPrimary },
  modeOption: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    padding: 12,
    gap: 4,
  },
  modeLabel: { ...typography.body, color: colors.textEmphasis },
  optionText: { ...typography.body, color: colors.textEmphasis, textAlign: "center" },
  error: { ...typography.bodySm, color: colors.danger, marginTop: 16 },
  actions: { marginTop: 20, gap: 8 },
  cancel: { minHeight: TOUCH_MIN, justifyContent: "center", alignItems: "center" },
});
