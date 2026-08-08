import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useEffect, useRef, useState } from "react";
import { Animated, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { ComponentProps } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import { SHEET_BLUR_METHOD } from "../lib/blur";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";

export type SheetAction = {
  label: string;
  icon?: ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
  destructive?: boolean;
};

const OFFSCREEN = 600;
// Exit animation: timing(translateY, 180ms) + timing(opacity, 160ms). We wait
// slightly longer than the longest leg so the sheet's <Modal> has unmounted
// before the action fires — critical for actions that present another Modal
// (e.g. Edit → router.push to a modal screen). Without this delay, the two
// Modals overlap mid-frame on Android and the second one renders blank.
const EXIT_DURATION_MS = 220;

export function BottomSheet(props: {
  visible: boolean;
  title?: string;
  actions: SheetAction[];
  onDismiss: () => void;
}) {
  const [rendered, setRendered] = useState(false);
  const isRTL = useIsRTL();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(OFFSCREEN)).current;

  useEffect(() => {
    if (props.visible) {
      setRendered(true);
      requestAnimationFrame(() => {
        Animated.parallel([
          Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            friction: 11,
            tension: 75,
          }),
        ]).start();
      });
    } else if (rendered) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: OFFSCREEN, duration: 180, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setRendered(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  if (!rendered) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={props.onDismiss}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <BlurView
          intensity={20}
          tint="light"
          blurMethod={SHEET_BLUR_METHOD}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.tint} />
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onDismiss} />
      </Animated.View>

      <Animated.View
        style={[styles.sheetContainer, { transform: [{ translateY }] }]}
        pointerEvents="box-none"
      >
        <SafeAreaView edges={["bottom"]} style={styles.sheetWrap}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.grabber} />
            {props.title ? <Text style={[styles.title, textDir(isRTL)]}>{props.title}</Text> : null}
            {props.actions.map((a, i) => {
              const color = a.destructive ? colors.danger : colors.textEmphasis;
              return (
                <Pressable
                  key={i}
                  onPress={() => {
                    props.onDismiss();
                    setTimeout(a.onPress, EXIT_DURATION_MS);
                  }}
                  style={({ pressed }) => [
                    styles.row,
                    rowDir(isRTL),
                    i !== props.actions.length - 1 && styles.rowDivider,
                    pressed && { backgroundColor: colors.bgMuted },
                  ]}
                >
                  {a.icon ? (
                    <Ionicons
                      name={a.icon}
                      size={18}
                      color={color}
                      style={[styles.rowIcon, isRTL ? styles.rowIconRTL : styles.rowIconLTR]}
                    />
                  ) : (
                    <View style={[styles.rowIcon, isRTL ? styles.rowIconRTL : styles.rowIconLTR]} />
                  )}
                  <Text style={[styles.rowText, textDir(isRTL), { color }]}>{a.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  tint: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.08)" },
  sheetContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  sheetWrap: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  sheet: { paddingTop: 8, paddingBottom: 8 },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderEmphasis,
    marginBottom: 8,
  },
  title: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    paddingHorizontal: 20,
    paddingVertical: 10,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  rowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  rowIcon: { width: 22 },
  rowIconLTR: { marginRight: 12 },
  rowIconRTL: { marginLeft: 12 },
  rowText: { fontSize: 15, fontFamily: fonts.sansMedium },
});
