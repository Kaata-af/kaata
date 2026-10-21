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
import { radius, space, TOUCH_MIN, typography } from "../lib/tokens";
import { Button } from "./Button";
import { SheetBackdrop } from "./SheetBackdrop";
import { SheetHandle } from "./SheetHandle";
import { useSheetDrag } from "../lib/use-sheet-drag";

type CustomerListOptionsProps = {
  preference: CustomerListPreference;
  groups: readonly CustomerGroup[];
  isRTL: boolean;
  onChange: (preference: CustomerListPreference) => void;
};

/** Shared in-flow controls, including inside the search sheet's own scroll area. */
export function CustomerListOptions(props: CustomerListOptionsProps) {
  const choice = (
    key: string,
    label: string,
    selected: boolean,
    onPress: () => void,
    kind: "sort" | "group",
  ) => (
    <Pressable
      key={key}
      accessibilityRole={kind === "sort" ? "radio" : "checkbox"}
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, selected }}
      onPress={onPress}
      style={({ pressed }) => [
        kind === "sort" ? styles.sortChoice : styles.groupChoice,
        kind === "sort" && key === "outstanding_name" && styles.defaultSort,
        rowDir(props.isRTL),
        selected && (kind === "sort" ? styles.sortSelected : styles.groupSelected),
        pressed && styles.pressed,
      ]}
    >
      <Ionicons
        name={
          kind === "sort"
            ? selected
              ? "radio-button-on"
              : "radio-button-off"
            : selected
              ? "checkbox"
              : "square-outline"
        }
        size={18}
        color={selected && kind === "sort" ? colors.textInverted : colors.textSubtle}
      />
      <Text
        style={[
          styles.choiceLabel,
          textDir(props.isRTL),
          selected && styles.selectedLabel,
          selected && kind === "sort" && styles.sortSelectedLabel,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View style={styles.options}>
      <View style={styles.optionsSection}>
        <View style={[styles.sectionHeading, rowDir(props.isRTL)]}>
          <Ionicons name="swap-vertical-outline" size={18} color={colors.textSubtle} />
          <Text style={[styles.section, textDir(props.isRTL)]}>{t("customers.sort")}</Text>
        </View>
        <View style={[styles.sortChoices, rowDir(props.isRTL)]}>
          {CUSTOMER_SORTS.map((sort) =>
            choice(
              sort,
              t(`customers.sort.${sort}`),
              props.preference.sort === sort,
              () => props.onChange({ ...props.preference, sort }),
              "sort",
            ),
          )}
        </View>
      </View>
      {props.groups.length > 0 ? (
        <View style={styles.optionsSection}>
          <View style={[styles.sectionHeading, rowDir(props.isRTL)]}>
            <Ionicons name="people-outline" size={18} color={colors.textSubtle} />
            <Text style={[styles.section, textDir(props.isRTL)]}>{t("groups.filter")}</Text>
          </View>
          <Text style={[styles.help, textDir(props.isRTL)]}>{t("groups.filterHelp")}</Text>
          <View style={[styles.groupChoices, rowDir(props.isRTL)]}>
            {[
              { id: "all", name: t("groups.all") },
              { id: "ungrouped", name: t("groups.ungrouped") },
              ...props.groups,
            ].map((group) =>
              choice(
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
                "group",
              ),
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

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
        <SafeAreaView {...drag.surfacePanHandlers} edges={["bottom"]} style={styles.content}>
          <SheetHandle panHandlers={drag.panHandlers} onDismiss={drag.dismiss} />
          <Text style={[styles.title, textDir(props.isRTL)]}>{t("customers.listOptions")}</Text>
          <ScrollView {...drag.scrollProps} bounces={false} style={styles.optionsScroll}>
            {CustomerListOptions(props)}
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
  options: { padding: space.lg, gap: space.lg },
  optionsSection: {
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
    gap: space.md,
  },
  sectionHeading: { alignItems: "center", gap: space.sm },
  section: { ...typography.labelBold, color: colors.textEmphasis, flexShrink: 1 },
  help: { ...typography.bodySm, color: colors.textSubtle },
  sortChoices: { flexWrap: "wrap", gap: space.sm },
  sortChoice: {
    flexGrow: 1,
    flexBasis: "45%",
    minWidth: 0,
    maxWidth: "100%",
    minHeight: TOUCH_MIN,
    padding: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    gap: space.sm,
  },
  defaultSort: { flexBasis: "100%" },
  sortSelected: { backgroundColor: colors.bgInverted, borderColor: colors.bgInverted },
  sortSelectedLabel: { color: colors.textInverted },
  groupChoices: { flexWrap: "wrap", gap: space.sm },
  groupChoice: {
    minHeight: TOUCH_MIN,
    maxWidth: "100%",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    gap: space.sm,
  },
  groupSelected: { borderColor: colors.actionPrimary, backgroundColor: colors.bgSubtle },
  choiceLabel: { ...typography.bodySm, color: colors.textDefault, flexShrink: 1 },
  selectedLabel: { fontFamily: fonts.sansSemi },
  pressed: { opacity: 0.65 },
});
