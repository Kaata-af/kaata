import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";
import { rowDir, textDir } from "../lib/direction";
import { t } from "../lib/i18n";
import {
  CUSTOMER_SORTS,
  selectedCustomerGroupIds,
  toggleCustomerGroupFilter,
  type CustomerListPreference,
} from "../lib/customer-list";
import type { CustomerGroup } from "../lib/customer-groups";
import { icon, radius } from "../lib/tokens";
import { Button } from "./Button";
import { SheetBackdrop } from "./SheetBackdrop";
import { SheetHandle } from "./SheetHandle";
import { useSheetDrag } from "../lib/use-sheet-drag";

/** One small entry point, two independent choices; no permanent filter bar. */
export function CustomerListSheet(props: {
  visible: boolean;
  preference: CustomerListPreference;
  groups: readonly CustomerGroup[];
  canManage: boolean;
  isRTL: boolean;
  contextKey: string;
  onChange: (preference: CustomerListPreference) => void;
  onManage: () => void;
  onDismiss: () => void;
}) {
  const [rendered, setRendered] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const slide = useRef(new Animated.Value(600)).current;
  const drag = useSheetDrag(props.visible, slide, props.onDismiss);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true),
    generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) setReducedMotion(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    return () => {
      alive = false;
      mounted.current = false;
      generation.current++;
      if (actionTimer.current) clearTimeout(actionTimer.current);
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (props.visible || !props.canManage) {
      if (actionTimer.current) clearTimeout(actionTimer.current);
      actionTimer.current = null;
    }
    return () => {
      if (actionTimer.current) clearTimeout(actionTimer.current);
      actionTimer.current = null;
    };
  }, [props.contextKey, props.canManage]);
  useEffect(() => {
    const request = ++generation.current;
    let frame: number | null = null,
      animation: Animated.CompositeAnimation | undefined;
    slide.stopAnimation();
    if (props.visible) {
      if (actionTimer.current) clearTimeout(actionTimer.current);
      actionTimer.current = null;
      setRendered(true);
      if (reducedMotion) slide.setValue(0);
      else
        frame = requestAnimationFrame(() => {
          if (!mounted.current || request !== generation.current || !latest.current.visible) return;
          animation = Animated.spring(slide, {
            toValue: 0,
            useNativeDriver: true,
            friction: 11,
            tension: 75,
          });
          animation.start();
        });
    } else if (reducedMotion) {
      slide.setValue(600);
      setRendered(false);
    } else {
      animation = Animated.timing(slide, { toValue: 600, duration: 220, useNativeDriver: true });
      animation.start(({ finished }) => {
        if (
          finished &&
          mounted.current &&
          request === generation.current &&
          !latest.current.visible
        )
          setRendered(false);
      });
    }
    return () => {
      generation.current++;
      if (frame != null) cancelAnimationFrame(frame);
      animation?.stop();
    };
  }, [props.visible, reducedMotion, slide]);
  if (!rendered) return null;
  const row = (key: string, label: string, selected: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        rowDir(props.isRTL),
        pressed && { backgroundColor: colors.bgMuted },
      ]}
    >
      <Text style={[styles.label, textDir(props.isRTL)]} numberOfLines={2}>
        {label}
      </Text>
      {selected ? <Ionicons name="checkmark" size={icon.row} color={colors.actionPrimary} /> : null}
    </Pressable>
  );
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={drag.dismiss}
    >
      {/* The blur fades with the sheet, like every other sheet, instead of
          snapping on and off. */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            opacity: slide.interpolate({
              inputRange: [0, 600],
              outputRange: [1, 0],
              extrapolate: "clamp",
            }),
          },
        ]}
      >
        <SheetBackdrop onDismiss={drag.dismiss} />
      </Animated.View>
      <Animated.View
        style={[
          styles.container,
          {
            transform: [{ translateY: drag.translateY }],
            maxHeight: Dimensions.get("window").height * 0.78,
          },
        ]}
        pointerEvents={props.visible ? "auto" : "none"}
      >
        <SafeAreaView edges={["bottom"]} style={styles.content}>
          <SheetHandle panHandlers={drag.panHandlers} onDismiss={drag.dismiss} />
          <Text style={[styles.title, textDir(props.isRTL)]}>{t("customers.listOptions")}</Text>
          <ScrollView bounces={false} style={styles.optionsScroll}>
            <Text style={[styles.section, textDir(props.isRTL)]}>{t("customers.sort")}</Text>
            {CUSTOMER_SORTS.map((sort) =>
              row(sort, t(`customers.sort.${sort}`), props.preference.sort === sort, () =>
                props.onChange({ ...props.preference, sort }),
              ),
            )}
            {props.groups.length > 0 ? (
              <Text style={[styles.section, textDir(props.isRTL)]}>{t("groups.filter")}</Text>
            ) : null}
            {/* All/Ungrouped mean nothing until a group exists. */}
            {props.groups.length > 0 ? (
              <Text style={[styles.help, textDir(props.isRTL)]}>{t("groups.filterHelp")}</Text>
            ) : null}
            {(props.groups.length > 0
              ? [
                  { id: "all", name: t("groups.all") },
                  { id: "ungrouped", name: t("groups.ungrouped") },
                  ...props.groups,
                ]
              : []
            ).map((group) =>
              row(
                group.id,
                group.name,
                group.id === "all" || group.id === "ungrouped"
                  ? props.preference.group === group.id
                  : selectedCustomerGroupIds(props.preference.group).includes(group.id),
                () =>
                  props.onChange({
                    ...props.preference,
                    group:
                      group.id === "all" || group.id === "ungrouped"
                        ? group.id
                        : toggleCustomerGroupFilter(props.preference.group, group.id),
                  }),
              ),
            )}
          </ScrollView>
          {props.canManage ? (
            <View style={styles.manageFooter}>
              <Button
                label={t("groups.manage")}
                accessibilityLabel={t("groups.manage")}
                icon="add-outline"
                fullWidth
                onPress={() => {
                  if (actionTimer.current || !latest.current.visible) return;
                  const scope = props.contextKey;
                  props.onDismiss();
                  actionTimer.current = setTimeout(() => {
                    actionTimer.current = null;
                    if (
                      mounted.current &&
                      !latest.current.visible &&
                      latest.current.canManage &&
                      latest.current.contextKey === scope
                    )
                      latest.current.onManage();
                  }, 240);
                }}
              />
            </View>
          ) : null}
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderTopWidth: 1,
    borderColor: colors.borderDefault,
  },
  content: { flexShrink: 1, minHeight: 0 },
  optionsScroll: { flexShrink: 1, minHeight: 0 },
  manageFooter: {
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  title: {
    fontFamily: fonts.sansSemi,
    fontSize: 17,
    color: colors.textEmphasis,
    padding: 20,
    paddingBottom: 4,
  },
  section: {
    fontFamily: fonts.sansSemi,
    fontSize: 12,
    color: colors.textSubtle,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  row: { minHeight: 48, paddingVertical: 12, paddingHorizontal: 20, alignItems: "center", gap: 12 },
  label: { flex: 1, fontFamily: fonts.sansRegular, fontSize: 15, color: colors.textDefault },
  help: {
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    color: colors.textSubtle,
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
});
