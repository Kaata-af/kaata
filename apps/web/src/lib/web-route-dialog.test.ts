import assert from "node:assert/strict";
import { test } from "node:test";
import { openWebRouteDialog } from "./web-route-dialog";
import { preservesWorkspaceScroll } from "./web-routes";

function style() {
  const values = new Map<string, [string, string]>();
  return {
    values,
    getPropertyValue: (property: string) => values.get(property)?.[0] ?? "",
    getPropertyPriority: (property: string) => values.get(property)?.[1] ?? "",
    setProperty: (property: string, value: string, priority = "") => {
      values.set(property, [value, priority]);
    },
    removeProperty: (property: string) => {
      const value = values.get(property)?.[0] ?? "";
      values.delete(property);
      return value;
    },
  };
}

function fixture(fails = false) {
  const rootStyle = style();
  const bodyStyle = style();
  rootStyle.setProperty("overflow-y", "scroll", "important");
  bodyStyle.setProperty("overflow-x", "clip");
  const previousFocusCalls: FocusOptions[] = [];
  const headingFocusCalls: FocusOptions[] = [];
  const restored: ScrollToOptions[] = [];
  const previousFocus = {
    isConnected: true,
    focus: (options: FocusOptions) => previousFocusCalls.push(options),
  };
  const viewport = {
    scrollX: 12,
    scrollY: 640,
    scrollTo: (position: ScrollToOptions) => {
      restored.push(position);
      viewport.scrollX = position.left ?? 0;
      viewport.scrollY = position.top ?? 0;
    },
  };
  let opened = 0;
  let closed = 0;
  const dialog = {
    ownerDocument: {
      defaultView: viewport,
      documentElement: { style: rootStyle },
      body: { style: bodyStyle },
      activeElement: previousFocus,
    },
    scrollTop: 500,
    scrollLeft: 100,
    showModal: () => {
      opened++;
      assert.equal(rootStyle.getPropertyValue("overflow-y"), "hidden");
      assert.equal(bodyStyle.getPropertyValue("overflow-y"), "hidden");
      if (fails) throw new Error("dialog unavailable");
    },
    querySelector: () => ({ focus: (options: FocusOptions) => headingFocusCalls.push(options) }),
    contains: () => false,
    close: () => {
      closed++;
      // Native dialog focus restoration can scroll the underlying document.
      viewport.scrollY = 1800;
    },
  };
  return {
    dialog,
    element: dialog as unknown as HTMLDialogElement,
    viewport,
    rootStyle,
    bodyStyle,
    previousFocus,
    previousFocusCalls,
    headingFocusCalls,
    restored,
    opened: () => opened,
    closed: () => closed,
  };
}

test("billing owns its scroll and returns to the ledger position after native focus restoration", () => {
  const f = fixture();
  const rootBefore = new Map(f.rootStyle.values);
  const bodyBefore = new Map(f.bodyStyle.values);
  const close = openWebRouteDialog(f.element);
  assert.equal(f.dialog.scrollTop, 0);
  assert.equal(f.dialog.scrollLeft, 0);
  assert.deepEqual(f.headingFocusCalls, [{ preventScroll: true }]);
  assert.equal(f.rootStyle.getPropertyPriority("overflow-y"), "important");
  f.bodyStyle.setProperty("color", "red");
  close();
  assert.deepEqual(f.previousFocusCalls, [{ preventScroll: true }]);
  assert.deepEqual(f.restored, [{ left: 12, top: 640, behavior: "instant" }]);
  assert.deepEqual(f.rootStyle.values, rootBefore);
  assert.deepEqual(f.bodyStyle.values, new Map([...bodyBefore, ["color", ["red", ""]]]));
  close();
  assert.equal(f.closed(), 1, "cleanup is idempotent");
});

test("effect replay and a failed open cannot leave document scrolling locked", () => {
  const f = fixture();
  const before = new Map(f.rootStyle.values);
  openWebRouteDialog(f.element)();
  const close = openWebRouteDialog(f.element);
  close();
  assert.equal(f.opened(), 2);
  assert.equal(f.viewport.scrollY, 640);
  assert.deepEqual(f.rootStyle.values, before);
  const failed = fixture(true);
  const failedBefore = new Map(failed.rootStyle.values);
  assert.throws(() => openWebRouteDialog(failed.element), /dialog unavailable/);
  assert.deepEqual(failed.rootStyle.values, failedBefore);
  assert.equal(failed.viewport.scrollY, 640);
});

test("cleanup does not focus a control removed while subscription was open", () => {
  const f = fixture();
  const close = openWebRouteDialog(f.element);
  f.previousFocus.isConnected = false;
  close();
  assert.deepEqual(f.previousFocusCalls, []);
  assert.equal(f.viewport.scrollY, 640);
});

test("billing navigation preserves ledger scroll while normal page changes still reset", () => {
  for (const from of ["/app", "/app/", "/app/subscription", "/app/subscription/"]) {
    for (const to of ["/app", "/app/", "/app/subscription", "/app/subscription/"]) {
      assert.equal(preservesWorkspaceScroll(from, to), true, `${from} → ${to}`);
    }
  }
  for (const [from, to] of [
    [undefined, "/app/subscription"],
    ["/app/sign-in", "/app"],
    ["/app/subscription", "/app/sign-in"],
    ["/app", "/download"],
    ["/", "/app"],
    ["/app", "/app/unknown"],
  ]) {
    assert.equal(preservesWorkspaceScroll(from, to!), false);
  }
});
