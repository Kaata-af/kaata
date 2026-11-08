import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { bidiIsolate, ltrIsolate, rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { formatTimestamp } from "../lib/format";
import { t } from "../lib/i18n";
import { useLedgerRefresh } from "../lib/ledger-events";
import {
  addTallyNote,
  listTallyNotes,
  normalizeTallyNote,
  normalizeTallyNoteNumber,
  removeTallyNote,
  TALLY_NOTE_MAX_LENGTH,
  type TallyNote,
} from "../lib/tally-notes";
import { radius, TOUCH_MIN } from "../lib/tokens";
import { BottomSheet } from "./BottomSheet";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { FormField } from "./FormField";
import { ProtectedModal } from "./ProtectedModal";
import { SheetBackdrop } from "./SheetBackdrop";
import { useToast } from "./Toast";

const EMPTY_NOTES: TallyNote[] = [];
type DetailSheet = { target: { id: string }; visible: boolean };

/** Keep the contact's timeline and note dialogs in the same focus scope. */
export function useTallyNotes({
  vaultId,
  personId,
  scopeKey,
  canAdd,
  canRemove,
  isCurrent,
}: {
  vaultId: string | null;
  personId: string | null;
  scopeKey?: string;
  canAdd: boolean;
  canRemove: boolean;
  isCurrent: () => boolean;
}) {
  const isRTL = useIsRTL();
  const focused = useIsFocused();
  const toast = useToast();
  const input = useRef<TextInputInstance>(null);
  const scope = useMemo(() => ({ vaultId, personId, scopeKey }), [vaultId, personId, scopeKey]);
  const focus = useRef<{ scope: typeof scope } | null>(null);
  const reads = useRef(0);
  const writing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<{
    scope: typeof scope;
    notes: TallyNote[];
    failed: boolean;
  } | null>(null);
  const [composer, setComposer] = useState<symbol | null>(null);
  const [draft, setDraft] = useState("");
  const [draftNumber, setDraftNumber] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string } | null>(null);
  const [detailSheet, setDetailSheet] = useState<DetailSheet | null>(null);
  const notes = snapshot?.scope === scope ? snapshot.notes : EMPTY_NOTES;
  const failed = snapshot?.scope === scope && snapshot.failed;
  const detailTarget = detailSheet?.target;
  const detailNote = detailTarget ? notes.find((note) => note.id === detailTarget.id) : undefined;
  const context = useRef({
    scope,
    canAdd,
    canRemove,
    isCurrent,
    notes,
    composer,
    deleting,
    detailSheet,
  });
  context.current = { scope, canAdd, canRemove, isCurrent, notes, composer, deleting, detailSheet };

  const reload = useCallback(async () => {
    const owner = focus.current;
    if (!vaultId || !personId || owner?.scope !== scope || !context.current.isCurrent()) return;
    const generation = ++reads.current;
    const stillCurrent = () =>
      focus.current === owner &&
      context.current.scope === scope &&
      reads.current === generation &&
      context.current.isCurrent();
    try {
      const next = await listTallyNotes(vaultId, personId);
      if (stillCurrent()) {
        setSnapshot({ scope, notes: next, failed: false });
      }
    } catch {
      if (stillCurrent()) {
        setSnapshot((previous) => ({
          scope,
          notes: previous?.scope === scope ? previous.notes : EMPTY_NOTES,
          failed: true,
        }));
      }
    }
  }, [personId, scope, vaultId]);
  useFocusEffect(
    useCallback(() => {
      focus.current = { scope };
      setBusy(writing.current);
      setComposer(null);
      setDraft("");
      setDraftNumber("");
      setSaveFailed(false);
      setDeleting(null);
      setDetailSheet(null);
      // Let the surrounding route's focus effect mark its scope current.
      void Promise.resolve().then(reload);
      return () => {
        focus.current = null;
      };
    }, [reload, scope]),
  );
  useLedgerRefresh(vaultId, () => void reload());
  useEffect(() => {
    if (canAdd || !composer) return;
    Keyboard.dismiss();
    setComposer(null);
    setDraft("");
    setDraftNumber("");
    setSaveFailed(false);
  }, [canAdd, composer]);
  useEffect(() => {
    if (deleting && (!canRemove || !notes.some((note) => note.id === deleting.id))) {
      setDeleting((current) => (current === deleting ? null : current));
    }
    if (detailTarget && !detailNote) {
      setDetailSheet((current) => (current?.target === detailTarget ? null : current));
    }
  }, [canRemove, deleting, detailNote, detailTarget, notes]);

  function scopeIsCurrent() {
    return (
      vaultId &&
      personId &&
      focus.current?.scope === scope &&
      context.current.scope === scope &&
      context.current.isCurrent()
    );
  }

  function actionIsCurrent(operation: "add" | "remove") {
    return (
      scopeIsCurrent() &&
      !writing.current &&
      (operation === "add" ? context.current.canAdd : context.current.canRemove)
    );
  }

  function openComposer() {
    const { composer, deleting, detailSheet } = context.current;
    if (!actionIsCurrent("add") || composer || deleting || detailSheet?.visible) return;
    Keyboard.dismiss();
    setDetailSheet(null);
    setComposer(Symbol());
  }

  function openDetails(id: string) {
    const { composer, deleting, notes } = context.current;
    if (!scopeIsCurrent() || writing.current || composer || deleting) return;
    if (notes.some((note) => note.id === id)) {
      Keyboard.dismiss();
      setDetailSheet({ target: { id }, visible: true });
    }
  }

  function openDelete(id: string) {
    const { composer, detailSheet, notes } = context.current;
    if (
      actionIsCurrent("remove") &&
      !composer &&
      !detailSheet?.visible &&
      notes.some((note) => note.id === id)
    ) {
      setDetailSheet(null);
      setDeleting({ id });
    }
  }

  function closeComposer() {
    if (focus.current?.scope !== scope || context.current.composer !== composer || writing.current)
      return;
    Keyboard.dismiss();
    setComposer(null);
    setDraft("");
    setDraftNumber("");
    setSaveFailed(false);
  }

  async function changeNote(
    operation: "add" | "remove",
    write: () => Promise<unknown>,
  ): Promise<void> {
    const owner = focus.current;
    if (!actionIsCurrent(operation)) return;
    const stillCurrent = () =>
      focus.current === owner && context.current.scope === scope && context.current.isCurrent();
    writing.current = true;
    setBusy(true);
    setSaveFailed(false);
    setDeleting(null);
    try {
      await write();
      if (stillCurrent()) {
        if (operation === "add") {
          Keyboard.dismiss();
          setComposer(null);
          setDraft("");
          setDraftNumber("");
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
  const number = normalizeTallyNoteNumber(draftNumber);
  const owner = focus.current;
  const active = focused && owner?.scope === scope;
  const pendingDeletion =
    active && canRemove && deleting && notes.some((note) => note.id === deleting.id);
  const dialogs = (
    <>
      <ProtectedModal
        visible={active && canAdd && composer !== null}
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
                  <FormField
                    label={t("tallyNotes.numberLabel")}
                    keyboardType="decimal-pad"
                    editable={!busy}
                    maxLength={64}
                    value={draftNumber}
                    onChangeText={(value) => {
                      setDraftNumber(value);
                      setSaveFailed(false);
                    }}
                    error={number === null ? t("tallyNotes.invalidNumber") : null}
                  />
                  <View style={[styles.actions, rowDir(isRTL)]}>
                    <Button
                      label={t("common.cancel")}
                      variant="secondary"
                      onPress={closeComposer}
                      disabled={busy}
                    />
                    <Button
                      label={t("tallyNotes.save")}
                      disabled={!normalized || number === null || !canAdd || busy}
                      loading={busy}
                      onPress={() => {
                        if (
                          !vaultId ||
                          !personId ||
                          !normalized ||
                          number === null ||
                          focus.current !== owner ||
                          !composer ||
                          context.current.composer !== composer
                        )
                          return;
                        void changeNote("add", () =>
                          addTallyNote(vaultId, personId, normalized, number),
                        );
                      }}
                    />
                  </View>
                </ScrollView>
              </View>
            </SafeAreaView>
          </KeyboardAvoidingView>
        </View>
      </ProtectedModal>
      <BottomSheet
        visible={Boolean(active && detailNote && detailSheet?.visible)}
        onDismiss={() => {
          setDetailSheet((current) =>
            current?.target === detailTarget && current?.visible
              ? { ...current, visible: false }
              : current,
          );
        }}
        actions={
          canRemove && detailNote && detailTarget
            ? [
                {
                  label: t("tallyNotes.delete"),
                  icon: "trash-outline",
                  destructive: true,
                  disabled: busy,
                  onPress: () => {
                    // BottomSheet runs actions after its exit. A newer sheet
                    // or focus scope must take precedence over this action.
                    if (
                      focus.current === owner &&
                      context.current.detailSheet?.target === detailTarget
                    )
                      openDelete(detailNote.id);
                  },
                },
              ]
            : []
        }
      >
        {detailNote ? (
          <View style={[styles.note, styles.detailNote]}>
            {noteContent(detailNote, isRTL, true)}
          </View>
        ) : null}
      </BottomSheet>
      <ConfirmDialog
        visible={Boolean(pendingDeletion)}
        title={t("tallyNotes.deleteTitle")}
        description={t("tallyNotes.deleteBody")}
        confirmLabel={t("person.delete.confirm")}
        destructive
        onCancel={() => {
          if (context.current.deleting === deleting) setDeleting(null);
        }}
        onConfirm={() => {
          if (
            vaultId &&
            personId &&
            deleting &&
            pendingDeletion &&
            focus.current === owner &&
            context.current.deleting === deleting &&
            context.current.notes.some((note) => note.id === deleting.id)
          )
            void changeNote("remove", () => removeTallyNote(vaultId, personId, deleting.id));
        }}
      />
    </>
  );
  return { notes, failed, reload, busy, openComposer, openDetails, openDelete, dialogs };
}

function noteContent(note: TallyNote, isRTL: boolean, selectable: boolean) {
  return (
    <>
      <View style={[styles.noteHeading, rowDir(isRTL)]}>
        <Ionicons name="document-text-outline" size={17} color={colors.notePaperInk} />
        <Text style={[styles.title, textDir(isRTL)]}>{t("tallyNotes.title")}</Text>
        {note.number !== null ? (
          <Text selectable={selectable} style={[styles.number, textDir(isRTL)]}>
            {ltrIsolate(note.number)}
          </Text>
        ) : null}
      </View>
      <Text selectable={selectable} style={[styles.noteText, textDir(isRTL)]}>
        {note.note}
      </Text>
      <Text style={[styles.meta, textDir(isRTL)]}>
        {note.authorName
          ? t("customerNote.by", { name: bidiIsolate(note.authorName) })
          : t("customerNote.authorUnavailable")}
        {"\n"}
        {formatTimestamp(note.createdAt)}
      </Text>
    </>
  );
}

export function TallyNoteRow({
  note,
  canRemove,
  busy,
  onOpen,
  onDelete,
}: {
  note: TallyNote;
  canRemove: boolean;
  busy: boolean;
  onOpen?: () => void;
  onDelete: () => void;
}) {
  const isRTL = useIsRTL();
  return (
    <View style={[styles.note, rowDir(isRTL)]} testID={`tally-note-${note.id}`}>
      {onOpen ? (
        <Pressable
          accessibilityRole="button"
          testID={`tally-note-open-${note.id}`}
          onPress={onOpen}
          onLongPress={onOpen}
          style={({ pressed }) => [styles.noteBody, pressed && styles.dim]}
        >
          {noteContent(note, isRTL, false)}
        </Pressable>
      ) : (
        <View style={styles.noteBody}>{noteContent(note, isRTL, false)}</View>
      )}
      {canRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("tallyNotes.delete")}
          testID={`tally-note-delete-${note.id}`}
          disabled={busy}
          accessibilityState={{ disabled: busy }}
          onPress={onDelete}
          style={({ pressed }) => [styles.delete, (pressed || busy) && styles.dim]}
        >
          <Ionicons name="trash-outline" size={20} color={colors.notePaperInk} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  noteHeading: { alignItems: "center", flexWrap: "wrap", gap: 6 },
  title: { color: colors.notePaperInk, fontFamily: fonts.sansSemi, fontSize: 14 },
  number: { color: colors.notePaperInk, fontFamily: fonts.sansSemi, fontSize: 14 },
  note: {
    alignItems: "flex-start",
    padding: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.notePaperBorder,
    backgroundColor: colors.notePaper,
  },
  noteBody: { flex: 1, gap: 6 },
  detailNote: { alignItems: "stretch", gap: 8, marginHorizontal: 20, marginBottom: 8 },
  noteText: {
    color: colors.notePaperInk,
    fontFamily: fonts.sansRegular,
    fontSize: 14,
    lineHeight: sansLineHeight(14, 20),
  },
  meta: {
    color: colors.notePaperInk,
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    lineHeight: sansLineHeight(12, 17),
  },
  delete: { width: TOUCH_MIN, height: TOUCH_MIN, alignItems: "center", justifyContent: "center" },
  dim: { opacity: 0.5 },
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
