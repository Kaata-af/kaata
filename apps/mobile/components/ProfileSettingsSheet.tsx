import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import type { SessionUser } from "../lib/auth";
import { colors } from "../lib/colors";
import { SHEET_BLUR_METHOD } from "../lib/blur";
import { getAccountIdSync } from "../lib/db-tx";
import {
  SETTINGS_AVATAR_HERO,
  SETTINGS_ROW_ICON_GAP,
  SETTINGS_ROW_ICON_SIZE,
  SETTINGS_ROW_PADDING_X,
  SETTINGS_SHEET_TOP_RADIUS,
} from "../lib/design-tokens";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import { useMembersCount, useLastSyncedRelative } from "../lib/use-vault-summary";
import { NavRow, SectionGap, SectionHeader } from "./SettingsScreen";

// ProfileSettingsSheet — Phase 7 unified settings surface.
//
// Replaces HamburgerMenuSheet (killed in Phase 7) + ProfileMenuSheet
// (folded in). One sheet, five sections, opens from the profile chip at
// top-RIGHT of the home header. The top-LEFT kaata name remains the vault
// switcher (VaultPickerSheet — unchanged).
//
// Phase 7 coherence pass: the sheet now imports its row/section atoms
// from components/SettingsScreen instead of redefining them inline. The
// shared NavRow carries a11y attrs (accessibilityRole=button,
// accessibilityState.disabled) and the documented danger variant — so
// "Sign out" can paint per the design-tokens.ts contract.
//
// All transient state (live account, live peer count, vault list,
// last-synced) is read on every `visible` flip — no useMemo snapshotting —
// so signing in / out / toggling Shop Mode from a pushed screen and
// returning never shows a stale paint.
//
// Phase 7 founder spec — sections, top to bottom:
//   1. ACCOUNT  — signed-in avatar+email OR Sign in with Google button.
//      Sign out + Switch account when signed in.
//   2. PREFERENCES — single NavRow opening /preferences (one tap row, no
//      duplicated section-header → identical-label row pair).
//   3. KAATAS — list of all vaults with current bolded + checkmark;
//      "+ Add a Kaata" + "Scan a pairing code"; "Manage this Kaata" link
//      to /vault/settings.
//   4. SYNC — Nearby sync toggle (NO sign-in gate per Phase 7 Part B);
//      Sync to cloud / Restore from cloud (signed-in only — server sync
//      requires auth, mesh does NOT).
//   5. ABOUT — version + build info.

const OFFSCREEN = 600;
const EXIT_DURATION_MS = 220;

export type VaultListItem = {
  id: string;
  name: string;
  archived: boolean;
};

