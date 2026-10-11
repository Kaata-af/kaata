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
import { CUSTOMER_SORTS, type CustomerListPreference } from "../lib/customer-list";
import type { CustomerGroup } from "../lib/customer-groups";
import { icon, radius } from "../lib/tokens";

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
      onRequestClose={props.onDismiss}
    >
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.18)" }]}
        onPress={props.onDismiss}
      />
      <Animated.View
        style={[
          styles.container,
          { transform: [{ translateY: slide }], maxHeight: Dimensions.get("window").height * 0.78 },
        ]}
      >
        <SafeAreaView edges={["bottom"]} style={{ flexShrink: 1 }}>
          <View style={styles.grabber} />
          <Text style={[styles.title, textDir(props.isRTL)]}>{t("customers.listOptions")}</Text>
          <ScrollView bounces={false}>
            <Text style={[styles.section, textDir(props.isRTL)]}>{t("customers.sort")}</Text>
            {CUSTOMER_SORTS.map((sort) =>
              row(sort, t(`customers.sort.${sort}`), props.preference.sort === sort, () =>
                props.onChange({ ...props.preference, sort }),
              ),
            )}
            <Text style={[styles.section, textDir(props.isRTL)]}>{t("groups.filter")}</Text>
            {[
              { id: "all", name: t("groups.all") },
              { id: "ungrouped", name: t("groups.ungrouped") },
              ...props.groups,
            ].map((group) =>
              row(group.id, group.name, props.preference.group === group.id, () =>
                props.onChange({ ...props.preference, group: group.id }),
              ),
            )}
            {props.canManage
              ? row("manage", t("groups.manage"), false, () => {
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
                })
              : null}
          </ScrollView>
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
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: radius.grabber,
    backgroundColor: colors.borderEmphasis,
    marginTop: 10,
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
});
