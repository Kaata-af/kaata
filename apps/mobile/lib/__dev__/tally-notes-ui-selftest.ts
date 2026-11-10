import assert from "node:assert/strict";
import {
  normalizeTallyNote,
  normalizeTallyNoteNumber,
  TALLY_NOTE_MAX_LENGTH,
} from "../tally-note-policy";
import type { TallyNote } from "../tally-notes";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

async function main() {
  const hooks = uiHooks();
  const writes: unknown[][] = [];
  const notices: string[] = [];
  let notes: TallyNote[] = [
    {
      id: "note-1",
      note: "I took two bags",
      number: null,
      authorAccountId: "viewer",
      authorName: "Amina",
      createdAt: 123,
    },
  ];
  let current = true;
  let canAdd = true;
  let canRemove = false;
  let canOpen = true;
  let isRTL = false;
  let scopeKey = "account";
  let refresh = () => {};
  let writeGate: ReturnType<typeof deferred<void>> | null = null;
  let readGate: ReturnType<typeof deferred<typeof notes>> | null = null;
  const { useTallyNotes, TallyNoteRow } = compileUI("../../components/TallyNotes", {
    "@expo/vector-icons": { Ionicons: "Icon" },
    "expo-router": {
      useIsFocused: () => current,
      useFocusEffect: (effect: () => () => void) => hooks.react.useEffect(effect, [effect]),
    },
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": {
      Keyboard: { dismiss: () => {} },
      KeyboardAvoidingView: "KeyboardAvoidingView",
      Platform: { OS: "ios" },
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      StyleSheet: { create: (styles: unknown) => styles },
      Text: "Text",
      View: "View",
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "../lib/colors": { colors: {} },
    "../lib/direction": {
      bidiIsolate: (value: string) => value,
      ltrIsolate: (value: string) => value,
      rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
      textDir: (rtl: boolean) => ({ writingDirection: rtl ? "rtl" : "ltr" }),
      useIsRTL: () => isRTL,
    },
    "../lib/fonts": { fonts: {}, sansLineHeight: () => 20 },
    "../lib/format": { formatTimestamp: (value: number) => `date:${value}` },
    "../lib/i18n": { t: (key: string, vars?: { name?: string }) => vars?.name ?? key },
    "../lib/ledger-events": {
      useLedgerRefresh: (_vault: string, reload: () => void) => (refresh = reload),
    },
    "../lib/tally-notes": {
      TALLY_NOTE_MAX_LENGTH,
      normalizeTallyNote,
      normalizeTallyNoteNumber,
      listTallyNotes: async (...scope: unknown[]) => {
        assert.deepEqual(scope, ["kaata", "customer"]);
        return readGate ? readGate.promise : notes;
      },
      addTallyNote: async (...args: [string, string, string, string?]) => {
        writes.push(args);
        const id = `new-${writes.length}`;
        if (writeGate) await writeGate.promise;
        notes = [
          {
            id,
            note: args[2],
            number: args[3] ?? null,
            authorAccountId: "viewer",
            authorName: "Viewer",
            createdAt: 456,
          },
          ...notes,
        ];
      },
      removeTallyNote: async (...args: [string, string, string]) => {
        writes.push(args);
        notes = notes.filter(({ id }) => id !== args[2]);
      },
    },
    "../lib/tokens": { radius: {}, TOUCH_MIN: 44 },
    "./BottomSheet": { BottomSheet: "BottomSheet" },
    "./Button": { Button: "Button" },
    "./ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
    "./FormField": { FormField: "FormField" },
    "./ProtectedModal": { ProtectedModal: "ProtectedModal" },
    "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
    "./Toast": { useToast: () => ({ push: (notice: string) => notices.push(notice) }) },
  });
  const render = () =>
    hooks.render(() => {
      const controller = useTallyNotes({
        vaultId: "kaata",
        personId: "customer",
        scopeKey,
        canAdd,
        canRemove,
        isCurrent: () => current,
      });
      return jsx("View", {
        children: [
          canAdd && jsx("Button", { label: "tallyNotes.add", onPress: controller.openComposer }),
          controller.failed && jsx("Button", { label: "common.retry", onPress: controller.reload }),
          ...controller.notes.map((note: TallyNote) =>
            TallyNoteRow({
              note,
              canRemove,
              busy: controller.busy,
              onOpen: canOpen ? () => controller.openDetails(note.id) : undefined,
              onDelete: () => controller.openDelete(note.id),
            }),
          ),
          controller.dialogs,
        ],
      });
    });
  const find = (type: string) => nodes(hooks.tree).find((node) => node.type === type)!.props;
  const button = (label: string) =>
    nodes(hooks.tree).find((node) => node.type === "Button" && node.props.label === label)!.props;
  const byId = (id: string) => nodes(hooks.tree).find((node) => node.props.testID === id);
  const numberInput = () =>
    nodes(hooks.tree).find(
      (node) => node.type === "FormField" && node.props.label === "tallyNotes.numberLabel",
    )!.props;

  render();
  await settleUI();
  render();
  assert.ok(byId("tally-note-note-1"));
  assert.match(JSON.stringify(hooks.tree), /Amina.*date:123/);
  assert.equal(byId("tally-note-delete-note-1"), undefined);
  isRTL = true;
  render();
  byId("tally-note-open-note-1")!.props.onPress();
  render();
  assert.equal(find("BottomSheet").visible, true);
  assert.match(JSON.stringify(find("BottomSheet").children), /I took two bags.*Amina.*date:123/);
  const sheetNote = nodes(find("BottomSheet").children).find(
    (node) => node.props.children === "I took two bags",
  )!.props;
  assert.equal(sheetNote.selectable, true);
  assert.deepEqual(sheetNote.style[1], { writingDirection: "rtl" });
  assert.equal(sheetNote.numberOfLines, undefined);
  assert.notEqual(sheetNote.allowFontScaling, false);
  assert.ok(!sheetNote.maxFontSizeMultiplier);
  assert.ok(flattenStyle(sheetNote.style).fontSize >= 16);
  assert.deepEqual(find("BottomSheet").actions, [], "Viewers can read note details");
  find("BottomSheet").onDismiss();
  canOpen = false;
  render();
  assert.equal(find("BottomSheet").visible, false);
  assert.equal(byId("tally-note-open-note-1"), undefined, "Selection mode has no open action");
  canOpen = true;
  isRTL = false;
  render();
  const openComposer = button("tallyNotes.add").onPress;
  openComposer();
  render();
  assert.equal(find("ProtectedModal").visible, true);
  assert.equal(button("tallyNotes.save").disabled, true);
  find("FormField").onChangeText("😀".repeat(501));
  render();
  assert.equal(button("tallyNotes.save").disabled, true);
  assert.equal(find("FormField").error, "tallyNotes.invalidText");
  find("FormField").onChangeText("😀".repeat(500));
  render();
  assert.equal(button("tallyNotes.save").disabled, false);
  find("FormField").onChangeText("  Record a bag for me  ");
  numberInput().onChangeText("3.1234567");
  render();
  assert.equal(numberInput().error, "tallyNotes.invalidNumber");
  assert.equal(button("tallyNotes.save").disabled, true);
  numberInput().onChangeText("۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶۷۸٫۰۰۰۰۰۱");
  render();
  writeGate = deferred<void>();
  button("tallyNotes.save").onPress();
  button("tallyNotes.save").onPress();
  assert.deepEqual(writes, [
    ["kaata", "customer", "Record a bag for me", "123456789012345678.000001"],
  ]);
  writeGate.resolve();
  await settleUI();
  render();
  assert.equal(find("ProtectedModal").visible, false);
  assert.match(JSON.stringify(byId("tally-note-new-1")), /123456789012345678\.000001/);

  openComposer();
  render();
  assert.equal(numberInput().value, "");
  find("FormField").onChangeText("Record a crate");
  render();
  const staleSave = button("tallyNotes.save").onPress;
  canAdd = false;
  canRemove = true;
  render();
  assert.equal(find("ProtectedModal").visible, false);
  staleSave();
  openComposer();
  render();
  assert.equal(find("ProtectedModal").visible, false);
  assert.equal(writes.length, 1, "A retired composer cannot write after a role change");
  byId("tally-note-delete-note-1")!.props.onPress();
  render();
  assert.equal(find("ConfirmDialog").visible, true);
  const staleConfirm = find("ConfirmDialog").onConfirm;
  canRemove = false;
  render();
  assert.equal(find("ConfirmDialog").visible, false);
  staleConfirm();
  assert.equal(writes.length, 1, "Role downgrade closes and guards a retained delete confirmation");
  canRemove = true;
  render();
  byId("tally-note-open-new-1")!.props.onLongPress();
  render();
  assert.match(JSON.stringify(find("BottomSheet").children), /123456789012345678\.000001/);
  const oldDelete = find("BottomSheet").actions[0].onPress;
  find("BottomSheet").onDismiss();
  render();
  byId("tally-note-open-note-1")!.props.onPress();
  render();
  oldDelete();
  render();
  assert.equal(find("ConfirmDialog").visible, false, "A newer sheet supersedes delayed actions");

  find("BottomSheet").onDismiss();
  render();
  byId("tally-note-open-new-1")!.props.onPress();
  render();
  const sheet = find("BottomSheet");
  assert.equal(sheet.actions[0].destructive, true);
  sheet.onDismiss();
  render();
  sheet.actions[0].onPress();
  render();
  assert.equal(find("ConfirmDialog").visible, true);
  find("ConfirmDialog").onConfirm();
  await settleUI();
  render();
  assert.deepEqual(writes[1], ["kaata", "customer", "new-1"]);
  assert.equal(byId("tally-note-new-1"), undefined);
  assert.deepEqual(notices, ["customerNote.saved", "tallyNotes.deleted"]);

  canAdd = true;
  canRemove = false;
  render();
  button("tallyNotes.add").onPress();
  render();
  staleSave();
  assert.equal(writes.length, 2, "A reopened composer rejects the previous draft's save action");
  find("FormField").onChangeText("Record a crate");
  render();
  button("tallyNotes.save").onPress();
  await settleUI();
  render();
  assert.deepEqual(writes[2], ["kaata", "customer", "Record a crate", undefined]);

  const previousNotes = notes;
  readGate = deferred<typeof notes>();
  refresh();
  readGate.reject(new Error("could not read"));
  await settleUI();
  render();
  assert.ok(byId("tally-note-new-3"), "A failed refresh retains previously visible notes");
  readGate = null;
  await button("common.retry").onPress();
  render();

  byId("tally-note-open-note-1")!.props.onPress();
  render();
  assert.equal(find("BottomSheet").visible, true);
  notes = notes.filter(({ id }) => id !== "note-1");
  refresh();
  await settleUI();
  render();
  assert.equal(find("BottomSheet").visible, false);
  button("tallyNotes.add").onPress();
  render();
  assert.equal(find("ProtectedModal").visible, true, "Remote deletion releases the detail sheet");

  const staleRead = deferred<typeof notes>();
  readGate = staleRead;
  refresh();
  notes = [];
  readGate = null;
  scopeKey = "another-account";
  render();
  staleRead.resolve(previousNotes);
  await settleUI();
  render();
  assert.equal(byId("tally-note-note-1"), undefined, "An account switch discards old note reads");

  readGate = deferred<typeof notes>();
  refresh();
  current = false;
  hooks.unmount();
  readGate.resolve(notes);
  await settleUI();
  assert.equal(hooks.lateWrites, 0, "A departed person's late note read cannot repaint");
  console.log(
    "PASS tally notes UI: optional decimal, Unicode, details sheet, confirmed deletion, retry and stale scope/role guards",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
