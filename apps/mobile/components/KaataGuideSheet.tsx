import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useEffect, useRef, useState } from "react";
import { Animated, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SHEET_BLUR_METHOD } from "../lib/blur";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import { Button } from "./Button";
import { KaataConceptCard } from "./KaataConceptCard";

// KaataGuideSheet — one-time "your kaata vs tallies" explainer.
//
// Audience: users who completed onboarding BEFORE the concept card existed
// (or who arrived via restore / invite-accept and never saw the onboarding
// kaata step). Real usage showed most of them created a tally contact where
// they should have created/named their kaata. New-flow users never see this —
// onboarding/kaata.tsx sets kaata_guide_seen=1 after showing the same diagram.
//
// Shown once from home (app/index.tsx gates on app_meta kaata_guide_seen),
// dismissible three ways (Got it, backdrop tap, hardware back) — every path
// marks it seen via onDismiss; there is deliberately no way to keep nagging.
// The "Rename" affordance exists because some existing users named their
// kaata after a customer (the earlier copy bug) — it routes to
// /vault/settings where the rename lives, deferred by EXIT_DURATION_MS so
// the Modal unmounts before the next screen pushes (the Android
// Modal-stacking trap documented in BottomSheet.tsx).
//
// NOT an overlay tour — see docs/tour-redesign.md. Plain bottom sheet, same
// wrapper chain as VaultPickerSheet / ProfileSettingsSheet so the dismiss
// animation, scrim blur, and Modal lifecycle behave identically.

const OFFSCREEN = 600;
const EXIT_DURATION_MS = 220;

export function KaataGuideSheet(props: {
  visible: boolean;
  /** Active kaata's display name, interpolated into the body copy. */
  kaataName: string;
  /** Whether the current user may rename the active kaata (owner-only —
   * vault.rename). When false (invite-accept editor/viewer on someone
   * else's kaata) the rename link is hidden — it would dead-end in
   * vault/settings' read-only name field — and the body swaps to the
   * shared-kaata phrasing ("a kaata" rather than "your kaata"). */
  canRename: boolean;
  /** Route to the rename surface (host: /vault/settings). Called AFTER the
   * sheet has dismissed + EXIT_DURATION_MS (Modal-stacking mitigation). */
  onRename: () => void;
  /** Marks the guide seen and hides the sheet. Every dismissal path lands here. */
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
            friction: 11,
            tension: 75,
            useNativeDriver: true,
          }),
        ]).start();
      });
    } else if (rendered) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }),
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

  function renameChained() {
    props.onDismiss();
    setTimeout(props.onRename, EXIT_DURATION_MS);
  }

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
          experimentalBlurMethod={SHEET_BLUR_METHOD}
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
          <View style={styles.sheet}>
            <View style={styles.grabber} />

            <View style={[styles.titleRow, rowDir(isRTL)]}>
              <Ionicons
                name="storefront-outline"
                size={20}
                color={colors.textEmphasis}
                style={isRTL ? { marginLeft: 8 } : { marginRight: 8 }}
              />
              <Text style={[styles.title, textDir(isRTL)]}>{t("guideSheet.title")}</Text>
            </View>

            <Text style={[styles.body, textDir(isRTL)]}>
              {t(props.canRename ? "guideSheet.body" : "guideSheet.bodyShared", {
                name: props.kaataName,
              })}
            </Text>

            <KaataConceptCard />

            {/* Rename escape hatch — for kaatas named after a customer under
                the old copy. Quiet text link, not a button: most users' kaata
                name is fine and the primary action is simply acknowledging.
                Owner-only: hidden when the user can't rename (see canRename). */}
            {props.canRename ? (
              <Pressable
                onPress={renameChained}
                accessibilityRole="button"
                style={({ pressed }) => [styles.renameLink, pressed && { opacity: 0.6 }]}
              >
                <Text style={[styles.renameText, textDir(isRTL)]}>{t("guideSheet.rename")}</Text>
              </Pressable>
            ) : (
              <View style={{ height: 14 }} />
            )}

            <Button label={t("guideSheet.gotIt")} onPress={props.onDismiss} />
          </View>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  tint: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.08)" },
  sheetContainer: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheetWrap: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  sheet: { paddingTop: 8, paddingHorizontal: 20, paddingBottom: 16 },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderEmphasis,
    marginBottom: 12,
  },
  titleRow: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  title: {
    fontSize: 17,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  body: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    lineHeight: 21,
    marginBottom: 14,
  },
  renameLink: {
    paddingVertical: 12,
    marginTop: 2,
    marginBottom: 2,
  },
  renameText: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    textDecorationLine: "underline",
  },
});
