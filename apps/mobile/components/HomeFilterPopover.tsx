import type { ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
import { BackHandler, ScrollView, StyleSheet, View, type ViewInstance } from "react-native";
import { SheetBackdrop } from "./SheetBackdrop";
import { colors } from "../lib/colors";
import { lift } from "../lib/tokens";

export type FilterAnchor = { x: number; y: number; width: number; height: number };
export type FilterViewport = { width: number; height: number; topInset?: number };

/** Coordinates are relative to the full-screen host, including the navigation. */
export function filterPopoverLayout(anchor: FilterAnchor, viewport: FilterViewport) {
  const gutter = 12;
  const gap = 8;
  const top = gutter + Math.max(0, viewport.topInset ?? 0);
  const width = Math.max(0, viewport.width - gutter * 2);
  const anchorY = Math.max(top + gap, Math.min(anchor.y, viewport.height));
  const left = (viewport.width - width) / 2;
  return {
    left,
    width,
    bottom: Math.max(gap, viewport.height - anchorY + gap),
    height: Math.max(0, anchorY - top - gap),
    arrowLeft: Math.max(12, Math.min(anchor.x + anchor.width / 2 - left - 5, width - 22)),
  };
}

/** An anchored overlay: opening filters never changes the customer list's layout. */
export function HomeFilterPopover(props: {
  visible: boolean;
  contextKey: string;
  anchor: FilterAnchor | null;
  viewport: FilterViewport;
  blurTarget: RefObject<ViewInstance | null>;
  disabled?: boolean;
  keyboardVisible?: boolean;
  onDismissKeyboard?: () => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true);
  const session = useRef({ visible: props.visible, key: props.contextKey, version: 0 });
  if (session.current.visible !== props.visible || session.current.key !== props.contextKey) {
    session.current = {
      visible: props.visible,
      key: props.contextKey,
      version: session.current.version + 1,
    };
  }
  const version = session.current.version;
  const current = () =>
    mounted.current && session.current.visible && session.current.version === version;
  const dismiss = () => {
    if (current() && !latest.current.disabled) latest.current.onDismiss();
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!props.visible) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!current()) return false;
      // A Back press during native keyboard dismissal belongs to the keyboard,
      // so the popup remains open until a subsequent press.
      if (latest.current.keyboardVisible && latest.current.onDismissKeyboard) {
        latest.current.onDismissKeyboard();
        return true;
      }
      dismiss();
      return true;
    });
    return () => back.remove();
  }, [props.visible, props.contextKey]);

  if (!props.visible || !props.anchor || props.viewport.width <= 0 || props.viewport.height <= 0)
    return null;
  const { arrowLeft, ...position } = filterPopoverLayout(props.anchor, props.viewport);
  return (
    <View style={styles.overlay} pointerEvents="box-none" accessibilityViewIsModal>
      <SheetBackdrop blurTarget={props.blurTarget} disabled={props.disabled} onDismiss={dismiss} />
      <View style={[styles.panel, position]}>
        <View pointerEvents="none" style={[styles.arrow, { left: arrowLeft }]} accessible={false} />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="always"
          bounces={false}
          nestedScrollEnabled
          pointerEvents={props.disabled ? "none" : "auto"}
        >
          {props.children}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, zIndex: 40 },
  panel: {
    position: "absolute",
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 14,
    backgroundColor: colors.bgDefault,
    ...lift,
  },
  scroll: { flex: 1, minHeight: 0, borderRadius: 14 },
  content: { padding: 8, gap: 8 },
  arrow: {
    position: "absolute",
    bottom: -6,
    width: 10,
    height: 10,
    transform: [{ rotate: "45deg" }],
    backgroundColor: colors.bgDefault,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.borderDefault,
  },
});
