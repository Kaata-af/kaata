// Render the real row with mocked native primitives. Pins UI behavior; this
// does NOT replace Yoga/device layout checks on iOS and Android.
//
// The tally row's look is design "A · Quiet" (refined 2026-10-11), and it was already
// regressed once by an agent, so the review-state presentation is pinned here
// in EN and RTL: rows are white whatever their state and turn bgMuted when
// opened; closed rows show only a pending amber dot. Opened rows spell out every
// state beside its colored dot in a neutral centred pill; meta lines start at the start edge with
// semibold names; review actions are the shared Button's "pill" size, with
// Accept the neutral primary at the trailing end. The pills' touch targets are
// checked through the real Button: 44pt each, and neither reaching past the
// middle of the gap between Reject and Accept, because both are final.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

type Node = { type: string; props: Record<string, any> };
const jsx = (type: string, props: Record<string, any>): Node => ({ type, props });
let slots: any[] = [],
  cursor = 0,
  rtl = false;
let capturedStyles: any;
const colors = require("../colors").colors;
const mocks: Record<string, any> = {
  "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  react: {
    memo: (f: any) => f,
    useState: (initial: any) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [
        slots[i],
        (value: any) => {
          slots[i] = typeof value === "function" ? value(slots[i]) : value;
        },
      ];
    },
    useRef: (value: any) => {
      const i = cursor++;
      return (slots[i] ??= { current: value });
    },
  },
  "react-native": {
    Pressable: "Pressable",
    Text: "Text",
    View: "View",
    StyleSheet: {
      create: (s: any) => {
        capturedStyles = s;
        return s;
      },
      hairlineWidth: 1,
    },
    Platform: { select: (s: any) => s.ios },
  },
  "@expo/vector-icons": { Ionicons: "Icon" },
  // Opaque on purpose: the row's contract is WHICH button it renders (size,
  // variant, icon, label, disabled); Button's own geometry is Button's.
  "./Button": { Button: "Button" },
  "./InitialAvatar": { InitialAvatar: "Avatar" },
  "./SelectionMark": { SelectionMark: "SelectionMark" },
  "./CreditStatusBadge": { CreditStatusBadge: "CreditStatusBadge" },
  "../lib/attribution": { chipActorFor: () => null },
  "../lib/calendar": { useCalendar() {} },
  "../lib/colors": { colors },
  "../lib/currency": {
    getCurrentCurrencyCode: () => "AFN",
    getCurrencyLabel: (code: string) => code,
  },
  "../lib/direction": {
    useIsRTL: () => rtl,
    rowDir: (r: boolean) => ({ flexDirection: r ? "row-reverse" : "row" }),
    textDir: (r: boolean) => ({ textAlign: r ? "right" : "left" }),
    // lib/direction.ts's contract: tracking is cancelled for Persian script.
    trackingSafe: (r: boolean) => (r ? { letterSpacing: 0 } : null),
  },
  "../lib/fonts": {
    fonts: { sansRegular: "Regular", sansSemi: "Semi", sansBold: "Bold", monoSemi: "MonoSemi" },
    sansLineHeight: (_: number, h: number) => h,
    monoLineHeight: (_: number, h: number) => h,
  },
  "../lib/format": {
    formatAmount: String,
    formatRelative: () => "yesterday",
    formatTimestamp: () => "12:15 PM",
  },
  "../lib/tokens": { radius: { sm: 8, md: 12, pill: 999 } },
  "../lib/i18n": {
    t: (key: string, vars?: Record<string, string>) => {
      let value = key;
      if (key === "tab.addedBy" || key === "entry.addedBy")
        value = rtl ? "ثبت‌شده توسط {name}" : "Added by {name}";
      if (key === "entry.editedBy") value = rtl ? "ویرایش توسط {name}" : "edited by {name}";
      if (key === "entry.by.self") value = rtl ? "{name} (شما)" : "{name} (you)";
      if (key === "tab.reviewedBy") value = rtl ? "بررسی‌کننده: {name}" : "Reviewed by {name}";
      if (key === "tab.disputedReason") value = rtl ? "رد شده: {reason}" : "Rejected: {reason}";
      if (key === "tab.rejectedHint")
        value = rtl ? "در ماندهٔ حساب حساب نمی‌شود." : "Not included in the balance.";
      for (const [k, v] of Object.entries(vars ?? {})) value = value.replaceAll("{" + k + "}", v);
      return value;
    },
  },
};
function compile(source: string, overrides: Record<string, any> = {}) {
  const out = {};
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "exports", js)((name: string) => {
    if (name in overrides) return overrides[name];
    assert.ok(name in mocks, "unexpected native dependency: " + name);
    return mocks[name];
  }, out);
  return out as any;
}
const { EntryRow } = compile(readFileSync(require.resolve("../../components/EntryRow"), "utf8"));
function nodes(n: any): Node[] {
  if (Array.isArray(n)) return n.flatMap(nodes);
  if (!n || typeof n !== "object") return [];
  return [n, ...nodes(n.props?.children)];
}
function words(n: any): string {
  if (Array.isArray(n)) return n.map(words).join("");
  return typeof n === "string" ? n : n?.props ? words(n.props.children) : "";
}
const style = (s: any): any =>
  Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean).map(style)) : s;
const kids = (n: any): any[] =>
  [n?.props?.children].flat(Infinity).filter((k) => k && typeof k === "object");
