import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { isGoogleSignInAvailable, type SessionUser } from "../lib/auth";
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
import { getCurrencySymbol } from "../lib/currency";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { SOLO_STORE_MODE } from "../constants/env";
import { t } from "../lib/i18n";
import { radius } from "../lib/tokens";
import { useMembersCount } from "../lib/use-vault-summary";
import { InitialAvatar } from "./InitialAvatar";
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
// Sections, top to bottom. Each is separated from the next by a single
// SectionGap rendered at the TOP of the following section, so the last
// rendered section never trails an orphaned gap (matters in SOLO_STORE_MODE
// where KAATAS + SYNC are absent):
//   1. ACCOUNT — signed-in avatar+email OR Sign in with Google button.
//      "Account settings" row → /account (personal: name + phone + language +
//      default country + archived kaatas). Sign out (when signed in) is last.
//   2. CURRENT KAATA — "Manage this Kaata" → /vault/settings: the kaata's
//      name + currency (per-kaata) + members + danger zone.
//   3. KAATAS — list of all vaults with current bolded + checkmark;
//      "+ Add a Kaata" + "Scan a pairing code". (Hidden in SOLO_STORE_MODE.)
//   4. SYNC — Nearby (Bluetooth/WiFi mesh) toggle only (hidden in
//      SOLO_STORE_MODE). Cloud backup is now AUTOMATIC for signed-in users —
//      there is no toggle. App health + version moved to the Account screen.

const OFFSCREEN = 600;
const EXIT_DURATION_MS = 220;

