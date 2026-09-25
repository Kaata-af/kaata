// Dispute a tally on a mutual tab (docs/mutual-tab-design.md §4.4, D6).
//
// Legacy deep-linkable reason form. Only the other party's pending tally can
// be reviewed; rejection is final and excludes it from the balance.
//
// Built on entry/new.tsx's modal template: inline errors (toasts cannot render
// above native stack modals — components/Toast.tsx), ref + 280 ms focus so the
// keyboard opens after the slide-in, and a synchronous savingRef so a fast
// double tap cannot queue two disputes.

import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { ScreenLoading } from "../../components/ScreenLoading";
import { ScreenHeader } from "../../components/SettingsScreen";
import { queuePendingToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getCurrentCurrencySymbol } from "../../lib/currency";
import { textDir, useIsRTL } from "../../lib/direction";
import { fonts, sansLineHeight } from "../../lib/fonts";
import { formatAmount } from "../../lib/format";
import { t } from "../../lib/i18n";
import { getTabLinkForPerson, listTabEntriesAsEntries } from "../../lib/tabs/db";
import {
  disputeEntry,
  TabClosedError,
  TabInputError,
  TabPermissionError,
} from "../../lib/tabs/link";
import { TabReviewFinalError } from "../../lib/tabs/errors";
import type { TabLink } from "../../lib/tabs/types";
import { radius, TOUCH_MIN } from "../../lib/tokens";
import type { Entry } from "../../lib/types";

// Server bound (§3.1 dispute_reason ≤ 300). Mirrors REASON_MAX in
// lib/tabs/link.ts, which is the check that actually refuses; this one only
// stops the keyboard from typing past the limit.
const REASON_MAX = 300;

// presentation:"modal" screen: the loaded branch is a bare <SafeAreaView>,
// which insets all four edges. ScreenLoading defaults to ["top"] (the pushed-
// screen case), so the pre-content branches have to spell this out or the
// header shifts the moment the read resolves.
const MODAL_EDGES = ["top", "bottom", "left", "right"] as const;

