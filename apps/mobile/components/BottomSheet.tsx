import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useEffect, useRef, useState } from "react";
import { Animated, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { ComponentProps } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../lib/colors";

export type SheetAction = {
  label: string;
  icon?: ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
  destructive?: boolean;
};

const OFFSCREEN = 600;

export function BottomSheet(props: {
  visible: boolean;
  title?: string;
  actions: SheetAction[];
  onDismiss: () => void;
}) {
  const [rendered, setRendered] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(OFFSCREEN)).current;

  useEffect(() => {
    if (props.visible) {
      setRendered(true);
      requestAnimationFrame(() => {
        Animated.parallel([
          Animated.timing(opacity, {
            toValue: 1,
            duration: 220,
            useNativeDriver: true,
          }),
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
        Animated.timing(opacity, {
          toValue: 0,
          duration: 160,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: OFFSCREEN,
          duration: 180,
          useNativeDriver: true,
        }),
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
          experimentalBlurMethod="dimezisBlurView"
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
            {props.title ? <Text style={styles.title}>{props.title}</Text> : null}
            {props.actions.map((a, i) => {
              const color = a.destructive ? colors.debt : colors.textPrimary;
              return (
                <Pressable
                  key={i}
                  onPress={() => {
                    props.onDismiss();
                    a.onPress();
                  }}
                  style={({ pressed }) => [
                    styles.row,
                    i !== props.actions.length - 1 && styles.rowDivider,
                    pressed && { backgroundColor: colors.background },
                  ]}
                >
                  {a.icon ? (
                    <Ionicons name={a.icon} size={18} color={color} style={styles.rowIcon} />
                  ) : (
                    <View style={styles.rowIcon} />
                  )}
                  <Text style={[styles.rowText, { color }]}>{a.label}</Text>
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
  tint: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(245,245,245,0.1)" },
  sheetContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  sheetWrap: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  sheet: { paddingTop: 8, paddingBottom: 8 },
  grabber: {
    alignSelf: "center",
    width: 56,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: "rgba(0,0,0,0.32)",
    marginBottom: 8,
  },
  title: {
    fontSize: 12,
    color: colors.textSecondary,
    paddingHorizontal: 20,
    paddingVertical: 10,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowIcon: { width: 22, marginRight: 12 },
  rowText: { fontSize: 16, fontWeight: "500" },
});