const pick = (o: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));
// Lookups go by what a node announces or where it sits, never by its type and
// never with a crashing `!`, so a wrong design fails an assertion by name.
const labelled = (tree: any, label: string) =>
  nodes(tree).filter((n) => n.props.accessibilityLabel === label);
const body = (tree: any) => nodes(tree).find((n) => n.type === "Pressable");
// The tappable body's lines: [status pill (opened tab rows only), amount row].
const lines = (tree: any) => kids(body(tree));
const pillOf = (tree: any) => kids(lines(tree)[0])[0];
const buttonShape = (n: any) => ({
  type: n?.type,
  size: n?.props.size,
  variant: n?.props.variant,
  icon: String(n?.props.icon).replace(/-(outline|sharp)$/, ""),
  label: n?.props.label,
  accessibilityLabel: n?.props.accessibilityLabel,
  disabled: n?.props.disabled,
});
// Every node's own resolved style. The body is read unpressed: its one fill is
// the press feedback.
const ownStyle = (n: any) =>
  style(
    typeof n?.props.style === "function" ? n.props.style({ pressed: false }) : n?.props.style,
  ) ?? {};
// Every fill and every border in a row, named by the node that carries it.
// The quiet design allows exactly these: the row's ground, the direction tile
// and, once opened, the white status pill with its hairline and its dot. A
// state tint one element in, or a coloured edge, is the old row tint again.
function paint(tree: any, pill?: any) {
  const names = new Map<any, string>([
    [tree, "row"],
    [labelled(tree, "person.action.iGave")[0], "tile"],
  ]);
  if (pill) names.set(pill, "pill").set(kids(pill)[0], "dot");
  for (const n of nodes(tree)) if (n.props?.testID === "status-dot") names.set(n, "status dot");
  return nodes(tree)
    .flatMap((n) =>
      Object.entries(ownStyle(n))
        .filter(([key]) => key === "backgroundColor" || /^border\w*(Width|Color)$/.test(key))
        .map(([key, value]) => `${names.get(n) ?? "unexpected " + n.type} ${key} ${value}`),
    )
    .sort();
}
// The REAL Button on the real design tokens, so a pill's touch target is
// pinned as it ships, not as the row asks for it. (The row's own tree keeps
// Button opaque, above, so its props stay readable.)
const tokens = compile(readFileSync(require.resolve("../../lib/tokens"), "utf8"), {
  "./fonts": mocks["../lib/fonts"],
});
const RealButton = compile(readFileSync(require.resolve("../../components/Button"), "utf8"), {
  "../lib/tokens": tokens,
}).Button;
const pressableOf = (button: any) => RealButton(button?.props ?? {});
function slopOf(button: any) {
  const slop = pressableOf(button).props.hitSlop ?? 0;
  const side = (key: string) => (typeof slop === "number" ? slop : (slop[key] ?? 0));
  return { top: side("top"), bottom: side("bottom"), left: side("left"), right: side("right") };
}
// A pill's finger target: its box plus its slop, the vertical slop cut at the
// actions row's padding (iOS hit-tests a child only inside its parent).
function touchTarget(button: any, actions: any) {
  const slop = slopOf(button);
  const box = style(pressableOf(button).props.style({ pressed: false }));
  return {
    width: box.minWidth + slop.left + slop.right,
    height:
      Math.min(slop.top, actions?.paddingTop) +
      box.minHeight +
      Math.min(slop.bottom, actions?.paddingBottom),
  };
}
const REVIEW = ["tab.reject", "tab.accept"];
assert.equal(colors.reviewPending, "#D29A00", "the only review dot is amber pending");
const base = {
  entry: { id: "1", type: "debt", amount_afn: 10, created_at: 1000, note: "Goods" },
  onAccept() {},
  onReject() {},
};
function render(props: any) {
  cursor = 0;
  return EntryRow(props);
}
function opened(props: any) {
  slots = [];
  const closed = render(props);
  body(closed)?.props.onPress();
  return render(props);
}
// Editing a tally keeps its row mounted. Its old one-line measurement must
// neither hide newly added lines nor leave a short replacement expandable.
for (const [isRTL, short, multiline, shortAgain] of [
  [false, "Goods", "Rice\n\nOil", "Paid"],
  [true, "خرید", "برنج\n\nروغن", "پرداخت شد"],
  [true, "پېرود", "وریجې\n\nغوړي", "ورکړل شول"],
] as const) {
  rtl = isRTL;
  slots = [];
  const props = (note: string, showFullNote = false) => ({
    ...base,
    entry: { ...base.entry, note },
    showFullNote,
  });
  const noteText = (tree: any, note: string) => {
    const found = nodes(tree).find(
      (node) => node.type === "Text" && node.props.accessibilityLabel === note,
    );
    assert.ok(found, "the complete authored note remains available to screen readers");
    return found;
  };
  const layout = (callback: (event: any) => void, count: number) =>
    callback({ nativeEvent: { lines: Array.from({ length: count }, () => ({})) } });

  let tree = render(props(short));
  const oldShortLayout = noteText(tree, short).props.onTextLayout;
  layout(oldShortLayout, 1);
  tree = render(props(short));
  assert.equal(noteText(tree, short).props.numberOfLines, 1);
  assert.equal(words(tree).includes("common.more"), false);

  tree = render(props(multiline));
  const newNote = noteText(tree, multiline);
  assert.equal(newNote.props.numberOfLines, undefined, "changed text is measured before clamping");
  const oldMultilineLayout = newNote.props.onTextLayout;
  layout(oldMultilineLayout, 3);
  // The previous native view can finish layout after the edited text did.
  layout(oldShortLayout, 1);
  tree = render(props(multiline));
  assert.equal(
    noteText(tree, multiline).props.numberOfLines,
    1,
    "closed rows retain the one-line preview",
  );
  assert.ok(
    words(tree).includes("common.more"),
    "an old short-note callback cannot hide the new lines",
  );
  body(tree)?.props.onPress();
  tree = render(props(multiline));
  const expanded = noteText(tree, multiline);
  assert.equal(expanded.props.numberOfLines, undefined);
  assert.equal(
    expanded.props.children[0],
    multiline,
    "expanded notes preserve authored blank lines",
  );
  assert.ok(words(tree).includes("common.less"));
  body(tree)?.props.onPress();
  tree = render(props(multiline, true));
  assert.equal(
    noteText(tree, multiline).props.numberOfLines,
    undefined,
    "search still shows the entire note",
  );

  body(tree)?.props.onPress();
  tree = render(props(shortAgain));
  assert.equal(noteText(tree, shortAgain).props.numberOfLines, undefined);
  layout(noteText(tree, shortAgain).props.onTextLayout, 1);
  layout(oldMultilineLayout, 3);
  tree = render(props(shortAgain));
  assert.equal(
    body(tree)?.props.accessibilityState.expanded,
    true,
    "editing the note keeps the row's open state",
  );
  assert.equal(noteText(tree, shortAgain).props.numberOfLines, 1);
  assert.equal(
    words(tree).includes("common.more"),
    false,
    "short replacements lose the stale more cue",
  );
  assert.equal(
    words(tree).includes("common.less"),
    false,
    "old multiline layout cannot make a short note expandable",
  );
}
for (const isRTL of [false, true]) {
  rtl = isRTL;
  const start = rtl ? "right" : "left";
  const selfProps = {
    ...base,
    selfAccountId: "self",
    tab: { by: "me", status: "pending", author_name: "Matee", author_account_id: "self" },
    onCancel() {},
  };
  slots = [];
  assert.equal(
    labelled(render(selfProps), "tab.cancel").length,
    0,
    "cancel is hidden until expanded",
  );
  const own = opened(selfProps);
  assert.ok(words(own).includes(rtl ? "Matee (شما)" : "Matee (you)"));
  assert.equal(labelled(own, "tab.cancel").length, 1);
  assert.deepEqual(
    REVIEW.map((label) => labelled(own, label).length),
    [0, 0],
    "your own tally is never yours to review",
  );
  const cancel = labelled(own, "tab.cancel")[0];
  assert.deepEqual(
    buttonShape(cancel),
    {
      type: "Button",
      size: "pill",
      variant: "secondary",
      icon: "close",
      label: "tab.cancel",
      accessibilityLabel: "tab.cancel",
      disabled: false,
    },
    "Cancel tally is a white secondary pill",
  );
  const cancelRow = style(nodes(own).find((n) => kids(n).includes(cancel))?.props.style);
  assert.equal(cancelRow?.justifyContent, "flex-end", "Cancel sits on the trailing edge");
  const cancelTarget = touchTarget(cancel, cancelRow);
  assert.ok(
    cancelTarget.width >= tokens.TOUCH_MIN && cancelTarget.height >= tokens.TOUCH_MIN,
    `Cancel tally keeps a 44pt target (${cancelTarget.width}x${cancelTarget.height})`,
  );
  for (const meta of [{ status: "accepted" }, { status: "disputed" }, { by: "them" }]) {
    assert.equal(
      labelled(opened({ ...selfProps, tab: { ...selfProps.tab, ...meta } }), "tab.cancel").length,
      0,
    );
  }
  assert.equal(
    labelled(opened({ ...selfProps, onCancel: undefined }), "tab.cancel").length,
    0,
    "viewer/closed tab has no cancellation",
  );
  assert.equal(
    labelled(
      opened({ ...selfProps, tab: { ...selfProps.tab, status: "recorded", kind: "entry" } }),
      "tab.cancel",
    ).length,
    1,
    "the author may cancel an ordinary recorded tally",
  );
  assert.equal(
    labelled(
      opened({ ...selfProps, tab: { ...selfProps.tab, status: "recorded", kind: "opening" } }),
      "tab.cancel",
    ).length,
    0,
    "joined recorded openings cannot erase the private baseline",
  );
  assert.equal(
    labelled(
      opened({ ...selfProps, tab: { ...selfProps.tab, recording_mode_known: 0 } }),
      "tab.cancel",
    ).length,
    0,
    "uncertain recovered modes cannot cancel through a review control",
  );
  assert.equal(
    labelled(
      opened({ ...base, tab: { by: "them", status: "pending", recording_mode_known: 0 } }),
      "tab.accept",
    ).length,
    0,
    "uncertain recovered modes never imply a pending approval workflow",
  );
  for (const authorId of ["colleague", undefined, null]) {
    const colleague = opened({
      ...selfProps,
      tab: { ...selfProps.tab, author_account_id: authorId },
    });
    assert.equal(
      words(colleague).includes(rtl ? "(شما)" : "(you)"),
      false,
      "same party or unknown author does not mean self",
    );
  }
  const selfMember = opened({ ...base, attribution: { author: { name: "Matee", isSelf: true } } });
  assert.ok(words(selfMember).includes(rtl ? "Matee (شما)" : "Matee (you)"));

  // Every review state, from both sides, plus an unsent ("Sending…") tally.
  const cases = [
    { key: "pending", tab: { by: "them", status: "pending" }, review: true },
    { key: "pending", tab: { by: "me", status: "pending" }, review: false },
    { key: "accepted", tab: { by: "them", status: "accepted" }, review: false },
    { key: "accepted", tab: { by: "me", status: "accepted" }, review: false },
    { key: "recorded", tab: { by: "them", status: "recorded" }, review: false },
    { key: "recorded", tab: { by: "me", status: "recorded" }, review: false },
    {
      key: "disputed",
      tab: { by: "them", status: "disputed", dispute_reason: "Wrong amount" },
      review: false,
    },
    { key: "sending", tab: { by: "me", status: "pending", local_pending: true }, review: false },
    { key: "sending", tab: { by: "them", status: "pending", local_pending: true }, review: false },
  ];
  for (const c of cases) {
    const tab: any = {
      other_label: "Shop",
      author_name: "احمد",
      reviewer_name: "Ahmad",
      status_at: 2000,
      ...c.tab,
    };
    const props = { ...base, tab };
    const what = `${c.tab.by}/${c.key}${rtl ? " (RTL)" : ""}`;
    const statusKey = "tab.status." + c.key;
    const pending = tab.status === "pending";
    const statusColor =
      c.key === "sending"
        ? colors.textMuted
        : c.key === "recorded"
          ? colors.textMuted
          : c.key === "accepted"
            ? colors.reviewAccepted
            : c.key === "disputed"
              ? colors.reviewRejected
              : colors.reviewPending;

    // "I gave" keeps its pay tile; a rejected tally's tile goes grey.
    const tile = c.key === "disputed" ? colors.bgSubtle : colors.payBg;
    slots = [];
    const collapsed = render(props);
    assert.deepEqual(
      paint(collapsed),
      [
        `row backgroundColor ${colors.bgDefault}`,
        `tile backgroundColor ${tile}`,
        ...(pending ? [`status dot backgroundColor ${colors.reviewPending}`] : []),
      ].sort(),
      `${what}: a collapsed tally is white with only a pending amber dot`,
    );
    // Every state stays announced, including final states without a closed-row
    // dot. Pending's dot itself stays silent to screen readers.
    const closedDot = nodes(collapsed).find((n) => n.props?.testID === "status-dot");
    assert.equal(body(collapsed)?.props.accessibilityValue?.text, statusKey);
    assert.equal(!!closedDot, pending, `${what}: final states have no dot`);
    if (pending) {
      const dotRow = nodes(collapsed).find((n) => kids(n).includes(closedDot));
      const afterDot = kids(dotRow)[kids(dotRow).indexOf(closedDot) + 1];
      assert.deepEqual(
        {
          shape: pick(style(closedDot?.props.style), ["width", "height", "borderRadius"]),
          next: words(afterDot),
          silent: closedDot?.props.accessibilityElementsHidden === true,
        },
        { shape: { width: 6, height: 6, borderRadius: 3 }, next: "yesterday", silent: true },
        `${what}: a silent 6px pending dot right before the time`,
      );
    }
    assert.equal(
      words(collapsed).includes("tab.status."),
      false,
      "state WORDS appear only after a tap",
    );
    const collapsedFirst = style(lines(collapsed)[0]?.props.style);
    assert.equal(
      collapsedFirst?.paddingTop ?? collapsedFirst?.paddingVertical,
      12,
      `${what}: collapsed, the amount row is the first line, at full padding`,
    );

    const tree = opened(props);
    const pill = pillOf(tree);
    assert.deepEqual(
      paint(tree, pill),
      [
        `row backgroundColor ${colors.bgMuted}`,
        `tile backgroundColor ${tile}`,
        `pill backgroundColor ${colors.bgDefault}`,
        `pill borderWidth 1`,
        `pill borderColor ${colors.borderDefault}`,
        `dot backgroundColor ${statusColor}`,
      ].sort(),
      `${what}: an opened tally sits on bgMuted with a neutral pill and its state dot`,
    );
    const first = lines(tree)[0];
    const firstStyle = style(first?.props.style);
    assert.deepEqual(
      {
        words: words(first),
        direction: firstStyle?.flexDirection ?? "column",
        alignItems: firstStyle?.alignItems,
        paddingTop: firstStyle?.paddingTop,
      },
      { words: statusKey, direction: "column", alignItems: "center", paddingTop: 12 },
      `${what}: the opened tally's first line is its status, centred above the amount`,
    );
    assert.equal(
      nodes(tree).find((n) => n.type === "Text")?.props.children,
      statusKey,
      `${what}: the status is the first text rendered`,
    );
    const carriers = (n: any) =>
      nodes(n).filter((x) => x.type === "Text" && x.props.children === statusKey);
    assert.deepEqual(
      carriers(tree),
      carriers(first),
      `${what}: the pill is the status's only carrier (no old status text under the note)`,
    );
    assert.equal(
      style(lines(tree)[1]?.props.style)?.paddingTop,
      10,
      `${what}: the amount line tucks in under the pill`,
    );
    const pillStyle = style(pill?.props.style);
    assert.deepEqual(
      {
        ...pick(pillStyle, [
          "flexDirection",
          "alignItems",
          "alignSelf",
          "gap",
          "paddingHorizontal",
          "borderRadius",
          "borderWidth",
          "borderColor",
          "backgroundColor",
        ]),
        height22to24: pillStyle?.minHeight >= 22 && pillStyle?.minHeight <= 24,
      },
      {
        flexDirection: rtl ? "row-reverse" : "row",
        alignItems: "center",
        alignSelf: undefined,
        gap: 6,
        paddingHorizontal: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: colors.borderDefault,
        backgroundColor: colors.bgDefault,
        height22to24: true,
      },
      `${what}: a neutral white pill with a hairline border`,
    );
    const pillChildren = kids(pill);
    assert.equal(pillChildren.length, 2, `${what}: every opened status label has a dot`);
    const label = pillChildren.at(-1);
    assert.deepEqual(
      pick(style(pillChildren[0]?.props.style), [
        "width",
        "height",
        "borderRadius",
        "backgroundColor",
      ]),
      { width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor },
      `${what}: the status dot matches pending/accepted/rejected/sending`,
    );
    assert.equal(pillChildren[0]?.props.accessibilityElementsHidden, true);
    const labelStyle = style(label?.props.style);
    assert.deepEqual(
      {
        type: label?.type,
        text: label?.props.children,
        numberOfLines: label?.props.numberOfLines,
        ...pick(labelStyle, ["fontSize", "fontFamily", "color", "letterSpacing"]),
      },
      {
        type: "Text",
        text: statusKey,
        numberOfLines: 1,
        fontSize: 11,
        fontFamily: "Semi",
        color: colors.textDefault,
        // Latin keeps its 0.2 tracking; trackingSafe() zeroes it for Persian.
        letterSpacing: rtl ? 0 : 0.2,
      },
      `${what}: 11px semibold label in body ink`,
    );
    if (rtl) {
      assert.deepEqual(
        nodes(tree)
          .filter((n) => n.type === "Text" && style(n.props.style)?.letterSpacing)
          .map(words),
        [],
        `${what}: no Dari text is tracked (it severs Persian joining)`,
      );
    }

    // Meta lines keep their content, start at the start edge, and name people
    // in semibold body ink.
    const metaPattern = rtl
      ? /^(ثبت‌شده توسط|رد شده:|بررسی‌کننده:|در ماندهٔ)/
      : /^(Added by|Rejected:|Reviewed by|Not included)/;
    const metas = nodes(tree).filter((n) => n.type === "Text" && metaPattern.test(words(n)));
    const reviewed = !tab.local_pending && (tab.status === "accepted" || tab.status === "disputed");
    assert.deepEqual(
      metas.map(words),
      [
        rtl ? "ثبت‌شده توسط احمد" : "Added by احمد",
        ...(tab.status === "disputed"
          ? [rtl ? "رد شده: Wrong amount" : "Rejected: Wrong amount"]
          : []),
        ...(reviewed
          ? [rtl ? "بررسی‌کننده: Ahmad · 12:15 PM" : "Reviewed by Ahmad · 12:15 PM"]
          : []),
        ...(tab.status === "disputed"
          ? [rtl ? "در ماندهٔ حساب حساب نمی‌شود." : "Not included in the balance."]
          : []),
      ],
      `${what}: author, reason, reviewer and hint lines keep their content`,
    );
    assert.deepEqual(
      metas.map((n) => pick(style(n.props.style), ["textAlign", "fontSize", "color"])),
      metas.map(() => ({ textAlign: start, fontSize: 12, color: colors.textSubtle })),
      `${what}: every meta line is 12px textSubtle at the start edge (the trailing edge is the date's)`,
    );
    const name = nodes(metas[0]).find((n) => n.type === "Text" && n.props.children === "احمد");
    assert.deepEqual(
      pick(style(name?.props.style), ["fontFamily", "color"]),
      { fontFamily: "Semi", color: colors.textDefault },
      `${what}: names are semibold body ink, not bold`,
    );

    // Review actions: the other party's pending tally only, collapsed too.
    for (const [state, row] of [
      ["collapsed", collapsed],
      ["opened", tree],
    ] as const) {
      // `parts` = the row's top-level children: an actions row is a second
      // part, so a row without actions must not leave an empty padded one.
      assert.deepEqual(
        { actions: REVIEW.map((l) => labelled(row, l).length), parts: kids(row).length },
        { actions: c.review ? [1, 1] : [0, 0], parts: c.review ? 2 : 1 },
        `${what} ${state}: ${c.review ? "Accept and Reject show" : "no review actions, no actions row"}`,
      );
      if (!c.review) continue;
      assert.deepEqual(
        buttonShape(labelled(row, "tab.reject")[0]),
        {
          type: "Button",
          size: "pill",
          variant: "secondary",
          icon: "close",
          label: "tab.reject",
          accessibilityLabel: "tab.reject",
          disabled: false,
        },
        `${what} ${state}: Reject is a white secondary pill`,
      );
      assert.deepEqual(
        buttonShape(labelled(row, "tab.accept")[0]),
        {
          type: "Button",
          size: "pill",
          variant: "primary",
          icon: "checkmark",
          label: "tab.accept",
          accessibilityLabel: "tab.accept",
          disabled: false,
        },
        `${what} ${state}: Accept is the black primary pill, never the collect green`,
      );
      assert.deepEqual(
        nodes(row)
          .filter((n) => REVIEW.includes(n.props.accessibilityLabel))
          .map((n) => n.props.accessibilityLabel),
        REVIEW,
        `${what} ${state}: Accept follows Reject, so it is the outermost pill`,
      );
      const [reject, accept] = REVIEW.map((l) => labelled(row, l)[0]);
      const actionsStyle = style(nodes(row).find((n) => kids(n).includes(reject))?.props.style);
      // Yoga's own rule: columnGap / rowGap override the `gap` shorthand.
      const actions = {
        ...actionsStyle,
        columnGap: actionsStyle?.columnGap ?? actionsStyle?.gap,
        rowGap: actionsStyle?.rowGap ?? actionsStyle?.gap,
      };
      assert.deepEqual(
        {
          ...pick(actions, [
            "flexDirection",
            "flexWrap",
            "justifyContent",
            "columnGap",
            "paddingHorizontal",
            "backgroundColor",
          ]),
          bottom10to12: actions.paddingBottom >= 10 && actions.paddingBottom <= 12,
        },
        {
          flexDirection: rtl ? "row-reverse" : "row",
          // Too wide for one line at large text sizes, the pills wrap rather
          // than spill past the card's clipped edge.
          flexWrap: "wrap",
          justifyContent: "flex-end",
          columnGap: 8,
          paddingHorizontal: 14,
          backgroundColor: undefined,
          bottom10to12: true,
        },
        `${what} ${state}: actions hug the trailing edge on the 14px gutter`,
      );
      // Touch geometry, through the real Button. Both decisions are final and
      // unconfirmed, so a tap nearer one pill must never land on the other:
      // neither pill's slop may reach past the middle of the gap between them
      // (or of rowGap once they wrap). Overlap is worse still, because iOS and
      // Android both hit-test the LAST sibling first and give it all to
      // Accept. And each pill must still be a 44pt target.
      const [rejectSlop, acceptSlop] = [reject, accept].map(slopOf);
      const facing = rtl
        ? [rejectSlop.left, acceptSlop.right]
        : [rejectSlop.right, acceptSlop.left];
      assert.deepEqual(
        {
          sideBySide: Math.max(...facing) <= actions.columnGap / 2,
          wrapped: Math.max(rejectSlop.bottom, acceptSlop.top) <= actions.rowGap / 2,
        },
        { sideBySide: true, wrapped: true },
        `${what} ${state}: no tap nearer Reject reaches Accept, or the reverse`,
      );
      for (const button of [reject, accept]) {
        const target = touchTarget(button, actions);
        assert.ok(
          target.width >= tokens.TOUCH_MIN && target.height >= tokens.TOUCH_MIN,
          `${what} ${state}: ${button?.props.label} keeps a 44pt target (${target.width}x${target.height})`,
        );
      }
    }
    if (tab.status === "disputed") {
      const amount = nodes(tree).find((n) => n.type === "Text" && n.props.children === "10");
      assert.equal(style(amount?.props.style)?.textDecorationLine, "line-through");
    }
  }
  slots = [];
  const viewer = render({
    ...base,
    onAccept: undefined,
    onReject: undefined,
    tab: { by: "them", status: "pending" },
  });
  assert.deepEqual(
    { actions: REVIEW.map((l) => labelled(viewer, l).length), parts: kids(viewer).length },
    { actions: [0, 0], parts: 1 },
    "no review actions, and no empty actions row, without review rights",
  );
  slots = [];
  assert.equal(
    render({ ...base, tab: { by: "me", status: "pending", voided: true } }),
    null,
    "cancelled rows are absent from the everyday list",
  );
  // A solo tally has no review state: no dot while closed, and it opens onto
  // the same quiet ground with no pill above it.
  slots = [];
  assert.deepEqual(
    paint(render(base)),
    [`row backgroundColor ${colors.bgDefault}`, `tile backgroundColor ${colors.payBg}`],
    "a private tally carries no status dot",
  );
  const solo = opened(base);
  const soloFirst = style(lines(solo)[0]?.props.style);
  assert.deepEqual(
    {
      paint: paint(solo),
      status: words(solo).includes("tab.status."),
      firstPadding: soloFirst?.paddingTop ?? soloFirst?.paddingVertical,
    },
    {
      paint: [`row backgroundColor ${colors.bgMuted}`, `tile backgroundColor ${colors.payBg}`],
      status: false,
      firstPadding: 12,
    },
    "a solo tally opens onto bgMuted with no status pill",
  );
  const member = opened({
    ...base,
    attribution: {
      author: { name: "Matee", isSelf: false },
      editor: { name: "Ahmad", isSelf: false },
    },
  });
  assert.deepEqual(
    nodes(member)
      .filter((n) => n.type === "Text" && style(n.props.style)?.fontFamily === "Semi")
      .map(words),
    ["Matee", "Ahmad"],
    "member names are semibold too",
  );
}

