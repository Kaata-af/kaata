import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

async function main() {
  const hooks = uiHooks();
  const writes: unknown[][] = [];
  const notices: string[] = [];
  let notes = [{ id: "note-1", note: "I took two bags", authorName: "Amina", createdAt: 123 }];
  let current = true;
  let canRemove = false;
  let refresh = () => {};
  let writeGate: ReturnType<typeof deferred<void>> | null = null;
  let readGate: ReturnType<typeof deferred<typeof notes>> | null = null;
  const { TallyNotes } = compileUI("../../components/TallyNotes", {
    "@expo/vector-icons": { Ionicons: "Icon" },
    "expo-router": {
      useIsFocused: () => current,
      useFocusEffect: (effect: () => () => void) => hooks.react.useEffect(effect, [effect]),
    },
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
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
      rowDir: () => ({}),
      textDir: () => ({}),
      useIsRTL: () => false,
    },
    "../lib/fonts": { fonts: {}, sansLineHeight: () => 20 },
    "../lib/format": { formatTimestamp: (value: number) => `date:${value}` },
    "../lib/i18n": { t: (key: string, vars?: { name?: string }) => vars?.name ?? key },
    "../lib/ledger-events": {
      useLedgerRefresh: (_vault: string, reload: () => void) => (refresh = reload),
    },
    "../lib/tally-notes": {
      TALLY_NOTE_MAX_LENGTH: 500,
      normalizeTallyNote: (text: string) =>
        text.trim() && Array.from(text.trim()).length <= 500 ? text.trim() : null,
      listTallyNotes: async (...scope: unknown[]) => {
        assert.deepEqual(scope, ["kaata", "customer"]);
        return readGate ? readGate.promise : notes;
      },
      addTallyNote: async (...args: [string, string, string]) => {
        writes.push(args);
        if (writeGate) await writeGate.promise;
        notes = [{ id: "new", note: args[2], authorName: "Viewer", createdAt: 456 }, ...notes];
      },
      removeTallyNote: async (...args: [string, string, string]) => {
        writes.push(args);
        notes = notes.filter(({ id }) => id !== args[2]);
      },
    },
    "../lib/tokens": { radius: {}, TOUCH_MIN: 44 },
    "./Button": { Button: "Button" },
    "./ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
    "./FormField": { FormField: "FormField" },
    "./ProtectedModal": { ProtectedModal: "ProtectedModal" },
    "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
    "./Toast": { useToast: () => ({ push: (notice: string) => notices.push(notice) }) },
  });
  const render = () =>
    hooks.render(() =>
      TallyNotes({
        vaultId: "kaata",
        personId: "customer",
        canAdd: true,
        canRemove,
        isCurrent: () => current,
      }),
    );
  const find = (type: string) => nodes(hooks.tree).find((node) => node.type === type)!.props;
  const button = (label: string) =>
    nodes(hooks.tree).find((node) => node.type === "Button" && node.props.label === label)!.props;
  const byId = (id: string) => nodes(hooks.tree).find((node) => node.props.testID === id);

  render();
  await settleUI();
  render();
  assert.ok(byId("tally-note-note-1"));
  assert.match(JSON.stringify(hooks.tree), /Amina.*date:123/);
  assert.equal(byId("tally-note-delete-note-1"), undefined);
  button("tallyNotes.add").onPress();
  render();
  assert.equal(find("ProtectedModal").visible, true);
  assert.equal(button("entry.save").disabled, true);
  find("FormField").onChangeText("😀".repeat(501));
  render();
  assert.equal(button("entry.save").disabled, true);
  assert.equal(find("FormField").error, "tallyNotes.invalidText");
  find("FormField").onChangeText("😀".repeat(500));
  render();
  assert.equal(button("entry.save").disabled, false);
  find("FormField").onChangeText("  Record a bag for me  ");
  render();
  writeGate = deferred<void>();
  button("entry.save").onPress();
  button("entry.save").onPress();
  assert.deepEqual(writes, [["kaata", "customer", "Record a bag for me"]]);
  writeGate.resolve();
  await settleUI();
  render();
  assert.equal(find("ProtectedModal").visible, false);
  assert.ok(byId("tally-note-new"));

  canRemove = true;
  render();
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
  byId("tally-note-delete-new")!.props.onPress();
  render();
  find("ConfirmDialog").onConfirm();
  await settleUI();
  render();
  assert.deepEqual(writes[1], ["kaata", "customer", "new"]);
  assert.equal(byId("tally-note-new"), undefined);
  assert.deepEqual(notices, ["customerNote.saved", "tallyNotes.deleted"]);

  readGate = deferred<typeof notes>();
  refresh();
  current = false;
  hooks.unmount();
  readGate.resolve(notes);
  await settleUI();
  assert.equal(hooks.lateWrites, 0, "A departed person's late note read cannot repaint");
  console.log(
    "PASS tally notes UI: viewer add, Unicode input, duplicate guard, author/date, confirmed manager removal and stale focus/role guards",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
