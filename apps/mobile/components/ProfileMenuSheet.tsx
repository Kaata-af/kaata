import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useEffect, useRef, useState } from "react";
import { Animated, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { SessionUser } from "../lib/auth";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";

// Profile menu — bottom sheet that pops up when the user taps the
// profile-style icon in the home header. Two nav destinations
// (Account, Preferences) plus a header row that surfaces the current
// signed-in state at a glance.
//
// Why not BottomSheet (the action-sheet component)? The visual model is
// different here: each row has a TITLE plus a small hint sub-line
// describing what lives inside the destination, and the header row is
// purely informative (no onPress). Extending BottomSheet's `actions`
// type to support hints would dilute its single-purpose action-sheet
// API. Same animation primitives though — translateY spring-in + opacity.
//
// Animation matches BottomSheet's 220ms exit delay so action handlers
// (router.push) don't stack a second Modal mid-frame on Android.

const OFFSCREEN = 600;
const EXIT_DURATION_MS = 220;

export function ProfileMenuSheet(props: {
  visible: boolean;
  // Full SessionUser so the header row can render the Google avatar
  // when picture_url is set AND show the email below. Passing the
  // whole object (rather than email + pictureUrl as separate props)
  // keeps a single source of truth — there's never a case where one
  // is fresh and the other is stale.
  signedInUser: SessionUser | null;
  onAccount: () => void;
  onPreferences: () => void;
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
          Animated.timing(opacity, {
            toValue: 1,
            duration: 220,
            useNativeDriver: true,
          }),
          Animated.spring(translateY, {
            toValue: 0,
            friction: 12,
            tension: 80,
            useNativeDriver: true,
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
      ]).start(() => setRendered(false));
    }
  }, [props.visible, rendered, opacity, translateY]);

  if (!rendered) return null;

  // Defer dismiss-then-action by the exit duration so the Modal unmounts
  // before any router.push fires. See BottomSheet for the same trick.
  function chained(action: () => void) {
    return () => {
      props.onDismiss();
      setTimeout(action, EXIT_DURATION_MS);
    };
  }

  return (
    <Modal
      visible={rendered}
      transparent
      animationType="none"
      onRequestClose={props.onDismiss}
      statusBarTranslucent
    >
      <Animated.View style={[styles.scrim, { opacity }]}>
        <Pressable style={styles.scrimTouch} onPress={props.onDismiss} />
      </Animated.View>

      <Animated.View
        style={[styles.sheetWrap, { transform: [{ translateY }] }]}
        pointerEvents="box-none"
      >
        <SafeAreaView edges={["bottom"]}>
          <BlurView intensity={45} tint="light" style={styles.sheet}>
            {/* Signed-in state header. Informational, no onPress.
                Renders the Google avatar (if picture_url is set) at
                32px to match the visual weight of the previous
                Ionicons fallback. The Ionicons fallback handles the
                signed-out case + edge cases where the user signed in
                but Google didn't return an avatar URL. */}
            <View style={[styles.headerRow, rowDir(isRTL)]}>
              {props.signedInUser?.picture_url ? (
                <Image
                  source={{ uri: props.signedInUser.picture_url }}
                  style={[styles.headerAvatar, isRTL ? { marginLeft: 10 } : { marginRight: 10 }]}
                />
              ) : (
                <Ionicons
                  name={props.signedInUser ? "person-circle" : "person-circle-outline"}
                  size={28}
                  color={colors.textEmphasis}
                  style={isRTL ? { marginLeft: 10 } : { marginRight: 10 }}
                />
              )}
              <Text style={[styles.headerText, textDir(isRTL)]} numberOfLines={1}>
                {props.signedInUser?.email
                  ? t("profile.menu.signedInAs", { email: props.signedInUser.email })
                  : t("profile.menu.notSignedIn")}
              </Text>
            </View>

            <View style={styles.divider} />

            <MenuRow
              icon="person-outline"
              title={t("profile.menu.account")}
              hint={t("profile.menu.accountHint")}
              onPress={chained(props.onAccount)}
              isRTL={isRTL}
            />
            <View style={styles.divider} />
            <MenuRow
              icon="settings-outline"
              title={t("profile.menu.preferences")}
              hint={t("profile.menu.preferencesHint")}
              onPress={chained(props.onPreferences)}
              isRTL={isRTL}
            />
          </BlurView>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

function MenuRow(props: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  hint: string;
  onPress: () => void;
  isRTL: boolean;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.row,
        rowDir(props.isRTL),
        pressed && { backgroundColor: colors.bgMuted },
      ]}
    >
      <Ionicons
        name={props.icon}
        size={22}
        color={colors.textEmphasis}
        style={props.isRTL ? { marginLeft: 14 } : { marginRight: 14 }}
      />
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowTitle, textDir(props.isRTL)]}>{props.title}</Text>
        <Text style={[styles.rowHint, textDir(props.isRTL)]}>{props.hint}</Text>
      </View>
      <Ionicons
        name={props.isRTL ? "chevron-back" : "chevron-forward"}
        size={18}
        color={colors.textMuted}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  scrimTouch: { flex: 1 },
  sheetWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  sheet: {
    marginHorizontal: 12,
    marginBottom: 12,
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: colors.bgDefault,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  // 32px circular avatar slot — slightly larger than the 28px Ionicons
  // fallback so the actual face/photo gets enough presence.
  headerAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.bgMuted,
  },
  headerText: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderDefault,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 60,
  },
  rowTitle: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  rowHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 2,
  },
});
