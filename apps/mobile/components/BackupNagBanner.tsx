// components/BackupNagBanner.tsx
//
// M5 §5 — the backup nag. Local-only multi-member vault owners are the one
// group whose data loss is unrecoverable (owner-key loss with no server copy =
// no admin recovery; see docs/recovery-runbook.md scenario C). The honest
// mitigation the architecture commits to is to AGGRESSIVELY nudge them to sign
// in (which enables cloud backup → recovery becomes possible).
//
// Signal: NOT signed in (account_id == null) AND the active vault has >1 member
// (has staff — scenario 3). Dismissible per-vault (app_meta
// `backup_nag_dismissed:<vaultId>`). Tapping it opens settings, where sign-in
// lives. Modeled on UpdateBanner.

import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors } from "../lib/colors";
import { getAppMeta, setAppMeta } from "../lib/db";
import { getDb } from "../lib/db-tx";
import { fonts, sansLineHeight } from "../lib/fonts";
import { t } from "../lib/i18n";

export function BackupNagBanner(props: {
  activeVaultId: string | null;
  /** True when there is no live session (signed out / local-only). M5 review
   *  fix: derive from the LIVE session, NOT app_meta.account_id — signOut()
   *  doesn't clear that key, so the old signal permanently suppressed the nag
   *  for the exact at-risk group (anyone who ever signed in then out). */
  signedOut: boolean;
  /** Open the place sign-in lives (the home identity → ProfileSettingsSheet). */
  onPress: () => void;
}) {
  const { activeVaultId, signedOut, onPress } = props;
  const [show, setShow] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        // Only nag a LOCAL-ONLY (signed-out) owner of a MULTI-MEMBER vault.
        if (!activeVaultId || !signedOut) {
          if (!cancelled) setShow(false);
          return;
        }
        try {
          const dismissed = await getAppMeta(`backup_nag_dismissed:${activeVaultId}`);
          if (dismissed === "1") {
            if (!cancelled) setShow(false);
            return;
          }
          const db = await getDb();
          const row = await db.getFirstAsync<{ n: number }>(
            `SELECT COUNT(*) AS n FROM vault_members_mirror
              WHERE vault_id = ? AND revoked_at IS NULL`,
            activeVaultId,
          );
          if (!cancelled) setShow((row?.n ?? 0) > 1);
        } catch {
          if (!cancelled) setShow(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [activeVaultId, signedOut]),
  );

  if (!show) return null;

  return (
    <Pressable
      style={styles.banner}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t("backupNag.cta")}
    >
      <Ionicons name="cloud-offline-outline" size={20} color={colors.textInverted} />
      <View style={styles.textWrap}>
        <Text style={styles.title}>{t("backupNag.title")}</Text>
        <Text style={styles.body}>{t("backupNag.body")}</Text>
      </View>
      <Pressable
        onPress={async () => {
          if (activeVaultId) await setAppMeta(`backup_nag_dismissed:${activeVaultId}`, "1");
          setShow(false);
        }}
        hitSlop={10}
        style={styles.dismiss}
        accessibilityLabel={t("backupNag.dismiss")}
      >
        <Text style={styles.dismissText}>×</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#9a6a00", // amber — "at-risk, act" without alarm-red
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 12,
  },
  textWrap: { flex: 1 },
  title: { fontFamily: fonts.sansSemi, fontSize: 13, color: colors.textInverted },
  body: { fontFamily: fonts.sansRegular, fontSize: 12, color: colors.textInverted, opacity: 0.9 },
  dismiss: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  // 22/20 = 1.10em with NO fontFamily, so this fell back to the system font and
  // sat below even SF's ~1.2em — inside the band the lineHeight invariant
  // exists to prevent. components/UpdateBanner.tsx:155 already renders the
  // identical "×" correctly; this now matches it.
  dismissText: {
    fontSize: 20,
    lineHeight: sansLineHeight(20, 22),
    fontFamily: fonts.sansRegular,
    color: colors.textInverted,
  },
});