// Execute the shipped style declarations, not a second copied fixture.
const person = readFileSync(require.resolve("../../app/person/[id]"), "utf8");
compile(
  'const { StyleSheet, Platform } = require("react-native"); const { colors } = require("../lib/colors"); const { fonts, sansLineHeight } = require("../lib/fonts"); const { radius } = require("../lib/tokens"); const typography = {}; const TOUCH_MIN = 44; const ACTION_COIN_SIZE = 26; ' +
    person.slice(person.indexOf("const styles = StyleSheet.create(")),
);
assert.equal(capturedStyles.actions.position, "absolute");
assert.equal(capturedStyles.actions.bottom, 0);
assert.equal(capturedStyles.actionBtn.flex, undefined, "no vertical flex collapse");
assert.ok(capturedStyles.actionBtn.minHeight >= 52);
assert.equal(capturedStyles.actionBtnWrap.flex, 1, "equal-width buttons");
assert.ok(capturedStyles.actionText.lineHeight >= 20, "visible Dari line box");
// Toasts lift the dock outside its compact keyboard layout. Android prepares
// that layout on search focus, before the native keyboard-shown event arrives.
assert.match(person, /translateY: compactDock \? 0 : toastOffset/);
// WhatsApp sits beside the ⋯ menu, never inside it (#11). The old check here
// compared against a menu label that no longer exists (indexOf -1), so it
// passed without testing anything.
const menuStart = person.indexOf("<OverflowMenu");
assert.ok(menuStart > 0, "the header menu exists");
assert.equal(
  person.indexOf('label: t("person.ping', menuStart),
  -1,
  "no WhatsApp item in the menu",
);
const pingAt = person.indexOf('testID="whatsapp-reminder"');
assert.ok(pingAt > 0 && pingAt < menuStart, "the WhatsApp button comes before the menu");
// Spacing lives in the row's gap, so Dari's reversed row keeps it too.
assert.equal(capturedStyles.headerActions.gap, 10);
assert.equal(capturedStyles.headerShare.marginEnd, undefined);
console.log(
  "PASS: quiet closed rows with pending amber dots, colored opened status labels, accessible final states, start-aligned meta, separate 44pt review targets in EN/FA, cancelled rows hidden, floating full-size controls",
);

