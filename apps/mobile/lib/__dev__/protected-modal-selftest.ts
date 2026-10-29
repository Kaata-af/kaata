import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { compileUI, jsx, uiHooks } from "./ui-fixture";

let privateUIBlocked = false;
const hooks = uiHooks();
const { ProtectedModal } = compileUI("../../components/ProtectedModal", {
  react: hooks.react,
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "react-native": { Modal: "NativeModal", Platform: { OS: "android" } },
  "../lib/app-lock-privacy": {
    useAppLockPrivacy: () => privateUIBlocked,
    getAppLockPrivacy: () => privateUIBlocked,
  },
});

let showed = 0;
let dismissed = 0;
let requestedClose = 0;
const ref = { current: null };
const owner = { visible: true, draft: "unsaved controlled note" };
const child = jsx("SensitiveForm", { value: owner.draft });
const options = {
  visible: owner.visible,
  children: child,
  ref,
  animationType: "slide",
  transparent: true,
  presentationStyle: "overFullScreen",
  statusBarTranslucent: true,
  onShow: () => showed++,
  onDismiss: () => dismissed++,
  onRequestClose: () => requestedClose++,
};
const render = (props: any = options) => hooks.render(() => ProtectedModal(props));
const open = render();
assert.equal(open.type, "NativeModal");
assert.equal(open.props.visible, true);
assert.equal(open.props.animationType, "slide");
assert.equal(open.props.children, child);
assert.equal(open.props.ref, ref);
assert.equal(open.props.transparent, true);
assert.equal(open.props.presentationStyle, "overFullScreen");
assert.equal(open.props.statusBarTranslucent, true);
open.props.onShow({ nativeEvent: {} });
open.props.onRequestClose({ nativeEvent: {} });
assert.equal(showed, 1);
assert.equal(requestedClose, 1);

// A native callback can already be queued when the privacy store changes.
// It must consult the current store, not a render's previous unlocked value.
privateUIBlocked = true;
open.props.onShow({ nativeEvent: {} });
open.props.onRequestClose({ nativeEvent: {} });
open.props.onDismiss();
assert.equal(showed, 1);
assert.equal(requestedClose, 1);
assert.equal(dismissed, 0);
const blocked = render();
assert.equal(blocked.props.visible, false);
assert.equal(blocked.props.animationType, "none", "privacy never waits for a native slide/fade");
assert.equal(blocked.props.children, null, "no private children remain during native dismissal");
assert.equal(owner.visible, true, "privacy hiding does not invoke the owner's close action");
assert.equal(owner.draft, "unsaved controlled note");

// Native dismissal may complete just after authentication succeeds. It is
// still the privacy-driven dismissal, not a user request to discard the sheet.
privateUIBlocked = false;
const restored = render();
blocked.props.onDismiss();
assert.equal(dismissed, 0);
assert.equal(restored.props.visible, true);
assert.equal(restored.props.animationType, "slide");
assert.equal(restored.props.children, child);
assert.equal(restored.props.children.props.value, owner.draft);
open.props.onShow({ nativeEvent: {} });
open.props.onRequestClose({ nativeEvent: {} });
open.props.onDismiss();
assert.equal(showed, 1, "a previous native presentation cannot focus the restored sheet");
assert.equal(requestedClose, 1, "a previous native presentation cannot close the restored sheet");
assert.equal(dismissed, 0);
restored.props.onShow({ nativeEvent: {} });
assert.equal(showed, 2);
const closed = render({ ...options, visible: false });
assert.equal(closed.props.visible, false);
closed.props.onShow({ nativeEvent: {} });
assert.equal(showed, 2, "a hidden owner cannot receive a delayed show callback");
closed.props.onDismiss();
assert.equal(dismissed, 1, "ordinary user-driven dismissal retains native semantics");

privateUIBlocked = true;
const unknown = render({ children: child, animationType: "fade" });
assert.equal(unknown.props.visible, false, "unknown initial lock state cannot flash a modal");
assert.equal(unknown.props.children, null);
privateUIBlocked = false;
const defaultVisible = render({ children: child });
assert.equal(defaultVisible.props.visible, true, "native Modal's omitted-visible default is kept");
assert.equal(defaultVisible.props.children, child);
hooks.unmount();
defaultVisible.props.onShow({ nativeEvent: {} });
defaultVisible.props.onRequestClose({ nativeEvent: {} });
defaultVisible.props.onDismiss();
assert.equal(showed, 2, "unmounted callbacks cannot focus or close an owner's form");
assert.equal(requestedClose, 1);
assert.equal(dismissed, 1);
assert.equal(hooks.lateWrites, 0);

function iosFixture(initialBlocked = false) {
  const hooks = uiHooks();
  let blocked = initialBlocked;
  const { ProtectedModal } = compileUI("../../components/ProtectedModal", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Modal: "NativeModal", Platform: { OS: "ios" } },
    "../lib/app-lock-privacy": {
      useAppLockPrivacy: () => blocked,
      getAppLockPrivacy: () => blocked,
    },
  });
  return {
    hooks,
    setBlocked: (value: boolean) => {
      blocked = value;
    },
    render: (props: any) => hooks.render(() => ProtectedModal(props)),
  };
}