export function ProfileSettingsSheet(props: {
  visible: boolean;

  // Identity
  signedInUser: SessionUser | null;
  activeAccountId: string | null;

  // Vault context
  activeVaultId: string | null;
  vaults: VaultListItem[];
  // D-ARCHIVED-SCREEN: archived vaults moved out of this sheet into
  // /vault/archived. Host passes the count so we can render an
  // "Archived (N) >" footer link below "Manage this Kaata". Hidden when
  // the count is 0.
  archivedCount?: number;
  onOpenArchived?: () => void;

  // Sync state
  shopModeEnabled: boolean;
  shopModeBusy?: boolean;
  syncBusy?: boolean;
  activePeers?: number;

  // About
  appVersion: string;
  buildNumber?: string;

  // --- Actions ---
  // Profile
  onSignIn: () => void;
  onSignOut: () => void;
  onSwitchAccount: () => void;

  // Preferences
  onOpenPreferences: () => void;

  // Kaatas
  onSelectVault: (vaultId: string) => void;
  onAddVault: () => void;
  /**
   * Phase 7 UX critique #4 — Scan a pairing code (other-phone entry
   * point into the local-CA pair flow). Previously the owner-side QR
   * screen pointed at "Open Menu → Pair another phone → Scan" which
   * didn't exist anywhere in the unified surfaces. This callback wires
   * to /vault/pair-scan.
   */
  onScanPairingCode: () => void;
  onManageCurrentKaata: () => void;

  // Sync
  onToggleShopMode: (next: boolean) => void;
  onSyncNow: () => void;
  onRestoreFromCloud: () => void;

  // Dismiss
  onDismiss: () => void;
}) {
  const [rendered, setRendered] = useState(false);
  const isRTL = useIsRTL();
  const insets = useSafeAreaInsets();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(OFFSCREEN)).current;

  // Reactive account_id — same pattern as the old HamburgerMenuSheet.
  // Reads the synchronous module cache on every `visible` flip so a sign-in
  // completed inline (Phase 7 D-ACCOUNT-PAGE-ROLE — /account screen was
  // killed; sign-in runs from the host's runGoogleSignIn helper) is
  // reflected immediately even if the sheet hasn't been re-rendered yet.
  const [liveAccountId, setLiveAccountId] = useState<string | null>(props.activeAccountId);
  useEffect(() => {
    if (props.visible) {
      setLiveAccountId(getAccountIdSync() ?? props.activeAccountId);
    }
  }, [props.visible, props.activeAccountId]);

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

  // Defer router.push / action callbacks by EXIT_DURATION_MS so the Modal
  // unmounts before a second Modal mounts — same Android Modal-stacking
  // mitigation as BottomSheet.tsx / the deprecated HamburgerMenuSheet.tsx.
  function chained(action: () => void) {
    return () => {
      props.onDismiss();
      setTimeout(action, EXIT_DURATION_MS);
    };
  }

  const membersCount = useMembersCount(props.activeVaultId);
  const lastSynced = useLastSyncedRelative(props.activeVaultId);

  // D-ARCHIVED-SCREEN: host pre-filters props.vaults to active rows.
  // Belt-and-suspenders defensive filter. Archived rows live on
  // /vault/archived, linked from the footer below.
  const activeVaults = useMemo(() => props.vaults.filter((v) => !v.archived), [props.vaults]);
  const archivedCount = props.archivedCount ?? 0;
  const hasArchived = archivedCount > 0;

  // Only show "Manage this kaata" when there is an active vault and it is
  // in the list of non-archived vaults. Pre-onboarding edge case otherwise.
  const hasManageable = useMemo(
    () => props.activeVaultId != null && activeVaults.some((v) => v.id === props.activeVaultId),
    [props.activeVaultId, activeVaults],
  );

  if (!rendered) return null;

  // Phase 7 UX critique #2 (Eng C3): About section line is translatable.
  // Falls back to the no-build form when buildNumber is missing.
  const aboutLine = props.buildNumber
    ? t("menu.about.versionLineWithBuild", {
        version: props.appVersion,
        build: props.buildNumber,
      })
    : t("menu.about.versionLine", { version: props.appVersion });

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
        <SafeAreaView
          edges={["bottom"]}
          style={[
            styles.sheetWrap,
            // Numeric maxHeight — "85%" against position:absolute parent with
            // no explicit height is undefined in RN, so the sheet was rendering
            // taller than viewport. Dimensions gives a concrete pixel cap.
            { maxHeight: Dimensions.get("window").height * 0.85 },
          ]}
        >
          <View style={styles.sheet}>
            <View style={styles.grabber} />
            {/* Phase 7 UX critique: removed the redundant uppercase "MENU"
                title at the top of the sheet — every section already has
                its own header, so the extra title was visual noise. */}

            <ScrollView
              showsVerticalScrollIndicator={false}
              bounces={false}
              contentContainerStyle={{
                paddingBottom: 16 + insets.bottom * 0.25,
              }}
            >
              {/* ============ SECTION 1: ACCOUNT ============ */}
              <SectionHeader label={t("menu.account")} isRTL={isRTL} />
              {props.signedInUser ? (
                <>
                  <View style={[styles.identityRow, rowDir(isRTL)]}>
                    {props.signedInUser.picture_url ? (
                      <Image
                        accessibilityIgnoresInvertColors
                        source={{ uri: props.signedInUser.picture_url }}
                        style={[styles.avatar, isRTL ? { marginLeft: 14 } : { marginRight: 14 }]}
                      />
                    ) : (
                      <View
                        style={[
                          styles.avatarFallback,
                          isRTL ? { marginLeft: 14 } : { marginRight: 14 },
                        ]}
                      >
                        <Text style={styles.avatarLetter}>{initialFor(props.signedInUser)}</Text>
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      {props.signedInUser.name ? (
                        <Text style={[styles.identityName, textDir(isRTL)]} numberOfLines={1}>
                          {props.signedInUser.name}
                        </Text>
                      ) : null}
                      <Text style={[styles.identityEmail, textDir(isRTL)]} numberOfLines={1}>
                        {props.signedInUser.email ?? ""}
                      </Text>
                    </View>
                  </View>
                  {/* design-tokens.ts (line 107): "Sign out" is destructive
                      and uses `danger` color. Tap routes through the host's
                      onSignOut which now opens a ConfirmDialog before
                      actually wiping the session. */}
                  <NavRow
                    icon="log-out-outline"
                    label={t("menu.account.signOut")}
                    onPress={chained(props.onSignOut)}
                    isRTL={isRTL}
                    danger
                  />
                  <NavRow
                    icon="swap-horizontal-outline"
                    label={t("menu.account.switch")}
                    onPress={chained(props.onSwitchAccount)}
                    isRTL={isRTL}
                    isLast
                  />
                </>
              ) : (
                <>
                  <Text style={[styles.emptyHint, textDir(isRTL)]}>
                    {t("menu.account.localOnlyHint")}
                  </Text>
                  <NavRow
                    icon="logo-google"
                    label={t("menu.account.signIn")}
                    onPress={chained(props.onSignIn)}
                    isRTL={isRTL}
                    emphasis
                    isLast
                  />
                </>
              )}

              <SectionGap />

              {/* ============ SECTION 2: PREFERENCES ============
                  UX critique #2/7: previously rendered a "Preferences"
                  SectionHeader AND a NavRow labeled "Preferences" right
                  beneath it — duplicate styling for a single tap target.
                  Now: the section is the row. The NavRow's own label +
                  hint carries the full affordance; the section header
                  above it would just repeat the same word. We keep a
                  SectionGap on either side so the row visually reads as
                  its own section between Account and Kaatas. */}
              <NavRow
                icon="options-outline"
                label={t("profile.menu.preferences")}
                hint={t("profile.menu.preferencesHint")}
                onPress={chained(props.onOpenPreferences)}
                isRTL={isRTL}
                isLast
              />

              <SectionGap />

              {/* ============ SECTION 3: KAATAS ============ */}
              <SectionHeader label={t("menu.allKaatas")} isRTL={isRTL} />
              {activeVaults.length === 0 ? (
                <Text style={[styles.emptyHint, textDir(isRTL)]}>{t("menu.allKaatas.empty")}</Text>
              ) : (
                activeVaults.map((v) => {
                  const isActive = v.id === props.activeVaultId;
                  return (
                    <NavRow
                      key={v.id}
                      icon={isActive ? "checkmark-circle" : "ellipse-outline"}
                      iconColor={isActive ? colors.textEmphasis : colors.textMuted}
                      label={v.name}
                      bold={isActive}
                      onPress={
                        isActive
                          ? () => props.onDismiss()
                          : chained(() => props.onSelectVault(v.id))
                      }
                      isRTL={isRTL}
                    />
                  );
                })
              )}
              <NavRow
                icon="add-circle-outline"
                label={t("menu.allKaatas.add")}
                onPress={chained(props.onAddVault)}
                isRTL={isRTL}
                emphasis
              />
              <NavRow
                icon="qr-code-outline"
                label={t("menu.allKaatas.scan")}
                hint={t("menu.allKaatas.scan.hint")}
                onPress={chained(props.onScanPairingCode)}
                isRTL={isRTL}
                // UX-fix #4: the Kaatas section ends here when nothing
                // else (manage / archived) trails — the archived row
                // sits behind a SectionGap so it doesn't influence
                // this row's divider. When `hasManageable`, the manage
                // row is the last in-section row and carries `isLast`.
                isLast={!hasManageable}
              />
              {hasManageable ? (
                <NavRow
                  icon="cog-outline"
                  label={t("menu.thisKaata.settings")}
                  hint={pluralizeMembers(membersCount)}
                  onPress={chained(props.onManageCurrentKaata)}
                  isRTL={isRTL}
                  isLast
                />
              ) : null}
              {/* D-ARCHIVED-SCREEN — muted "Archived (N) >" footer link
                  to /vault/archived. Renders only when the user has at
                  least one archived Kaata. Placed below the manage row
                  so primary actions (select / add / scan / manage) stay
                  above the fold.

                  UX-fix #4 (Phase 7 finalize): the Kaatas list and the
                  archived footer-link are conceptually two separate
                  destinations — restoring an archived Kaata is a
                  different mental model from switching between active
                  ones. Match VaultPickerSheet's treatment: render a
                  SectionGap above the archived row so it reads as a
                  distinct footer section rather than "yet another row"
                  in the Kaatas list. */}
              {hasArchived ? (
                <>
                  <SectionGap />
                  <NavRow
                    icon="archive-outline"
                    iconColor={colors.textMuted}
                    label={t("menu.allKaatas.archived.view", {
                      count: archivedCount,
                    })}
                    onPress={chained(() => props.onOpenArchived?.())}
                    isRTL={isRTL}
                    isLast
                  />
                </>
              ) : null}

              <SectionGap />

              {/* ============ SECTION 4: SYNC ============ */}
              <SectionHeader
                label={t("menu.sync")}
                trailing={lastSynced.ms == null ? t("menu.sync.header.never") : lastSynced.label}
                isRTL={isRTL}
              />
              <View style={[styles.toggleRow, rowDir(isRTL)]}>
                <Ionicons
                  name="bluetooth-outline"
                  size={SETTINGS_ROW_ICON_SIZE}
                  color={colors.textEmphasis}
                  style={
                    isRTL
                      ? { marginLeft: SETTINGS_ROW_ICON_GAP }
                      : { marginRight: SETTINGS_ROW_ICON_GAP }
                  }
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.toggleTitle, textDir(isRTL)]}>
                    {t("menu.sync.shopMode")}
                  </Text>
                  <Text style={[styles.toggleHint, textDir(isRTL)]}>
                    {!props.shopModeEnabled
                      ? t("menu.sync.shopMode.hint")
                      : (props.activePeers ?? 0) === 0
                        ? t("menu.sync.shopMode.hintLooking")
                        : (props.activePeers ?? 0) === 1
                          ? t("menu.sync.shopMode.hintOnePeer")
                          : t("menu.sync.shopMode.hintWithPeers", {
                              count: props.activePeers ?? 0,
                            })}
                  </Text>
                </View>
                <Switch
                  value={props.shopModeEnabled}
                  onValueChange={props.onToggleShopMode}
                  disabled={!!props.shopModeBusy}
                  accessibilityRole="switch"
                  accessibilityLabel={t("menu.sync.shopMode")}
                  accessibilityState={{
                    checked: props.shopModeEnabled,
                    disabled: !!props.shopModeBusy,
                  }}
                />
              </View>

              {/* Sync to cloud / Restore from cloud — signed-in only. */}
              {liveAccountId ? (
                <>
                  <NavRow
                    icon="cloud-upload-outline"
                    label={t("menu.sync.now")}
                    onPress={() => {
                      // Stays open like the deprecated "Sync now" — host
                      // shows an inline spinner. Host closes + toasts after
                      // a 240ms defer for the Modal exit.
                      props.onSyncNow();
                    }}
                    trailing={props.syncBusy ? <ActivityIndicator size="small" /> : undefined}
                    isRTL={isRTL}
                    disabled={!!props.syncBusy}
                  />
                  <NavRow
                    icon="cloud-download-outline"
                    label={t("menu.sync.restore")}
                    onPress={chained(props.onRestoreFromCloud)}
                    isRTL={isRTL}
                    isLast
                  />
                </>
              ) : null}

              <SectionGap />

              {/* ============ SECTION 5: ABOUT ============ */}
              <SectionHeader label={t("menu.about")} isRTL={isRTL} />
              <View style={[styles.aboutRow, rowDir(isRTL)]}>
                <Ionicons
                  name="information-circle-outline"
                  size={20}
                  color={colors.textMuted}
                  style={isRTL ? { marginLeft: 12 } : { marginRight: 12 }}
                />
                <Text style={[styles.aboutText, textDir(isRTL)]}>{aboutLine}</Text>
              </View>
            </ScrollView>
          </View>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

