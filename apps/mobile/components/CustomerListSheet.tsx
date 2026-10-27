import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";
import { rowDir, textDir } from "../lib/direction";
import { t } from "../lib/i18n";
import {
  CUSTOMER_BALANCE_FILTERS,
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
import { SheetSurface } from "./SheetSurface";
import { useSheetDrag } from "../lib/use-sheet-drag";

type CustomerListOptionsProps = {
  preference: CustomerListPreference;
  groups: readonly CustomerGroup[];
  isRTL: boolean;
  onChange: (preference: CustomerListPreference) => void;
  compact?: boolean;
  amountSortAvailable?: boolean;
  /** A parent popup already supplies the card and padding. */
  embedded?: boolean;
};

/** Shared in-flow controls, including inside the search sheet's own scroll area. */
export function CustomerListOptions(props: CustomerListOptionsProps) {
  const choice = (
    key: string,
    label: string,
    selected: boolean,
    onPress: () => void,
    kind: "sort" | "balance" | "group",
  ) => (
    <Pressable
      key={key}
      accessibilityRole={kind === "group" ? "checkbox" : "radio"}
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, selected }}
      onPress={onPress}
      style={({ pressed }) => [
        kind === "group" ? styles.groupChoice : styles.sortChoice,
        props.compact && styles.choiceCompact,
        ((kind === "sort" && key === "recent") || (kind === "balance" && key === "all")) &&
          styles.defaultSort,
        rowDir(props.isRTL),
        selected && (kind === "group" ? styles.groupSelected : styles.sortSelected),
        pressed && styles.pressed,
      ]}
    >
      <Ionicons
        name={
          kind !== "group"
            ? selected
              ? "radio-button-on"
              : "radio-button-off"
            : selected
              ? "checkbox"
              : "square-outline"
        }
        size={18}
        color={selected && kind !== "group" ? colors.textInverted : colors.textSubtle}
      />
      <Text
        style={[
          styles.choiceLabel,
          textDir(props.isRTL),
          selected && styles.selectedLabel,
          selected && kind !== "group" && styles.sortSelectedLabel,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
  const section = (children: ReactNode) =>
    props.embedded ? (
      children
    ) : (
      <View style={[styles.optionsSection, props.compact && styles.sectionCompact]}>
        {children}
      </View>
    );
  return (
    <View style={[styles.options, props.compact && styles.optionsCompact]}>
      {section(
        <>
          <View style={[styles.sectionHeading, rowDir(props.isRTL)]}>
            <Ionicons name="wallet-outline" size={18} color={colors.textSubtle} />
            <Text style={[styles.section, textDir(props.isRTL)]}>
              {t("customers.balanceFilter")}
            </Text>
          </View>
          <Text style={[styles.help, textDir(props.isRTL)]}>
            {t("customers.balanceFilter.help")}
          </Text>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t("customers.balanceFilter")}
            style={[
              styles.sortChoices,
              rowDir(props.isRTL),
              props.compact && styles.choicesCompact,
            ]}
          >
            {CUSTOMER_BALANCE_FILTERS.map((direction) =>
              choice(
                direction,
                t(`customers.balanceFilter.${direction}`),
                (props.preference.direction ?? "all") === direction,
                () => props.onChange({ ...props.preference, direction }),
                "balance",
              ),
            )}
          </View>
        </>,
      )}
      {section(
        <>
          <View style={[styles.sectionHeading, rowDir(props.isRTL)]}>
            <Ionicons name="swap-vertical-outline" size={18} color={colors.textSubtle} />
            <Text style={[styles.section, textDir(props.isRTL)]}>{t("customers.sort")}</Text>
          </View>
          {props.amountSortAvailable === false ? (
            <Text style={[styles.help, textDir(props.isRTL)]}>
              {t("customers.sort.multiCurrencyHelp")}
            </Text>
          ) : null}
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t("customers.sort")}
            style={[
              styles.sortChoices,
              rowDir(props.isRTL),
              props.compact && styles.choicesCompact,
            ]}
          >
            {CUSTOMER_SORTS.filter(
              (sort) =>
                props.amountSortAvailable !== false ||
                (sort !== "amount_desc" && sort !== "amount_asc"),
            ).map((sort) =>
              choice(
                sort,
                t(`customers.sort.${sort}`),
                props.preference.sort === sort,
                () => props.onChange({ ...props.preference, sort }),
                "sort",
              ),
            )}
          </View>
        </>,
      )}
      {props.groups.length > 0
        ? section(
            <>
              <View style={[styles.sectionHeading, rowDir(props.isRTL)]}>
                <Ionicons name="people-outline" size={18} color={colors.textSubtle} />
                <Text style={[styles.section, textDir(props.isRTL)]}>{t("groups.filter")}</Text>
              </View>
              <Text style={[styles.help, textDir(props.isRTL)]}>{t("groups.filterHelp")}</Text>
              <View
                style={[
                  styles.groupChoices,
                  rowDir(props.isRTL),
                  props.compact && styles.choicesCompact,
                ]}
              >
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
            </>,
          )
        : null}
    </View>
  );
}

/** One small entry point for balance, sort and group choices. */
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
          },
        ]}
        pointerEvents={props.visible ? "auto" : "none"}
      >
        <SheetSurface {...drag.surfacePanHandlers} maxHeightRatio={0.78} style={styles.content}>
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
        </SheetSurface>
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
  optionsCompact: { padding: 0, gap: space.sm },
  sectionCompact: { padding: space.sm, gap: space.sm },
  choicesCompact: { gap: space.xs },
  choiceCompact: { paddingHorizontal: space.sm, paddingVertical: space.xs, gap: space.xs },
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