export default function DisputeEntryScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const params = useLocalSearchParams<{ personId?: string; entryId?: string }>();
  const personId = params.personId ?? "";
  const entryId = params.entryId ?? "";

  const [loaded, setLoaded] = useState(false);
  const [link, setLink] = useState<TabLink | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<TextInput>(null);
  const savingRef = useRef(false);

  // Tab rows live in the tab cache, not in `entries`, so getEntry cannot see
  // them: resolve the link through the person (active vault, active
  // relationship — the same path every person read takes) and pick the row
  // out of the tab's list. A missing row means it was voided or the tab
  // was closed since the sheet opened; the not-found branch says so.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!personId || !entryId) return;
        const tl = await getTabLinkForPerson(personId);
        if (cancelled || !tl) return;
        const rows = await listTabEntriesAsEntries(tl);
        if (cancelled) return;
        const row = rows.find((e) => e.id === entryId) ?? null;
        setLink(tl);
        setEntry(
          row && !row.tab?.voided && row.tab?.by === "them" && row.tab.status === "pending"
            ? row
            : null,
        );
      } catch (err) {
        // A rejected read must still flip `loaded` — otherwise this modal is a
        // permanent spinner with no header/back. Render the not-found branch.
        console.warn("[tab/dispute] load failed", err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [personId, entryId]);

  // Reliable keyboard pop-up on Android — autoFocus on a modally-presented
  // screen fires before the slide-in finishes and the soft keyboard never
  // opens. Defer past the animation; see entry/[id]/edit for the pattern.
  useEffect(() => {
    if (!loaded || !entry) return;
    const focusTimer = setTimeout(() => reasonRef.current?.focus(), 280);
    return () => clearTimeout(focusTimer);
  }, [loaded, entry]);

  const otherName = link?.other_label || t("tab.them");

  async function onSend() {
    if (savingRef.current || !link || !entry) return;
    // The same two checks disputeEntry makes, done here first so the common
    // mistakes never cost a round trip to the data layer.
    const clean = reason.trim();
    if (!clean) {
      setError(t("tab.dispute.reasonRequired", { name: otherName }));
      return;
    }
    if (clean.length > REASON_MAX) {
      setError(t("tab.dispute.reasonTooLong"));
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await disputeEntry(link, entry.id, clean);
      // Queued, not pushed: this modal is about to close and a toast from
      // under it would never be seen. It shows on the person screen.
      queuePendingToast(t("tab.disputed"), "success");
      router.back();
    } catch (err) {
      if (err instanceof TabInputError) {
        setError(
          err.code === "reason_too_long"
            ? t("tab.dispute.reasonTooLong")
            : err.code === "reason_required"
              ? t("tab.dispute.reasonRequired", { name: otherName })
              : t("entry.saveFailed"),
        );
      } else if (err instanceof TabPermissionError) {
        setError(t("entry.roleDenied"));
      } else if (err instanceof TabReviewFinalError) {
        setError(t("tab.reviewFinal"));
      } else if (err instanceof TabClosedError) {
        setError(t("tab.closed"));
      } else {
        console.warn("[tab/dispute] disputeEntry failed", err);
        setError(t("entry.saveFailed"));
      }
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }

  // The amount is the title: it names WHICH tally without a second line, and
  // it is Latin digits in both languages (formatAmount), so the header reads
  // the same in Dari.
  const title = entry
    ? t("tab.dispute.title", {
        amount: `${formatAmount(entry.amount_afn)} ${getCurrentCurrencySymbol()}`,
      })
    : t("tab.dispute");

  if (!loaded) {
    return (
      <ScreenLoading title={title} onBack={() => router.back()} isRTL={isRTL} edges={MODAL_EDGES} />
    );
  }

  if (!link || !entry) {
    // Not-found still needs a way OUT — this is a modal screen, and without
    // a header the only escape is hardware back (which iOS doesn't have).
    return (
      <ScreenLoading
        title={title}
        onBack={() => router.back()}
        isRTL={isRTL}
        message={link ? t("tab.dispute.notFound") : t("tab.closed")}
        edges={MODAL_EDGES}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* The "Cancel" word becomes the shared chevron; it survives as the a11y
          label so TalkBack still announces "Cancel", not "Back". */}
      <ScreenHeader
        title={title}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.cancel")}
      />

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Who wrote the tally being disputed — the reader of the reason. */}
        <Text style={[styles.hint, textDir(isRTL)]}>{t("tab.addedBy", { name: otherName })}</Text>

        <View style={styles.field}>
          <Text style={[styles.label, textDir(isRTL)]}>
            {t("tab.dispute.reasonLabel")} <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            ref={reasonRef}
            style={[styles.input, textDir(isRTL), error ? styles.inputError : null]}
            value={reason}
            onChangeText={(v) => {
              setError(null);
              setReason(v);
            }}
            placeholder={t("tab.dispute.reasonPlaceholder")}
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={REASON_MAX}
            accessibilityLabel={t("tab.dispute.reasonLabel")}
            // Multiline: the return key inserts a newline; Send is the button.
            submitBehavior="newline"
          />
          {error ? (
            <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
        </View>

        <View style={{ height: 24 }} />
        <Button label={t("tab.dispute.send")} onPress={onSend} loading={busy} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  body: { flex: 1, padding: 16, paddingTop: 20 },
  hint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginBottom: 20,
    lineHeight: sansLineHeight(12, 18),
  },
  field: { marginBottom: 20 },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  required: { color: colors.danger },
  // Taller than the one-line note input: a reason is a sentence or three.
  // textAlignVertical so Android starts the text at the top, like iOS.
  input: {
    minHeight: TOUCH_MIN * 2.5,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
    backgroundColor: colors.bgDefault,
    lineHeight: sansLineHeight(15, 22),
    textAlignVertical: "top",
  },
  // Mirrors FormField's error treatment — see entry/new.tsx.
  inputError: {
    borderColor: colors.danger,
    backgroundColor: "rgba(220, 38, 38, 0.04)",
  },
  fieldError: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 6,
  },
});