// Render the real bell/header against different safe viewports. In particular,
// the preview must not retain an x-coordinate from the bell or a 380px width cap.
let viewport = { width: 390, height: 844, fontScale: 1 };
let insets = { top: 47, bottom: 34, left: 0, right: 0 };
mocks.react.useEffect = () => {};
Object.assign(mocks["react-native"], {
  Animated: {
    View: "AnimatedView",
    Value: class {
      constructor(_: number) {}
      setValue(_: number) {}
    },
  },
  Modal: "Modal",
  ScrollView: "ScrollView",
  ActivityIndicator: "ActivityIndicator",
  useWindowDimensions: () => viewport,
});
Object.assign(mocks["../lib/tokens"], { TOUCH_MIN: 44, typography: {}, icon: {} });
mocks["expo-router"] = { router: { push() {}, back() {} } };
mocks["react-native-safe-area-context"] = {
  useSafeAreaInsets: () => insets,
  SafeAreaView: "SafeAreaView",
};
mocks["./Toast"] = { useToast: () => ({ push() {} }) };
mocks["../lib/tabs/use-inbox"] = {
  useInbox: () => ({
    page: { unread: 2, items: [], next_before: "" },
    loading: false,
    failed: false,
    signedIn: true,
    reload: async () => {},
    read: async () => {},
  }),
};
mocks["../lib/tabs/open-notification"] = { openTabNotification: async () => {} };
mocks["../lib/use-customer-reminders"] = { useCustomerReminders: () => ({ due: [], rows: [] }) };
const { NotificationBell, FullNotificationInbox } = compile(
  readFileSync(require.resolve("../../components/NotificationInbox"), "utf8"),
);
for (const width of [320, 390, 430, 844]) {
  viewport = { width, height: width === 844 ? 390 : 844, fontScale: 1 };
  insets = { top: 47, bottom: 34, left: width === 844 ? 47 : 0, right: 0 };
  for (const r of [false, true]) {
    rtl = r;
    slots = [];
    cursor = 0;
    const tree = NotificationBell();
    const anchor = nodes(tree).find((n) => n.props.ref)!;
    anchor.props.ref.current = {
      measureInWindow: (callback: any) => callback(r ? 30 : width - 90, 48, 44, 44),
    };
    nodes(tree)
      .find((n) => n.type === "Pressable")!
      .props.onPress();
    cursor = 0;
    const opened = NotificationBell();
    const popup = nodes(opened).find((n) => n.props.accessibilityViewIsModal)!;
    const frame = style(popup.props.style);
    assert.equal(frame.left, frame.right, "equal margins independent of bell/locale");
    assert.equal(frame.left, Math.max(12, insets.left + 12, insets.right + 12));
    assert.equal(frame.width, undefined, "stretch across viewport without fixed width cap");
    assert.ok(frame.top >= insets.top);
  }
}
mocks["../components/NotificationInbox"] = { FullNotificationInbox: "FullInbox" };
const { default: NotificationsScreen } = compile(
  readFileSync(require.resolve("../../app/notifications"), "utf8"),
);
const screen = NotificationsScreen();
const header = nodes(screen).find((n) => n.props.accessibilityRole === "header")!;
assert.equal(style(header.props.style).textAlign, "center");
assert.equal(style(header.props.style).flex, 1);
const bar = nodes(screen).find(
  (n) => Array.isArray(n.props.children) && n.props.children.includes(header),
)!;
assert.equal(
  style(bar.props.children[0].props.style).minWidth,
  style(bar.props.children[2].props.style).width,
  "symmetric back-button and spacer",
);
slots = [];
cursor = 0;
const content = FullNotificationInbox();
const renderedContent = content.type(content.props);
assert.equal(
  nodes(renderedContent).filter((n) => n.type === "Text" && n.props.children === "inbox.title")
    .length,
  0,
  "page title is not duplicated in the list",
);
console.log(
  "PASS: centered edge-to-edge inbox in EN/FA at 320/390/430/844px, symmetric page header, no duplicate title",
);

