import assert from "node:assert/strict";
import { compileUI, jsx } from "./ui-fixture";

let reducedMotion = false;
const children = [jsx("Screen", { name: "home" }), jsx("Screen", { name: "customer" })];
const { MotionStack } = compileUI("../../components/MotionStack", {
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "expo-router": { Stack: "Stack" },
  "../lib/colors": { colors: { bgDefault: "white" } },
  "./SheetBackdrop": { useSheetMotionPreference: () => reducedMotion },
});
const normal = MotionStack({ children });
assert.equal(normal.props.screenOptions.animation, "default");
reducedMotion = true;
const quiet = MotionStack({ children });
assert.equal(quiet.props.screenOptions.animation, "none");
assert.equal(quiet.type, normal.type, "The navigator is updated, never replaced");
assert.equal(quiet.props.children, children, "Routes retain their identity and state");
assert.equal(quiet.props.screenOptions.headerShown, false);
assert.equal(quiet.props.screenOptions.contentStyle.backgroundColor, "white");
reducedMotion = false;
assert.equal(MotionStack({ children }).props.screenOptions.animation, "default");
console.log(
  "PASS adaptive navigator: immediate reduced transitions, normal restoration and unchanged navigator/route identity",
);
