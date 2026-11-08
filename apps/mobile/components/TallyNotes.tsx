import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextInputInstance,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import { bidiIsolate, rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { formatTimestamp } from "../lib/format";
import { t } from "../lib/i18n";
import { useLedgerRefresh } from "../lib/ledger-events";
import {
  addTallyNote,
  listTallyNotes,
  normalizeTallyNote,
  removeTallyNote,
  TALLY_NOTE_MAX_LENGTH,
  type TallyNote,
} from "../lib/tally-notes";
import { radius, TOUCH_MIN } from "../lib/tokens";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { FormField } from "./FormField";
import { ProtectedModal } from "./ProtectedModal";
import { SheetBackdrop } from "./SheetBackdrop";
import { useToast } from "./Toast";

const PREVIEW_COUNT = 3;

/** Contact-bound notes live beside the ledger, outside currency and amount filters. */
export function TallyNotes({
  vaultId,
  personId,
  canAdd,
  canRemove,
  isCurrent,
}: {
  vaultId: string;
  personId: string;
  canAdd: boolean;
  canRemove: boolean;
  isCurrent: () => boolean;
}) {
  const isRTL = useIsRTL();
  const focused = useIsFocused();
  const toast = useToast();
  const input = useRef<TextInputInstance>(null);
  const context = useRef({ canAdd, canRemove, isCurrent });
  context.current = { canAdd, canRemove, isCurrent };
  const focus = useRef<symbol | null>(null);
  const reads = useRef(0);
  const writing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<TallyNote[]>([]);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const owner = focus.current;
    if (!owner || !context.current.isCurrent()) return;
    const generation = ++reads.current;
    const stillCurrent = () =>
      focus.current === owner && reads.current === generation && context.current.isCurrent();
    try {
      const next = await listTallyNotes(vaultId, personId);
      if (stillCurrent()) {
        setNotes(next);
        setFailed(false);
      }
    } catch {
      if (stillCurrent()) setFailed(true);
    }
  }, [vaultId, personId]);
  useFocusEffect(
    useCallback(() => {
      focus.current = Symbol();
      setBusy(writing.current);
      setComposing(false);
      setDraft("");
      setSaveFailed(false);
      setDeleting(null);
      // Let the surrounding route's focus effect mark its scope current.
      void Promise.resolve().then(reload);
      return () => {
        focus.current = null;
      };
    }, [reload]),
  );
  useLedgerRefresh(vaultId, () => void reload());
  useEffect(() => {
    if (!canRemove) setDeleting(null);
  }, [canRemove]);

  function closeComposer() {
    if (!focus.current || writing.current) return;
    Keyboard.dismiss();
    setComposing(false);
    setDraft("");
    setSaveFailed(false);
  }

  async function changeNote(
    operation: "add" | "remove",
    write: () => Promise<unknown>,
  ): Promise<void> {
    const owner = focus.current;
    const { canAdd, canRemove, isCurrent } = context.current;
    if (!owner || writing.current || !isCurrent() || !(operation === "add" ? canAdd : canRemove))
      return;
    const stillCurrent = () => focus.current === owner && context.current.isCurrent();
    writing.current = true;
    setBusy(true);
    setSaveFailed(false);
    setDeleting(null);
    try {
      await write();
      if (stillCurrent()) {
        if (operation === "add") {
          Keyboard.dismiss();
          setComposing(false);
          setDraft("");
          setExpanded(false);
        }
        toast.push(t(operation === "add" ? "customerNote.saved" : "tallyNotes.deleted"), "success");
      }
      await reload();
    } catch {
      if (stillCurrent()) {
        if (operation === "add") setSaveFailed(true);
        else toast.push(t("entry.deleteFailed"), "error");
      }
    } finally {
      writing.current = false;
      if (focus.current) setBusy(false);
    }
  }

  const normalized = normalizeTallyNote(draft);
  const pendingDeletion =
    focused && focus.current && canRemove && deleting && notes.some((note) => note.id === deleting);
  if (!canAdd) return null;
  return (
    <View style={styles.section} testID="tally-notes">
      <View style={[styles.heading, rowDir(isRTL)]}>
        <Text accessibilityRole="header" style={[styles.title, textDir(isRTL)]}>
          {t("tallyNotes.title")}
        </Text>
        <Button
          label={t("tallyNotes.add")}
          variant="secondary"
          icon="add-outline"
          disabled={busy}
          onPress={() => {
            if (
              !focus.current ||
              !context.current.isCurrent() ||
              !context.current.canAdd ||
              writing.current
            )
              return;
            Keyboard.dismiss();
            setComposing(true);
          }}
        />
      </View>
      {failed ? (
        <View style={styles.loadError}>
          <Text style={[styles.meta, textDir(isRTL)]}>{t("tallyNotes.loadFailed")}</Text>
          <Button label={t("common.retry")} variant="secondary" onPress={() => void reload()} />
        </View>
      ) : null}
      {(expanded ? notes : notes.slice(0, PREVIEW_COUNT)).map((note) => (
        <View key={note.id} style={[styles.note, rowDir(isRTL)]} testID={`tally-note-${note.id}`}>
          <View style={styles.noteBody}>
            <Text selectable style={[styles.noteText, textDir(isRTL)]}>
              {note.note}
            </Text>
            <Text style={[styles.meta, textDir(isRTL)]}>
              {note.authorName
                ? t("customerNote.by", { name: bidiIsolate(note.authorName) })
                : t("customerNote.authorUnavailable")}
              {"\n"}
              {formatTimestamp(note.createdAt)}
            </Text>
          </View>
          {canRemove ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("tallyNotes.delete")}
              testID={`tally-note-delete-${note.id}`}
              disabled={busy}
              accessibilityState={{ disabled: busy }}
              onPress={() => {
                if (
                  focus.current &&
                  context.current.isCurrent() &&
                  context.current.canRemove &&
                  !writing.current
                )
                  setDeleting(note.id);
              }}
              style={({ pressed }) => [styles.delete, (pressed || busy) && styles.dim]}
            >
              <Ionicons name="trash-outline" size={20} color={colors.textSubtle} />
            </Pressable>
          ) : null}
        </View>
      ))}
      {notes.length > PREVIEW_COUNT ? (
        <Button
          label={t(expanded ? "tallyNotes.showFewer" : "tallyNotes.showMore")}
          variant="muted"
          onPress={() => setExpanded(!expanded)}
        />
      ) : null}
      <ProtectedModal
        visible={Boolean(focused && focus.current && composing)}
        transparent
        animationType="fade"
        statusBarTranslucent
        onShow={() => input.current?.focus()}
        onRequestClose={closeComposer}
      >
        <View style={styles.overlay}>
          <SheetBackdrop onDismiss={closeComposer} />
          <KeyboardAvoidingView
            style={styles.overlay}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            pointerEvents="box-none"
          >
            <SafeAreaView style={styles.center} pointerEvents="box-none">
              <View style={styles.composer} accessibilityViewIsModal>
                <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
                  <Text accessibilityRole="header" style={[styles.formTitle, textDir(isRTL)]}>
                    {t("tallyNotes.add")}
                  </Text>
                  <Text style={[styles.formHint, textDir(isRTL)]}>{t("tallyNotes.hint")}</Text>
                  <FormField
                    ref={input}
                    accessibilityLabel={t("entry.note.label")}
                    placeholder={t("tallyNotes.placeholder")}
                    multiline
                    editable={!busy}
                    maxLength={2 * TALLY_NOTE_MAX_LENGTH}
                    value={draft}
                    onChangeText={(value) => {
                      setDraft(value);
                      setSaveFailed(false);
                    }}
                    error={
                      draft.trim() && !normalized
                        ? t("tallyNotes.invalidText", { count: TALLY_NOTE_MAX_LENGTH })
                        : saveFailed
                          ? t("entry.saveFailed")
                          : null
                    }
                    style={styles.input}
                  />
                  <View style={[styles.actions, rowDir(isRTL)]}>
                    <Button
                      label={t("common.cancel")}
                      variant="secondary"
                      onPress={closeComposer}
                      disabled={busy}
                    />
                    <Button
                      label={t("entry.save")}
                      disabled={!normalized || !canAdd}
                      loading={busy}
                      onPress={() => {
                        if (!normalized) return;
                        void changeNote("add", () => addTallyNote(vaultId, personId, normalized));
                      }}
                    />
                  </View>
                </ScrollView>
              </View>
            </SafeAreaView>
          </KeyboardAvoidingView>
        </View>
      </ProtectedModal>
      <ConfirmDialog
        visible={Boolean(pendingDeletion)}
        title={t("tallyNotes.deleteTitle")}
        description={t("tallyNotes.deleteBody")}
        confirmLabel={t("person.delete.confirm")}
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting && pendingDeletion)
            void changeNote("remove", () => removeTallyNote(vaultId, personId, deleting));
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 16, gap: 8 },
  heading: { alignItems: "center", justifyContent: "space-between", gap: 12 },
  title: { flexShrink: 1, color: colors.textEmphasis, fontFamily: fonts.sansSemi, fontSize: 15 },
  note: {
    alignItems: "flex-start",
    padding: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgMuted,
  },
  noteBody: { flex: 1, gap: 6 },
  noteText: {
    color: colors.textDefault,
    fontFamily: fonts.sansRegular,
    fontSize: 14,
    lineHeight: sansLineHeight(14, 20),
  },
  meta: {
    color: colors.textSubtle,
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    lineHeight: sansLineHeight(12, 17),
  },
  delete: { width: TOUCH_MIN, height: TOUCH_MIN, alignItems: "center", justifyContent: "center" },
  dim: { opacity: 0.5 },
  loadError: { alignItems: "flex-start", gap: 6 },
  overlay: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20 },
  composer: {
    width: "100%",
    maxWidth: 440,
    flexShrink: 1,
    borderRadius: radius.md,
    backgroundColor: colors.bgDefault,
  },
  form: { padding: 18 },
  formTitle: { color: colors.textEmphasis, fontFamily: fonts.sansSemi, fontSize: 18 },
  formHint: {
    color: colors.textSubtle,
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    lineHeight: sansLineHeight(13, 18),
    marginTop: 6,
    marginBottom: 14,
  },
  input: { minHeight: 96, paddingVertical: 10, textAlignVertical: "top" },
  actions: { justifyContent: "flex-end", flexWrap: "wrap", gap: 8 },
});