// The identity badge stays a fixed centered scalloped glyph, not a menu icon.
mocks["@expo/vector-icons"].MaterialIcons = "MaterialIcon";
const { SharedAccountBadge, sharedAccountBadgeOffset } = compile(
  readFileSync(require.resolve("../../components/SharedAccountBadge"), "utf8"),
);
const badge = SharedAccountBadge({ size: 20 });
assert.equal(style(badge.props.style).alignItems, "center");
assert.equal(style(badge.props.style).justifyContent, "center");
assert.equal(style(badge.props.style).flexShrink, 0);
assert.equal(nodes(badge).find((n) => n.type === "MaterialIcon")?.props.name, "verified");
for (const name of ["احمد", "Matee احمد", "۱۲۳", ""]) {
  assert.equal(
    sharedAccountBadgeOffset(name, 24, 1.5),
    0,
    "Persian and mixed script alignment stays unchanged",
  );
}
assert.ok(
  sharedAccountBadgeOffset("Matee", 15, 1) < 0,
  "Latin badge aligns with visible capitals above line-box centre",
);
assert.equal(
  sharedAccountBadgeOffset("Matee", 15, 1.5),
  sharedAccountBadgeOffset("Matee", 15, 1) * 1.5,
  "alignment follows accessibility text scale",
);
assert.match(person, /icon: "link-outline" as const/);
assert.equal(person.includes('t("tab.chip.linked"'), false);
assert.equal(person.includes("confirmVoidFor"), false, "no cancellation sheet/dialog");
for (const source of [
  person,
  readFileSync(require.resolve("../../components/PersonRow"), "utf8"),
  readFileSync(require.resolve("../../app/person/new"), "utf8"),
]) {
  assert.doesNotMatch(
    source,
    /\.(other_account_name|tab_account_name)/,
    "no parenthesized identity beside contact names",
  );
}

