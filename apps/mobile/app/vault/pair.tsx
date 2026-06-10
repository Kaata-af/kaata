// Phase 5 — same-account multi-device QR pairing, owner side.
//
// Owner opens this screen from vault/settings.tsx "Add a phone" (owner-only).
// Renders a QR encoding {vault_id, vault_name, issuer_account_id,
// issuer_install_id, issued_at_ms, expires_at_ms, shop_mode_token} that
// expires after 5 minutes.
//
// IMPORTANT: this flow is for adding *another device of the same Google
// account*. Cross-account invites still go through vault/invite.tsx (the
// Phase 4 email-anchored token flow).

import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import QRCode from "react-native-qrcode-svg";
import { Button } from "../../components/Button";
import { ScreenHeader } from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getActiveVaultId, getInstallIdSync } from "../../lib/db-tx";
import { getAppMeta, getDb, setAppMeta } from "../../lib/db";
import { textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import {
  encodePairDeepLink,
  encodePairQr,
  generateShopModeToken,
  PAIR_QR_TTL_MS,
  PAIR_QR_VERSION,
  type PairQrPayload,
  type PairQrRole,
} from "../../lib/mesh/pair-qr";
import { getDevicePubkey } from "../../lib/mesh/device-key";
import { buildLocalAccountId } from "../../lib/mesh/local-vmc";
import { getLocalSelf } from "../../lib/db";
import { registerVaultPairToken } from "../../lib/vault-api";

type VaultLite = {
  id: string;
  name: string;
  vault_trust_anchor_pubkey: string | null;
};

export default function VaultPairScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();

  const [loaded, setLoaded] = useState(false);
  const [vault, setVault] = useState<VaultLite | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  /**
   * D-PAIR-WITH-ROLE: 2-step UI. "pick-role" shows the role chips and
   * defers QR generation; "show-qr" renders the QR with the committed
   * role. "Generate a new code" returns to "pick-role" so the owner
   * can choose a fresh role on re-issue.
   */
  const [stage, setStage] = useState<"pick-role" | "show-qr">("pick-role");
  const [role, setRole] = useState<PairQrRole>("editor");
  const [payload, setPayload] = useState<PairQrPayload | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(Math.floor(PAIR_QR_TTL_MS / 1000));
  const [error, setError] = useState<string | null>(null);
  const [sendingLink, setSendingLink] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const issueQr = useCallback(
    async (v: VaultLite, accId: string | null, chosenRole: PairQrRole) => {
      try {
        const token = await generateShopModeToken();
        const now = Date.now();
        const expires = now + PAIR_QR_TTL_MS;
        // In local-only mode (no Google sign-in — the offline-shopkeeper
        // path that local-CA was built for) accId is null, but the QR
        // schema requires a non-empty issuer_account_id. Synthesize a
        // stable local ID from the device pubkey, matching the convention
        // used by local-vmc.ts and the rest of the local-CA flow.
        // Without this, the scanner rejects the QR as "malformed" and the
        // shopkeeper can never add staff offline.
        const devicePubkey = getDevicePubkey();
        const localIssuerId = devicePubkey
          ? buildLocalAccountId(devicePubkey)
          : `local:${getInstallIdSync().slice(0, 16)}`;
        // v=3 (Briar-style bidirectional pair): include the OWNER's
        // identity in the QR so the scanner can pin (device_pubkey,
        // display_name) without waiting for the BLE handshake. The
        // scanner uses the pinned device_pubkey at handshake time via
        // verifyVMCAgainstPinnedPeer — that's what unblocks local-CA
        // mesh sync end-to-end. Display name is for the Members tab
        // (renders "Matee" instead of "local:abc…").
        const self = await getLocalSelf();
        const ownerDisplayName = (self?.name ?? "").trim() || "Owner";
        const next: PairQrPayload = {
          v: PAIR_QR_VERSION,
          vault_id: v.id,
          vault_name: v.name,
          issuer_account_id: accId ?? localIssuerId,
          issuer_install_id: getInstallIdSync(),
          issued_at_ms: now,
          expires_at_ms: expires,
          shop_mode_token: token,
          // Phase 7 local-CA: include the owner's trust anchor pubkey
          // so the scanner can verify the eventual VMC against it
          // (instead of waiting for a server round-trip). For Phase 5
          // server-anchored vaults the field is absent and the scanner
          // takes the legacy /credential path.
          vault_trust_anchor_pubkey: v.vault_trust_anchor_pubkey ?? undefined,
          // D-PAIR-WITH-ROLE: only meaningful for local-CA pair (the only
          // path that mints the VMC client-side). On server-anchored
          // vaults the server still issues an owner VMC; we include the
          // field anyway so a future server change is forward-compat.
          role: chosenRole,
          // v=3: bidirectional pair fields. Required for v=3 QRs; the
          // decoder enforces this. For server-anchored vaults we still
          // include them so the scanner can use the pinned-peer path as
          // a fallback (additive, no harm).
          issuer_device_pubkey: devicePubkey ?? undefined,
          issuer_display_name: ownerDisplayName,
        };
        // Phase 7: server-side token registration is ONLY required for
        // server-anchored vaults (where the scanner will hit
        // /v1/vaults/:vault_id/credential to mint the VMC). Local-CA
        // vaults issue the VMC directly via the owner's device, so the
        // server need not be involved — and indeed CANNOT be when the
        // owner is signed out. Skip the register call in that case.
        if (!v.vault_trust_anchor_pubkey && accId) {
          await registerVaultPairToken(v.id, token, expires);
        }
        // Persist the token locally with the SAME shape that
        // lib/mesh/local-pair.ts's PendingPairToken / isPendingPairToken
        // expects, so vmc.ts:verifyVMCAgainstPinnedPeer can find it when
        // the joiner connects over BLE and trigger the pair-token-bound
        // TOFU window (5 min after QR issue). Without the canonical
        // shape this list comes back empty from
        // getPendingPairTokensForVault and the BLE handshake refuses
        // the joiner silently.
        await persistPendingPairToken({
          nonce: token,
          vault_id: v.id,
          vault_name: v.name,
          issued_at_ms: now,
          expires_at_ms: expires,
          role: chosenRole,
        });
        setPayload(next);
        setSecondsLeft(Math.floor(PAIR_QR_TTL_MS / 1000));
        setError(null);
      } catch (err) {
        console.warn("[vault/pair] issue failed", err);
        setError(
          err instanceof Error
            ? `Failed to register pairing code: ${err.message}`
            : "Failed to generate pairing code",
        );
      }
    },
    [],
  );

  useEffect(() => {
    (async () => {
      try {
        const activeVaultId = await getActiveVaultId();
        if (!activeVaultId) {
          toast.push(t("vaultPair.noActiveKaata"), "error");
          router.back();
          return;
        }
        const db = await getDb();
        const row = await db.getFirstAsync<VaultLite>(
          `SELECT id, name, vault_trust_anchor_pubkey
             FROM vaults WHERE id = ? LIMIT 1`,
          activeVaultId,
        );
        if (!row) {
          toast.push(t("vaultPair.vaultNotFound"), "error");
          router.back();
          return;
        }
        const accId = await getAppMeta("account_id");
        // Phase 7: account_id is NOT required for local-CA vaults — the
        // owner's device signs the VMC directly. Block the flow only
        // when this is a server-anchored vault AND the user is signed
        // out (in which case the scanner would need the server path).
        if (!accId && !row.vault_trust_anchor_pubkey) {
          toast.push(t("vaultPair.signInFirst"), "error");
          router.back();
          return;
        }
        setVault(row);
        setAccountId(accId);
        // D-PAIR-WITH-ROLE: do NOT auto-issue. The owner must pick a
        // role first. Stage stays "pick-role" until they confirm.
      } catch (err) {
        console.warn("[vault/pair] bootstrap failed", err);
        toast.push(t("vaultPair.loadFailed"), "error");
      } finally {
        setLoaded(true);
      }
    })();
    // single-bootstrap on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1-second countdown. Pauses on background to save CPU.
  useEffect(() => {
    if (!payload) return;
    const tick = () => {
      const remaining = Math.max(0, Math.floor((payload.expires_at_ms - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };
    tick();
    tickRef.current = setInterval(tick, 1000);
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active" && tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      } else if (next === "active" && !tickRef.current) {
        tickRef.current = setInterval(tick, 1000);
      }
    });
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
      sub.remove();
    };
  }, [payload]);

  async function onReissue() {
    // D-PAIR-WITH-ROLE: send the owner back to the role picker on re-
    // issue so they can change their mind. Previously this re-used the
    // committed role silently, which was surprising once the role
    // picker existed (the owner expected a fresh decision point).
    if (!vault) return;
    setPayload(null);
    setStage("pick-role");
  }

  async function onConfirmRole() {
    if (!vault) return;
    await issueQr(vault, accountId, role);
    setStage("show-qr");
  }

  async function onSendLink() {
    if (!payload || sendingLink) return;
    setSendingLink(true);
    try {
      const deepLink = encodePairDeepLink(payload);
      // Without expo-clipboard, the system Share sheet is the cleanest
      // path — both iOS and Android surface a "Copy" action plus
      // WhatsApp / SMS share targets in the same sheet.
      await Share.share({
        message: t("vaultPair.shareLinkMessage", { url: deepLink }),
        url: deepLink,
      });
      toast.push(t("vaultPair.shareLinkReady"), "success");
    } catch (err) {
      console.warn("[vault/pair] share link failed", err);
      toast.push(t("vaultPair.shareLinkFailed"), "error");
    } finally {
      setSendingLink(false);
    }
  }

  if (!loaded || !vault) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.fillCenter}>
          <Text style={styles.bodyText}>{t("common.loading")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ----- Stage 1: role picker --------------------------------------------
  if (stage === "pick-role") {
    return (
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <ScreenHeader
          title={t("vaultPair.title")}
          onBack={() => router.back()}
          isRTL={isRTL}
          backLabel={t("common.back")}
        />
        <View style={styles.body}>
          <Text style={[styles.headline, textDir(isRTL)]}>
            {t("vaultPair.role.title")}
            {"\n"}
            <Text style={styles.emph}>{vault.name}</Text>
          </Text>
          <Text style={[styles.bodyText, textDir(isRTL), { marginBottom: 16 }]}>
            {t("vaultPair.role.subtitle")}
          </Text>

          {(["owner", "editor", "viewer"] as PairQrRole[]).map((r) => {
            const selected = role === r;
            return (
              <Pressable
                key={r}
                onPress={() => setRole(r)}
                style={[styles.roleChip, selected ? styles.roleChipSelected : null]}
              >
                <View style={{ flex: 1 }}>
                  <Text
                    style={[
                      styles.roleChipLabel,
                      selected ? styles.roleChipLabelSelected : null,
                      textDir(isRTL),
                    ]}
                  >
                    {r === "owner"
                      ? t("vaultPair.role.owner")
                      : r === "editor"
                        ? t("vaultPair.role.editor")
                        : t("vaultPair.role.viewer")}
                  </Text>
                  <Text style={[styles.roleChipBody, textDir(isRTL)]}>
                    {r === "owner"
                      ? t("vaultPair.role.owner.body")
                      : r === "editor"
                        ? t("vaultPair.role.editor.body")
                        : t("vaultPair.role.viewer.body")}
                  </Text>
                </View>
                {selected ? (
                  <Ionicons name="checkmark-circle" size={22} color={colors.textEmphasis} />
                ) : (
                  <Ionicons name="ellipse-outline" size={22} color={colors.textMuted} />
                )}
              </Pressable>
            );
          })}

          <View style={{ height: 24 }} />
          <Button label={t("vaultPair.role.continue")} onPress={onConfirmRole} />
          <View style={{ height: 10 }} />
          <Button label={t("common.cancel")} variant="secondary" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  // ----- Stage 2: show QR ------------------------------------------------
  const expired = secondsLeft <= 0;
  const encoded = payload ? encodePairQr(payload) : "";

  // Phase 7: local-CA vaults can pair without sign-in on either side. We
  // detect this from vault_trust_anchor_pubkey being populated and the
  // current user being signed out — the instructions vary accordingly.
  const isLocalCA = !!vault.vault_trust_anchor_pubkey;

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      {/* Phase 7 coherence: shared ScreenHeader replaces the bespoke
          Cancel-text left button. Visual + a11y parity with other
          settings sub-pages. */}
      <ScreenHeader
        title={t("vaultPair.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />

      <View style={styles.body}>
        <Text style={[styles.headline, textDir(isRTL)]}>
          {t("vaultPair.headline")}
          {"\n"}
          <Text style={styles.emph}>{vault.name}</Text>
        </Text>
        <Text style={[styles.bodyText, textDir(isRTL)]}>
          {isLocalCA ? t("vaultPair.instructions.local") : t("vaultPair.instructions.server")}
        </Text>

        <View style={styles.qrCard}>
          {payload && !expired ? (
            <QRCode
              value={encoded}
              size={260}
              backgroundColor={colors.bgDefault}
              color={colors.textEmphasis}
            />
          ) : (
            <View style={styles.qrPlaceholder}>
              <Ionicons name="time-outline" size={48} color={colors.textMuted} />
              <Text style={[styles.bodyText, { marginTop: 12 }]}>
                {expired ? t("vaultPair.codeExpired") : t("vaultPair.generating")}
              </Text>
            </View>
          )}
        </View>

        {payload && !expired ? (
          <Text style={[styles.timerText, textDir(isRTL)]}>
            {t("vaultPair.expiresIn", { time: formatCountdown(secondsLeft) })}
          </Text>
        ) : null}

        {error ? <Text style={[styles.errorText, textDir(isRTL)]}>{error}</Text> : null}

        <View style={{ height: 20 }} />
        {expired ? (
          <Button label={t("vaultPair.generateNew")} onPress={onReissue} />
        ) : (
          <>
            <Button
              label={sendingLink ? t("vaultPair.sendLink.opening") : t("vaultPair.sendLink")}
              variant="secondary"
              onPress={onSendLink}
            />
            <View style={{ height: 10 }} />
            <Button label={t("common.cancel")} variant="secondary" onPress={() => router.back()} />
          </>
        )}

        <Text style={[styles.fineprint, textDir(isRTL)]}>
          {isLocalCA ? t("vaultPair.fineprint.local") : t("vaultPair.fineprint.server")}
        </Text>
        <Text style={[styles.fineprintEmph, textDir(isRTL)]}>
          {t("vaultPair.role.committed", {
            role:
              role === "owner"
                ? t("vaultPair.role.owner")
                : role === "editor"
                  ? t("vaultPair.role.editor")
                  : t("vaultPair.role.viewer"),
          })}
        </Text>
      </View>
    </SafeAreaView>
  );
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Pending-pair-token store. Used to track outstanding tokens the owner
// has minted. The on-disk schema MUST match lib/mesh/local-pair.ts's
// PendingPairToken type, because that module's getPendingPairTokensForVault
// is the canonical read path (the v=3 BLE handshake's pair-token-bound
// TOFU in vmc.ts:verifyVMCAgainstPinnedPeer calls it). If the field
// names diverge — as they did between v0.5.2 and the fix below —
// local-pair.ts's strict isPendingPairToken validator silently drops
// every token this file writes, the TOFU never sees a live token, and
// the owner refuses the joiner's BLE handshake. Symptom: joiner pairs
// fine locally, owner sees nothing, no error.
type PendingPairToken = {
  nonce: string; // was "token" before v0.5.3 — renamed to match local-pair.ts
  vault_id: string;
  vault_name: string;
  issued_at_ms: number;
  expires_at_ms: number;
  role?: PairQrRole;
};

const PENDING_PAIR_TOKENS_KEY = "pending_pair_tokens";

async function persistPendingPairToken(t: PendingPairToken): Promise<void> {
  const now = Date.now();
  const raw = await getAppMeta(PENDING_PAIR_TOKENS_KEY);
  let list: PendingPairToken[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          if (
            e &&
            typeof e === "object" &&
            typeof e.nonce === "string" &&
            typeof e.vault_id === "string" &&
            typeof e.vault_name === "string" &&
            typeof e.issued_at_ms === "number" &&
            typeof e.expires_at_ms === "number" &&
            e.expires_at_ms > now
          ) {
            list.push(e as PendingPairToken);
          }
        }
      }
    } catch {
      // corrupted — start fresh
      list = [];
    }
  }
  // Replace any existing entry for the same vault+nonce; otherwise append.
  const filtered = list.filter((e) => !(e.vault_id === t.vault_id && e.nonce === t.nonce));
  filtered.push(t);
  await setAppMeta(PENDING_PAIR_TOKENS_KEY, JSON.stringify(filtered));
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: 20, alignItems: "center" },
  bodyText: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    lineHeight: 22,
    alignSelf: "stretch",
  },
  headline: {
    fontSize: 22,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    textAlign: "center",
    lineHeight: 30,
    marginBottom: 16,
  },
  emph: { fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  qrCard: {
    marginTop: 24,
    padding: 20,
    backgroundColor: colors.bgDefault,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 300,
    minHeight: 300,
  },
  qrPlaceholder: {
    width: 260,
    height: 260,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgMuted,
    borderRadius: 12,
  },
  timerText: {
    marginTop: 14,
    fontSize: 13,
    fontFamily: fonts.monoMedium,
    color: colors.textSubtle,
  },
  errorText: {
    marginTop: 12,
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.danger,
  },
  fineprint: {
    marginTop: 16,
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    textAlign: "center",
    lineHeight: 18,
  },
  fineprintEmph: {
    marginTop: 6,
    fontSize: 12,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    textAlign: "center",
  },
  roleChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
    marginBottom: 10,
    gap: 12,
  },
  roleChipSelected: {
    borderColor: colors.textEmphasis,
    backgroundColor: colors.bgMuted,
  },
  roleChipLabel: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textDefault,
    marginBottom: 4,
  },
  roleChipLabelSelected: { color: colors.textEmphasis },
  roleChipBody: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: 18,
  },
});