export type VaultListItem = {
  id: string;
  name: string;
  // ISO code, shown as a trailing symbol on the row — mirrors
  // VaultPickerSheet so both kaata-selection surfaces read the same.
  currency?: string;
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

  // Sync state (Nearby/mesh only — cloud backup is now automatic, no toggle)
  shopModeEnabled: boolean;
  shopModeBusy?: boolean;
  activePeers?: number;

  // --- Actions ---
  // Profile
  onSignIn: (provider: "google" | "apple") => void;
  onSignOut: () => void;

  // Kaatas
  onSelectVault: (vaultId: string) => void;
  onAddVault: () => void;
  /**
   * PARKED (mesh): "Scan a pairing code" (entry into the offline QR pair
   * flow at /vault/pair-scan) is parked with the rest of mesh, so the row
   * that consumed this is commented out below. Kept optional on the type so
   * callers don't have to pass it; re-wire it when mesh ships again.
   */
  onScanPairingCode?: () => void;
  onManageCurrentKaata: () => void;

  // Account settings (personal: name / phone / language / country / archived)
  onOpenAccount: () => void;

  // Sync
  onToggleShopMode: (next: boolean) => void;

  // Dismiss
  onDismiss: () => void;
}) {
  const [rendered, setRendered] = useState(false);
  const isRTL = useIsRTL();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(OFFSCREEN)).current;

  // Reactive account_id — same pattern as the old HamburgerMenuSheet.
  // Reads the synchronous module cache on every `visible` flip so a sign-in
  // completed inline (Phase 7 D-ACCOUNT-PAGE-ROLE — /account screen was
  // killed; sign-in runs from the host's runSignIn helper) is
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
                      // Metric-corrected letter chip — shared with the home
                      // header's profile slot (see components/InitialAvatar
                      // for the Vazirmatn centering math).
                      <InitialAvatar
                        size={SETTINGS_AVATAR_HERO}
                        label={initialFor(props.signedInUser)}
                        style={isRTL ? { marginLeft: 14 } : { marginRight: 14 }}
                      />
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
                  {/* "Switch account" removed (Matee): to use another Google
                      account, sign out then sign in — the kaatas you have stay
                      on the phone (each backs up to its own account). */}
                  {/* Account settings belongs UNDER the ACCOUNT section (Matee):
                      the user's own name + phone, language, default country,
                      archived kaatas. Sits above the destructive "Sign out". */}
                  <NavRow
                    icon="person-circle-outline"
                    label={t("menu.account.settings")}
                    hint={t("menu.account.settings.hint")}
                    onPress={chained(props.onOpenAccount)}
                    isRTL={isRTL}
                  />
                  <NavRow
                    icon="log-out-outline"
                    label={t("menu.account.signOut")}
                    onPress={chained(props.onSignOut)}
                    isRTL={isRTL}
                    danger
                    isLast
                  />
                </>
              ) : (
                <>
                  <Text style={[styles.emptyHint, textDir(isRTL)]}>
                    {t("menu.account.localOnlyHint")}
                  </Text>
                  {/* BOTH providers, mirroring onboarding/auth.tsx — the
                      platform's home-team option leads, and Google hides on
                      iOS builds without the iOS OAuth client
                      (isGoogleSignInAvailable). Same email → same account
                      either way (backend email linking). */}
                  {Platform.OS === "ios" ? (
                    <NavRow
                      icon="logo-apple"
                      label={t("menu.account.signIn.apple")}
                      onPress={chained(() => props.onSignIn("apple"))}
                      isRTL={isRTL}
                      emphasis
                    />
                  ) : null}
                  {isGoogleSignInAvailable() ? (
                    <NavRow
                      icon="logo-google"
                      label={t("menu.account.signIn")}
                      onPress={chained(() => props.onSignIn("google"))}
                      isRTL={isRTL}
                      emphasis={Platform.OS !== "ios"}
                    />
                  ) : null}
                  {Platform.OS !== "ios" ? (
                    <NavRow
                      icon="logo-apple"
                      label={t("menu.account.signIn.apple")}
                      onPress={chained(() => props.onSignIn("apple"))}
                      isRTL={isRTL}
                    />
                  ) : null}
                  {/* Editable while signed out too — it's the local identity. */}
                  <NavRow
                    icon="person-circle-outline"
                    label={t("menu.account.settings")}
                    hint={t("menu.account.settings.hint")}
                    onPress={chained(props.onOpenAccount)}
                    isRTL={isRTL}
                    isLast
                  />
                </>
              )}

              {/* ============ CURRENT KAATA ============
                  Settings for the ACTIVE kaata (rename, currency, members, archive),
                  clearly separated from the USER/ACCOUNT settings. Moved here from
                  the vault switcher (now switch-only) so "user settings vs
                  current-kaata settings" is explicit (Matee's ask). Shown whenever
                  there is a manageable active vault — in solo mode too, so the lone
                  shopkeeper can still rename their kaata / change currency. */}
              {hasManageable ? (
                <>
                  <SectionGap />
                  <SectionHeader label={t("menu.currentKaata")} isRTL={isRTL} />
                  <NavRow
                    icon="cog-outline"
                    label={t("menu.thisKaata.settings")}
                    // Member count only when it means something (multi-member);
                    // a solo shopkeeper doesn't think in "1 member".
                    hint={membersCount > 1 ? pluralizeMembers(membersCount) : undefined}
                    onPress={chained(props.onManageCurrentKaata)}
                    isRTL={isRTL}
                    isLast
                  />
                </>
              ) : null}

              {/* ============ SECTION 3: KAATAS ============
                  Hidden in SOLO_STORE_MODE: the kaata list is redundant with the
                  top-left vault switcher (VaultPickerSheet), and pairing/scan are
                  multi-employee surfaces a lone shopkeeper doesn't need. (Matee:
                  "the vaults/kaatas are listed in the settings too, it's not
                  needed, I see them on the vault/kaata switcher.") */}
              {!SOLO_STORE_MODE ? (
                <>
                  <SectionGap />
                  <SectionHeader label={t("menu.allKaatas")} isRTL={isRTL} />
                  {activeVaults.length === 0 ? (
                    <Text style={[styles.emptyHint, textDir(isRTL)]}>
                      {t("menu.allKaatas.empty")}
                    </Text>
                  ) : (
                    activeVaults.map((v) => {
                      const isActive = v.id === props.activeVaultId;
                      return (
                        <NavRow
                          key={v.id}
                          icon={isActive ? "checkmark-circle" : "ellipse-outline"}
                          iconColor={isActive ? colors.textEmphasis : colors.textMuted}
                          label={v.name}
                          trailing={v.currency ? getCurrencySymbol(v.currency) : undefined}
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
                    // Last in-section row before the archived footer now that
                    // the parked scan row below no longer renders. The archived
                    // row sits behind a SectionGap so it doesn't influence this
                    // row's divider.
                    isLast={!hasArchived}
                  />
                  {/* PARKED (mesh): "Scan a pairing code" opened the offline QR
                      scan (vault/pair-scan), parked with the rest of mesh.
                      Re-add when mesh ships again. (props.onScanPairingCode is
                      kept on the type but is no longer consumed.)
                  <NavRow
                    icon="qr-code-outline"
                    label={t("menu.allKaatas.scan")}
                    hint={t("menu.allKaatas.scan.hint")}
                    onPress={chained(props.onScanPairingCode)}
                    isRTL={isRTL}
                    isLast={!hasArchived}
                  />
                  */}
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
                </>
              ) : null}

              {/* ============ SECTION 4: SYNC (Nearby/mesh only) ============
                  Cloud backup is now automatic for signed-in users (no toggle).
                  This section is ONLY the Nearby (Bluetooth/WiFi) mesh toggle,
                  which is hidden in SOLO_STORE_MODE — so in the production solo
                  build the whole section is absent (the header + gap gate on
                  !SOLO_STORE_MODE). The dev Bluetooth-test row keeps its own
                  __DEV__ gate inside. */}
              {!SOLO_STORE_MODE ? (
                <>
                  <SectionGap />
                  <SectionHeader label={t("menu.sync")} isRTL={isRTL} />
                  <View
                    style={[
                      styles.toggleRow,
                      rowDir(isRTL),
                      // Last sync row when no dev BT row follows.
                      !__DEV__ ? styles.toggleRowLast : null,
                    ]}
                  >
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

                  {/* Cloud backup is automatic for signed-in users — no toggle
                      (Matee). App health + version moved to the Account screen. */}

                  {/* DEV-only: Bluetooth Classic (RFCOMM) transport test. Gated
                      behind __DEV__ so it never appears in preview/production
                      builds now that RFCOMM is the real mesh transport. */}
                  {__DEV__ ? (
                    <NavRow
                      icon="bluetooth-outline"
                      label="Bluetooth test (dev)"
                      onPress={() => router.push("/dev/btc-test")}
                      isRTL={isRTL}
                      isLast
                    />
                  ) : null}
                </>
              ) : null}

              {/* ============ HELP ============
                  Permanent home for the kaata-vs-tally guide (app/guide.tsx).
                  Always rendered — re-readable any time, e.g. when the phone
                  is handed to staff. */}
              <SectionGap />
              <SectionHeader label={t("menu.help")} isRTL={isRTL} />
              <NavRow
                icon="help-circle-outline"
                label={t("menu.guide")}
                hint={t("menu.guide.hint")}
                onPress={chained(() => router.push("/guide"))}
                isRTL={isRTL}
                isLast
              />
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
    ...StyleSheet.absoluteFill,
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
    borderRadius: radius.grabber,
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
  // avatarFallback/avatarLetter were replaced by the shared InitialAvatar
  // component (metric-corrected letter centering — see that file).
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
  // Suppresses the hairline divider on the last sync toggle so it doesn't leave
  // a stray gray line above the section gap.
  toggleRowLast: { borderBottomWidth: 0 },
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