// TallyHighlight's native effect lifecycle, preference races and touch-through
// behavior are checked separately in tally-highlight-selftest.ts.
console.log(
  "PASS: centered badge without account suffix, self attribution, inline pending-only cancellation",
);

// The review guard, end to end. Last, because it is the only check that has
// to await: the row re-enables its actions in a `finally` after the review.
for (const direction of [false, true]) {
  rtl = direction;
  slots = [];
  const selected: string[] = [];
  let held = 0;
  const props = {
    ...base,
    selecting: true,
    selected: true,
    onToggleSelection: (entry: any) => selected.push(entry.id),
    onLongPress: () => held++,
    tab: { by: "them", status: "pending", author_name: "Synthetic reviewer" },
  };
  const row = render(props);
  assert.equal(body(row)?.props.accessibilityRole, "checkbox");
  assert.deepEqual(body(row)?.props.accessibilityState, { checked: true, disabled: undefined });
  assert.equal(
    typeof body(row)?.props.onLongPress,
    "function",
    "selection retains native release suppression",
  );
  assert.equal(labelled(row, "tab.accept").length, 0, "selection suppresses final review actions");
  assert.equal(nodes(row).find((node) => node.type === "SelectionMark")?.props.selected, true);
  body(row)?.props.onPress();
  body(row)?.props.onLongPress();
  body(row)?.props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } });
  assert.deepEqual(
    selected,
    ["1", "1", "1"],
    "tap, hold and assistive activation toggle selection",
  );
  assert.equal(body(render(props))?.props.accessibilityState.expanded, undefined);
  assert.equal(held, 0, "selection suppresses the edit gesture");
  const busy = render({ ...props, selectionDisabled: true });
  assert.equal(body(busy)?.props.disabled, true);
  body(busy)?.props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } });
  assert.equal(selected.length, 3, "busy rows ignore assistive activation too");
}
console.log(
  "PASS: selected tally checkboxes replace expansion/review gestures and respect busy state in EN/FA",
);

void (async () => {
  rtl = false;
  slots = [];
  const calls: string[] = [];
  let settle = () => {};
  const props = {
    ...base,
    tab: { by: "them", status: "pending", author_name: "احمد" },
    onAccept: () => {
      calls.push("accept");
      return new Promise<void>((resolve) => (settle = resolve));
    },
    onReject: () => void calls.push("reject"),
  };
  labelled(render(props), "tab.accept")[0]?.props.onPress();
  const busy = render(props);
  assert.deepEqual(
    REVIEW.map((l) => labelled(busy, l)[0]?.props.disabled),
    [true, true],
    "both review actions are disabled while one is in flight",
  );
  labelled(busy, "tab.reject")[0]?.props.onPress();
  assert.deepEqual(calls, ["accept"], "a second tap mid-review never sends a second decision");
  settle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    REVIEW.map((l) => labelled(render(props), l)[0]?.props.disabled),
    [false, false],
    "the actions come back once the review settles",
  );
  console.log("PASS: review actions disabled in flight, double tap ignored, re-enabled after");
})();
