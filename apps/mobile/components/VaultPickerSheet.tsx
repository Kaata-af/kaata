import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import {
  Animated,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import { getCurrencySymbol } from "../lib/currency";
import { SHEET_BLUR_METHOD } from "../lib/blur";
import { rowDir, textDir, trackingSafe, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import { icon, radius, ROW_MIN } from "../lib/tokens";

// VaultPickerSheet — focused vault-switcher slider.
//
// Phase 7 D-TOP-LEFT-SWITCHER: triggered by tapping the kaata name in the
// top-LEFT of the home header (per Phase 4 design). The hamburger menu is
// going away in Phase 7 — vault switching, vault add, and "manage current
// kaata" navigation all consolidate here, while every other former hamburger
// entry moves into ProfileSettingsSheet (right-side profile button).
//
// Contents (top → bottom):
//   1. Compact title: "KAATAS"
//   2. Active vault row with filled checkmark + bold name
//   3. Other non-archived vaults with outline ellipse + regular name
//   4. "+ Add a Kaata" emphasized row → routes to vault/new
//   5. Divider
//   6. "Manage current kaata" row → routes to vault/settings.tsx
//
// Wrapper chain mirrors components/BottomSheet.tsx and HamburgerMenuSheet.tsx
// exactly so the dismiss animation, scrim blur, and Modal lifecycle behave
// identically. The 220ms chained() defer is critical — without it, tapping
// "Add a Kaata" or "Manage current kaata" stacks two Modals on Android (the
// VaultPickerSheet's Modal + the destination route's Stack-modal Modal) and
// the second renders blank but tappable. See BottomSheet.tsx for the full
// write-up of that Android Modal-stacking trap.

const OFFSCREEN = 600;
const EXIT_DURATION_MS = 220;

export type VaultPickerItem = {
  id: string;
  name: string;
  // ISO code (e.g. "AFN", "USD"). Rendered as a trailing symbol on the row —
  // the two-books-per-store pattern (AFN kaata + USD kaata) needs the
  // currency legible right where kaatas are picked. Optional so non-vault
  // rows / stale callers don't break; absent → no symbol.
  currency?: string;
  archived: boolean;
};

export function VaultPickerSheet(props: {
  visible: boolean;
  activeVaultId: string | null;
  vaults: VaultPickerItem[];
  // D-VAULTPICKER-CLEANUP: archived vaults are no longer rendered inline.
  // The caller passes the archived-vault count via `archivedCount` (or 0
  // if none). When >= 1, a compact "Archived (n) >" row appears at the
  // bottom of the sheet and routes — via `onViewArchived` — to the new
  // /vault/archived screen, where the list + Restore actions live. The
  // previous `archivedVaults` + `onRestoreVault` props (the "Show
  // archived" toggle pattern) were removed.
  archivedCount?: number;
  onViewArchived?: () => void;
  onSelectVault: (vaultId: string) => void;
  onAddVault: () => void;
  onDismiss: () => void;
}) {
  const [rendered, setRendered] = useState(false);
  const isRTL = useIsRTL();
  const insets = useSafeAreaInsets();
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
            friction: 11,
            tension: 75,
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
      ]).start(({ finished }) => {
        if (finished) setRendered(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  // Defer navigation/action by EXIT_DURATION_MS so the Modal unmounts before
  // a router.push opens a second Modal — same Android stacking mitigation as
  // BottomSheet.tsx + HamburgerMenuSheet.tsx.
  function chained(action: () => void) {
    return () => {
      props.onDismiss();
      setTimeout(action, EXIT_DURATION_MS);
    };
  }

  // D-VAULTPICKER-CLEANUP: host hands us pre-filtered active vaults. The
  // picker no longer knows what "archived" means for any list — archived
  // vaults live entirely behind the bottom "Archived (n) >" link, which
  // routes to /vault/archived. Belt-and-suspenders: still filter
  // defensively in case a stale caller wires an unfiltered list.
  const activeVaults = useMemo(() => props.vaults.filter((v) => !v.archived), [props.vaults]);
  const archivedCount = props.archivedCount ?? 0;
  const hasArchived = archivedCount > 0;
  // NOTE: "Manage current kaata" moved OUT of the switcher into ProfileSettingsSheet
  // (Matee: "make the kaata switcher just the kaata switcher, no settings in it").

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
        {/* maxHeight on SafeAreaView is the load-bearing constraint that
            keeps the inner ScrollView bounded. Without it, the sheet would
            flood past the status bar on a device with many vaults. Same
            trap fixed in HamburgerMenuSheet.tsx (the original Phase 5.1
            "completely messed up slider" bug). */}
        <SafeAreaView
          edges={["bottom"]}
          style={[
            styles.sheetWrap,
            // Numeric maxHeight — "75%" against position:absolute parent with
            // no explicit height is undefined in RN. Dimensions gives a
            // concrete pixel cap. Same fix as ProfileSettingsSheet.
            { maxHeight: Dimensions.get("window").height * 0.75 },
          ]}
        >
          {/* No onStartShouldSetResponder — it was blocking ScrollView pans
              from gap areas. Modal backdrop already handles outside-taps. */}
          <View style={styles.sheet}>
            <View style={styles.grabber} />
            <Text style={[styles.title, textDir(isRTL), trackingSafe(isRTL)]}>
              {t("menu.allKaatas")}
            </Text>

            <ScrollView
              showsVerticalScrollIndicator={false}
              bounces={false}
              contentContainerStyle={{
                paddingBottom: 12 + insets.bottom * 0.25,
              }}
            >
              {activeVaults.length === 0 ? (
                <Text style={[styles.emptyHint, textDir(isRTL)]}>{t("menu.allKaatas.empty")}</Text>
              ) : (
                activeVaults.map((v) => {
                  const isActive = v.id === props.activeVaultId;
                  return (
                    <PickerItem
                      key={v.id}
                      icon={isActive ? "checkmark-circle" : "ellipse-outline"}
                      iconColor={isActive ? colors.textEmphasis : colors.textMuted}
                      label={v.name}
                      trailing={v.currency ? getCurrencySymbol(v.currency) : undefined}
                      bold={isActive}
                      // Engineering critique #6: announce active-vault
                      // selection via a11y so TalkBack / VoiceOver users
                      // hear "selected" before the row's label rather
                      // than relying on font-weight alone.
                      selected={isActive}
                      onPress={
                        isActive
                          ? // Tapping the active vault is a no-op + close —
                            // matches HamburgerMenuSheet's behavior so the
                            // user can use it as an "I'm done" affordance.
                            () => props.onDismiss()
                          : chained(() => props.onSelectVault(v.id))
                      }
                      isRTL={isRTL}
                    />
                  );
                })
              )}

              {/* "+ Add a Kaata" — emphasis styling lifts it above the
                  vault rows so it reads as an action, not another vault. */}
              <PickerItem
                icon="add-circle-outline"
                label={t("menu.allKaatas.add")}
                onPress={chained(props.onAddVault)}
                isRTL={isRTL}
                emphasis
                isLast={!hasArchived}
              />

              {/* Compact "Archived (n) >" footer. Only rendered when the caller
                  reports >= 1 archived vault. Tapping routes to /vault/archived
                  (the dedicated list + Restore actions). Archived lives here in
                  the switcher (Matee: "move the archived ones back to the
                  switcher like it was before"), not on the Account screen. */}
              {hasArchived ? (
                <>
                  <View style={styles.sectionGap} />
                  <PickerItem
                    icon="archive-outline"
                    iconColor={colors.textMuted}
                    label={t("menu.allKaatas.archived.view", {
                      count: archivedCount,
                    })}
                    onPress={chained(() => props.onViewArchived?.())}
                    isRTL={isRTL}
                    isLast
                  />
                </>
              ) : null}
            </ScrollView>
          </View>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

// --------------------------------------------------------------------------
// Sub-components
// --------------------------------------------------------------------------

function PickerItem(props: {
  icon: ComponentProps<typeof Ionicons>["name"];
  iconColor?: string;
  label: string;
  // Trailing end-of-row text (the vault's currency symbol). Placed after the
  // flex:1 text column, so rowDir's row-reverse lands it on the visual end
  // side in RTL too.
  trailing?: string;
  onPress: () => void;
  isRTL: boolean;
  bold?: boolean;
  emphasis?: boolean;
  isLast?: boolean;
  // Engineering critique #6: forwarded to accessibilityState.selected
  // so screen readers announce "selected" on the active vault row.
  // Defaults to undefined (no a11y state) on rows where selection
  // doesn't apply — add/manage/archived/etc.
  selected?: boolean;
}) {
  const color = props.emphasis ? colors.textEmphasis : colors.textDefault;
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityState={props.selected != null ? { selected: props.selected } : undefined}
      style={({ pressed }) => [
        styles.menuItem,
        rowDir(props.isRTL),
        !props.isLast && styles.menuItemDivider,
        pressed && { backgroundColor: colors.bgMuted },
      ]}
    >
      <Ionicons
        name={props.icon}
        size={icon.row}
        color={props.iconColor ?? color}
        style={props.isRTL ? { marginLeft: 14 } : { marginRight: 14 }}
      />
      <View style={styles.menuItemTextCol}>
        <Text
          style={[
            styles.menuItemLabel,
            textDir(props.isRTL),
            { color },
            (props.bold || props.emphasis) && { fontFamily: fonts.sansSemi },
          ]}
          numberOfLines={1}
        >
          {props.label}
        </Text>
      </View>
      {props.trailing ? <Text style={styles.menuItemTrailing}>{props.trailing}</Text> : null}
    </Pressable>
  );
}

// --------------------------------------------------------------------------
// Styles — mirror components/BottomSheet.tsx + HamburgerMenuSheet.tsx for the
// outer wrapper chain so the three sheets feel like one consistent surface.
// --------------------------------------------------------------------------

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
    // Screen-anchored sheet top — radius.sheet (18). Same value as before.
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  // flexShrink so SafeAreaView's maxHeight propagates to the ScrollView.
  sheet: { paddingTop: 8, paddingBottom: 0, flexShrink: 1 },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: radius.grabber,
    backgroundColor: colors.borderEmphasis,
    marginBottom: 4,
  },
  title: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  sectionGap: {
    height: 4,
    backgroundColor: colors.bgMuted,
    marginTop: 12,
    marginBottom: 0,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    // ROW_MIN (52) — same literal as before, now named. Clears TOUCH_MIN (44)
    // with margin, so no extra minHeight/hitSlop is needed on the Pressable.
    minHeight: ROW_MIN,
  },
  menuItemDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  menuItemTextCol: {
    flex: 1,
  },
  menuItemLabel: {
    fontSize: 15,
    fontFamily: fonts.sansMedium,
  },
  menuItemTrailing: {
    fontSize: 14,
    fontFamily: fonts.sansMedium,
    color: colors.textMuted,
    marginHorizontal: 4,
  },
  emptyHint: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
});