// --------------------------------------------------------------------------
// Local helpers
// --------------------------------------------------------------------------

function initialFor(user: SessionUser): string {
  const source = user.name ?? user.email ?? "?";
  // Take the first non-whitespace grapheme. Array.from copes with emoji /
  // surrogate pairs without slicing them mid-codepoint.
  const first = Array.from(source.trim())[0];
  return (first ?? "?").toUpperCase();
}

// Localized member-count subtitle. Previously the sheet hard-coded
// `"${n} ${n === 1 ? 'member' : 'members'}"` which renders raw English
// on a Persian-locale device (UX critique #3). i18n keys carry both
// singular and plural forms.
function pluralizeMembers(count: number): string {
  return count === 1 ? t("members.singular", { count }) : t("members.plural", { count });
}

// --------------------------------------------------------------------------
// Styles — only the surfaces NOT covered by SettingsScreen atoms remain
// here (sheet chrome, identity row, sync toggle row, about line). The
// NavRow / SectionHeader / SectionGap visuals come from SettingsScreen.
// --------------------------------------------------------------------------

const styles = StyleSheet.create({
  tint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.08)",
  },
  sheetContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  sheetWrap: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: SETTINGS_SHEET_TOP_RADIUS,
    borderTopRightRadius: SETTINGS_SHEET_TOP_RADIUS,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  // flexShrink propagates the SafeAreaView maxHeight down to the
  // ScrollView; without it the inner View takes content height and the
  // ScrollView never scrolls (HamburgerMenuSheet Phase 5.2 bug rerun).
  sheet: { paddingTop: 8, paddingBottom: 0, flexShrink: 1 },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderEmphasis,
    marginBottom: 4,
  },

  // Identity (signed in) ----------------------------------------------------
  identityRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingVertical: 12,
    minHeight: 64,
  },
  avatar: {
    width: SETTINGS_AVATAR_HERO,
    height: SETTINGS_AVATAR_HERO,
    borderRadius: SETTINGS_AVATAR_HERO / 2,
    backgroundColor: colors.bgMuted,
  },
  avatarFallback: {
    width: SETTINGS_AVATAR_HERO,
    height: SETTINGS_AVATAR_HERO,
    borderRadius: SETTINGS_AVATAR_HERO / 2,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLetter: {
    fontSize: 20,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
  },
  identityName: {
    fontSize: 16,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  identityEmail: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 1,
  },

  // Sync toggle ------------------------------------------------------------
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingVertical: 12,
    minHeight: 60,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  toggleTitle: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  toggleHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 2,
  },

  // About ------------------------------------------------------------------
  aboutRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingVertical: 10,
  },
  aboutText: {
    flex: 1,
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
  },

  emptyHint: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingVertical: 10,
  },
});
