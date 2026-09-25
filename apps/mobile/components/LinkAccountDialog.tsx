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
  TabAuthUnavailableError,
  TabPermissionError,
} from "../lib/tabs/errors";
import type { TabLink } from "../lib/tabs/types";
import { radius, TOUCH_MIN, typography } from "../lib/tokens";

/** One surface from confirmation through creation/sharing, including retries.
 * A saved phone goes straight to its WhatsApp compose window, never a chooser. */
export function LinkAccountDialog(props: {
  visible: boolean;
  person: { id: string; name: string; phone: string | null };
  myLabel: string;
  link: TabLink | null;
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
  const target = useRef<TabLink | null>(null);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const authTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasPhone = !!props.person.phone?.trim();

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
  }, [props.visible, props.person.id]);

  const dismiss = () => {
    if (!busyRef.current) props.onDismiss();
  };
  async function run(action: "create" | "whatsapp" | "copy") {
    if (busyRef.current || !languageReady) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const session = generation.current;
    const active = () => session === generation.current;
    try {
      let fresh = target.current;
      if (!fresh) {
        try {
          fresh = (await linkContact(props.person.id, { myLabel: props.myLabel })).link;
        } catch (err) {
          if (!(err instanceof TabAlreadyLinkedError)) throw err;
          // Another phone (or a lost create response) already linked it.
          // Reuse that invitation, never create a second opening balance.
          fresh = await getTabLinkForPerson(props.person.id);
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
        const text = tIn(language, "tab.invite.message", {
          name: fresh.my_label || props.myLabel,
          url: fresh.invite_url,
        });
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
          err instanceof TabPermissionError
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
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={dismiss}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
        <SafeAreaView style={styles.center} pointerEvents="box-none">
          <View style={styles.card} accessibilityViewIsModal>
            <ScrollView bounces={false} contentContainerStyle={styles.content}>
              <Text accessibilityRole="header" style={[styles.title, textDir(rtl)]}>
                {t(ready ? "tab.link.ready" : "tab.link.confirm.title")}
              </Text>
              <Text style={[styles.description, textDir(rtl)]}>
                {t(ready ? "tab.link.readyBody" : "tab.link.confirm.body", {
                  name: props.person.name,
                })}
              </Text>
              {askLanguage ? (
                <View style={styles.language}>
                  <Text style={[styles.hint, textDir(rtl)]}>{t("share.askLang.title")}</Text>
                  <View style={[styles.languageOptions, rowDir(rtl)]}>
                    {(["fa", "en"] as const).map((lang) => (
                      <Pressable
                        key={lang}
                        disabled={busy}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: language === lang, disabled: busy }}
                        onPress={() => setLanguage(lang)}
                        style={[styles.languageOption, language === lang && styles.selected]}
                      >
                        <Text style={styles.optionText}>
                          {t(
                            lang === "fa"
                              ? "settings.language.option.fa"
                              : "settings.language.option.en",
                          )}
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
                  icon={hasPhone || ready ? "logo-whatsapp" : "checkmark-circle-outline"}
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
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.22)" },
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
  selected: { backgroundColor: colors.bgSubtle, borderColor: colors.textEmphasis },
  optionText: { ...typography.body, color: colors.textEmphasis, textAlign: "center" },
  error: { ...typography.bodySm, color: colors.danger, marginTop: 16 },
  actions: { marginTop: 20, gap: 8 },
  cancel: { minHeight: TOUCH_MIN, justifyContent: "center", alignItems: "center" },
});