// A held iOS sheet never dismisses/re-presents across a quick background/auth
// cycle. UIKit can otherwise reject the second presentation mid-dismissal.
{
  const ios = iosFixture();
  let shows = 0,
    closes = 0,
    dismisses = 0;
  const draft = jsx("SensitiveForm", { value: "preserved iOS draft" });
  const props = {
    visible: true,
    children: draft,
    onShow: () => shows++,
    onRequestClose: () => closes++,
    onDismiss: () => dismisses++,
  };
  const first = ios.render(props);
  first.props.onShow({ nativeEvent: {} });
  ios.setBlocked(true);
  // A queued callback must also see fresh privacy before React renders.
  first.props.onRequestClose({ nativeEvent: {} });
  const hidden = ios.render(props);
  assert.equal(hidden.props.visible, true, "existing iOS native presentation is retained");
  assert.equal(hidden.props.children, null, "retained native window contains no private UI");
  hidden.props.onRequestClose({ nativeEvent: {} });
  ios.setBlocked(false);
  const restored = ios.render(props);
  assert.equal(restored.props.visible, true);
  assert.equal(restored.props.children, draft);
  assert.equal(shows, 1, "retained presentation needs no new native onShow");
  hidden.props.onDismiss();
  first.props.onRequestClose({ nativeEvent: {} });
  assert.equal(closes, 0, "queued callbacks from before lock cannot close the restored sheet");
  assert.equal(dismisses, 0);
  const closed = ios.render({ ...props, visible: false });
  assert.equal(closed.props.visible, false);
  closed.props.onDismiss();
  assert.equal(dismisses, 1, "normal iOS dismissal still reaches its owner after unlocking");
  ios.hooks.unmount();
}

// UIKit may finish presenting while the app is becoming inactive. Preserve
// this one readiness event and deliver it after unlock, never while locked.
{
  const ios = iosFixture();
  const events: any[] = [];
  let obsoleteShows = 0;
  const event = { nativeEvent: { ready: true } };
  const initial = { visible: true, children: child, onShow: () => obsoleteShows++ };
  const opening = ios.render(initial);
  ios.setBlocked(true);
  const hidden = ios.render(initial);
  opening.props.onShow(event);
  assert.equal(obsoleteShows, 0);
  const latest = { ...initial, onShow: (event: any) => events.push(event) };
  ios.render(latest);
  assert.deepEqual(events, []);
  ios.setBlocked(false);
  hidden.props.onShow(event);
  assert.deepEqual(
    events,
    [],
    "readiness waits until private children have actually been restored",
  );
  const restored = ios.render(latest);
  assert.equal(restored.props.visible, true);
  assert.deepEqual(
    events,
    [event],
    "suppressed onShow is replayed to the current owner after unlock",
  );
  hidden.props.onShow(event);
  restored.props.onShow(event);
  ios.render(latest);
  assert.deepEqual(events, [event], "a native presentation can report readiness only once");
  assert.equal(obsoleteShows, 0);
  ios.hooks.unmount();
  restored.props.onShow(event);
  assert.deepEqual(events, [event]);
}

// A new request while locked must wait. Reopening it after unlock receives its
// own real native onShow, rather than a stale event from a canceled sheet.
{
  const ios = iosFixture(true);
  let shows = 0;
  const props = { visible: true, children: child, onShow: () => shows++ };
  const deferred = ios.render(props);
  assert.equal(deferred.props.visible, false, "initially locked iOS cannot present a new sheet");
  deferred.props.onShow({ nativeEvent: {} });
  assert.equal(shows, 0);
  ios.setBlocked(false);
  const opening = ios.render(props);
  assert.equal(opening.props.visible, true);
  assert.equal(shows, 0, "deferred presentation waits for its own native readiness");
  ios.setBlocked(true);
  ios.render(props);
  opening.props.onShow({ nativeEvent: {} });
  ios.render({ ...props, visible: false });
  const requestedAgain = ios.render(props);
  assert.equal(requestedAgain.props.visible, false, "a canceled presentation is not retained");
  ios.setBlocked(false);
  const fresh = ios.render(props);
  assert.equal(shows, 0, "canceling while locked retires its pending show event");
  opening.props.onShow({ nativeEvent: {} });
  assert.equal(shows, 0);
  fresh.props.onShow({ nativeEvent: {} });
  assert.equal(shows, 1);
  ios.hooks.unmount();
}

// New sensitive native modals must use the same privacy wrapper.
const mobile = join(__dirname, "../..");
const nativeHostExceptions = new Set(["components/ProtectedModal.tsx"]);
let guardedConsumers = 0;
function audit(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      audit(path);
      continue;
    }
    if (!path.endsWith(".tsx")) continue;
    const filename = relative(mobile, path).replaceAll("\\", "/");
    const file = ts.createSourceFile(
      filename,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const source = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (source === "react-native" && imported === "Modal")
          assert.ok(nativeHostExceptions.has(filename), `${filename} bypasses app-lock privacy`);
        if (source.endsWith("/ProtectedModal") && imported === "ProtectedModal") guardedConsumers++;
      }
    }
  }
}
audit(join(mobile, "components"));
audit(join(mobile, "app"));
assert.equal(guardedConsumers, 13, "every existing sensitive modal host uses the common gate");
console.log(
  "PASS protected modals: Android windows hidden, iOS presentations retained without private children, deferred native readiness replayed once after unlock, stale/unmount callbacks blocked, controlled drafts preserved and all sensitive modal imports audited",
);
