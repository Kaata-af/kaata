// Vault invite — Phase 7 redesigned to match the settings design language.
//
// This is the add-member affordance: an online invite link the recipient
// opens (deep link kaata://invite/<token>) and accepts after signing in.
// It works cross-account and not-physically-present (shopkeeper adds an
// accountant in another city). Requires sign-in + internet (the server
// holds the invite token until the recipient signs in to accept). When
// offline, the form is rendered in a disabled state with a clear
// disclosure so the user isn't left to hit an opaque API error on submit.
//
// (The old in-person QR pair, vault/pair.tsx, was the former primary
// affordance; it is PARKED with the rest of the offline mesh.)
//
// Owner-only modal screen. Collects an email + a role (editor / viewer),
// POSTs to /v1/vaults/:vault_id/invites, and shows the resulting share URL
// with Copy / Share rows. Email normalization (trim + lowercase + gmail
// dot-strip) happens on the backend; we only do a coarse pre-flight here so
// the user sees inline feedback before the round-trip.

import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as Network from "expo-network";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import {
  EmptyHint,
  NavRow,
  ScreenHeader,
  SectionGap,
  SectionHeader,
} from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getSessionJWT } from "../../lib/auth";
import { getActiveVaultId } from "../../lib/db-tx";
import { getAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts, sansLineHeight } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { useVaultPermission } from "../../lib/use-vault-role";
import { ApiError, createVaultInvite, listVaults } from "../../lib/vault-api";
import type { VaultRole } from "../../lib/events";

type InviteResult = {
  invite_url: string;
  invite_email: string;
  expires_at: number;
};

export default function VaultInviteScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();

  const [vaultId, setVaultId] = useState<string>("");
  const [accountId, setAccountId] = useState<string | null>(null);
  // The actual "can call the API" gate: do we hold a valid JWT? Cached
  // app_meta.account_id can be stale (e.g. legacy install written it but
  // never bound, or a sign-in race where vault loaded before account_id
  // landed in app_meta). The JWT is the only thing httpThrowing actually
  // checks via requireJwt(), so we mirror that contract in the UI gate.
  // `null` = unknown until the effect resolves.
  const [hasJwt, setHasJwt] = useState<boolean | null>(null);
  const [role, setRole] = useState<VaultRole>("editor");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InviteResult | null>(null);
  // D-UI-UNIFICATION: online gate. We snapshot connectivity once at
  // mount; the create CTA is also gated by the live state so a user
  // who goes offline gets a clear disabled CTA instead of an opaque API
  // error. `null` = unknown (initial state), treated as online until resolved.
  const [online, setOnline] = useState<boolean | null>(null);
  // Pre-flight: is this kaata registered on the server yet? A local-CA kaata
  // that hasn't synced can't be shared (the API 404s). null = checking/unknown
  // (optimistic — allow, the 404 toast is the backstop); false = confirmed not
  // synced → disable Create + show a banner instead of a post-tap error.
  const [vaultOnServer, setVaultOnServer] = useState<boolean | null>(null);
  // Synchronous re-entry guard — `busy` state can't stop a same-frame
  // double-tap (setState is async); see entry/new.tsx. Double-submit
  // here mints duplicate server links.
  const submittingRef = useRef(false);

  const canInvite = useVaultPermission(vaultId, accountId, "vault.invite_member");

  useEffect(() => {
    (async () => {
      const vid = await getActiveVaultId();
      if (!vid) {
        toast.push(t("invite.toast.noActive"), "error");
        router.back();
        return;
      }
      setVaultId(vid);
      const [accId, jwt] = await Promise.all([
        getAppMeta("account_id"),
        getSessionJWT().catch(() => null),
      ]);
      setAccountId(accId);
      setHasJwt(!!jwt);
    })();
  }, [router, toast]);

  // Pre-flight vault-on-server check: once we have a vault + JWT + connectivity,
  // confirm the kaata is registered server-side so we can disable Create + warn
  // BEFORE the owner picks a role and taps (instead of a post-submit 404 toast).
  // Best-effort — on any error we leave it null (optimistic, 404 is the backstop).
  useEffect(() => {
    if (!vaultId || !hasJwt || online === false) return;
    let alive = true;
    (async () => {
      try {
        const vaults = await listVaults();
        if (alive) setVaultOnServer(vaults.some((v) => v.vault_id === vaultId));
      } catch {
        if (alive) setVaultOnServer(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [vaultId, hasJwt, online]);

  // Snapshot network state on mount. Best-effort: if expo-network throws
  // (rare, but defensively) we treat the user as offline so the form
  // gates safely.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const st = await Network.getNetworkStateAsync();
        if (alive) setOnline(!!st.isConnected && !!st.isInternetReachable);
      } catch {
        if (alive) setOnline(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function onSubmit() {
    if (!canInvite) return;
    if (busy || submittingRef.current) return;
    if (!hasJwt) {
      // Link invites are server-mediated (the server holds the token until the
      // recipient signs in to claim it) and the API requires a Bearer JWT. A
      // local-only user can't reach those endpoints — route them to QR pair.
      toast.push(t("invite.signInRequired"), "error");
      return;
    }
    submittingRef.current = true;
    setBusy(true);
    try {
      // Empty email mints a LINK invite: the token is the secret, and whoever
      // opens the link + signs in (with any Google account) claims this role.
      const r = await createVaultInvite(vaultId, { email: "", role });
      setResult(r);
      toast.push(t("invite.created"), "success");
    } catch (e) {
      // Branch on the backend's structured error_code / status, not prose.
      const code = e instanceof ApiError ? e.code : "";
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 401 || (e instanceof Error && e.message.includes("not signed in"))) {
        toast.push(t("invite.signInRequired"), "error");
      } else if (code === "too_many_invites" || code === "rate_limited" || status === 429) {
        toast.push(t("invite.tooMany"), "error");
      } else if (
        code === "vault_not_found" ||
        code === "not_member" ||
        code === "owner_only" ||
        status === 404 ||
        status === 403
      ) {
        // local-CA vault not yet registered server-side — must sync first.
        toast.push(t("invite.vaultNotOnServer"), "error");
      } else {
        toast.push(t("invite.failed"), "error");
        if (__DEV__) console.warn("[vault/invite] create link failed:", e);
      }
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!result) return;
    try {
      await Clipboard.setStringAsync(result.invite_url);
      toast.push(t("invite.copy.done"), "success");
    } catch {
      toast.push(t("invite.copy.unavailable"), "error");
    }
  }

  async function onShare() {
    if (!result) return;
    try {
      await Share.share({
        message: t("invite.shareMessage", { url: result.invite_url }),
      });
    } catch (e) {
      console.warn("[vault/invite] share failed", e);
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("invite.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollContent}
        >
          {!canInvite ? <EmptyHint label={t("invite.ownerOnly")} isRTL={isRTL} /> : null}

          {/* D-UI-UNIFICATION: offline disclosure banner. Always
              rendered (not just when offline) so users on shaky AF
              networks understand WHY this screen has a primary-
              disabled state before they tap submit. */}
          {!result ? (
            <View
              style={[
                styles.disclosure,
                online === false || hasJwt === false || vaultOnServer === false
                  ? styles.disclosureOffline
                  : null,
              ]}
            >
              <Ionicons
                name={
                  hasJwt === false
                    ? "person-circle-outline"
                    : online === false
                      ? "cloud-offline-outline"
                      : vaultOnServer === false
                        ? "sync-outline"
                        : "information-circle-outline"
                }
                size={18}
                color={
                  online === false || hasJwt === false || vaultOnServer === false
                    ? colors.danger
                    : colors.textSubtle
                }
                style={isRTL ? { marginLeft: 10 } : { marginRight: 10 }}
              />
              <Text style={[styles.disclosureText, textDir(isRTL)]}>
                {hasJwt === false
                  ? t("invite.signInRequired")
                  : online === false
                    ? t("invite.offline.banner")
                    : vaultOnServer === false
                      ? t("invite.link.notOnServer")
                      : t("invite.online.banner")}
              </Text>
            </View>
          ) : null}

          {/* PARKED (mesh): in-person QR pair fallback (vault/pair), parked with
              the rest of mesh. When offline / not signed in the invite screen
              now just shows its disabled-state disclosure above. Re-add when
              mesh ships again.
          {(online === false || hasJwt === false) && !result ? (
            <View style={styles.formInset}>
              <Pressable
                onPress={() => router.replace("/vault/pair")}
                style={({ pressed }) => [styles.fallbackCta, pressed && { opacity: 0.85 }]}
              >
                <Text style={[styles.fallbackCtaText, textDir(isRTL)]}>
                  {t("invite.offline.fallbackCta")}
                </Text>
              </Pressable>
            </View>
          ) : null}
          */}

          {!result ? (
            <>
              <View style={styles.formInset}>
                <Text style={[styles.intro, textDir(isRTL)]}>{t("invite.link.intro")}</Text>
              </View>

              <SectionGap />
              <SectionHeader label={t("invite.section.role")} isRTL={isRTL} />
              <View style={styles.formInset}>
                <View style={[styles.roleRow, rowDir(isRTL)]}>
                  <RolePill
                    value="editor"
                    label={t("invite.role.editor")}
                    hint={t("invite.role.editor.hint")}
                    selected={role === "editor"}
                    onSelect={setRole}
                  />
                  <RolePill
                    value="viewer"
                    label={t("invite.role.viewer")}
                    hint={t("invite.role.viewer.hint")}
                    selected={role === "viewer"}
                    onSelect={setRole}
                  />
                </View>

                {/* Disclosure: a viewer can READ the entire ledger (every
                    customer balance + phone number). The owner should know
                    what the link grants before sharing it. */}
                <Text style={[styles.fieldHint, textDir(isRTL)]}>
                  {role === "viewer"
                    ? t("invite.link.viewerDisclosure")
                    : t("invite.link.editorDisclosure")}
                </Text>

                <View style={{ height: 24 }} />
                <Button
                  label={t("invite.link.create")}
                  onPress={onSubmit}
                  loading={busy}
                  disabled={
                    !canInvite ||
                    online === false ||
                    online === null ||
                    hasJwt === false ||
                    hasJwt === null ||
                    vaultOnServer === false
                  }
                />
              </View>
            </>
          ) : (
            <>
              {/* Result: the shareable link is ready. */}
              <View style={[styles.identityRow, rowDir(isRTL)]}>
                <View
                  style={[styles.identityAvatar, isRTL ? { marginLeft: 14 } : { marginRight: 14 }]}
                >
                  <Ionicons name="link" size={22} color={colors.textEmphasis} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.identityName, textDir(isRTL)]} numberOfLines={1}>
                    {t("invite.link.ready")}
                  </Text>
                  <Text style={[styles.identitySub, textDir(isRTL)]} numberOfLines={2}>
                    {t("invite.link.readySub", {
                      role: t(role === "viewer" ? "invite.role.viewer" : "invite.role.editor"),
                      when: formatExpires(result.expires_at),
                    })}
                  </Text>
                </View>
              </View>

              <SectionGap />
              <SectionHeader label={t("invite.section.shareLink")} isRTL={isRTL} />
              <View style={styles.formInset}>
                <View style={styles.urlBox}>
                  <Text style={styles.urlText} numberOfLines={3}>
                    {result.invite_url}
                  </Text>
                </View>
              </View>
              <NavRow
                icon="logo-whatsapp"
                label={t("invite.shareWhatsapp")}
                onPress={onShare}
                isRTL={isRTL}
                emphasis
              />
              <NavRow
                icon="copy-outline"
                label={t("invite.copy")}
                onPress={onCopy}
                isRTL={isRTL}
                isLast
              />

              <SectionGap />
              <View style={styles.formInset}>
                <Button
                  label={t("invite.link.createAnother")}
                  variant="secondary"
                  onPress={() => {
                    setResult(null);
                    setRole("editor");
                  }}
                />
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function RolePill(props: {
  value: VaultRole;
  label: string;
  hint: string;
  selected: boolean;
  onSelect: (r: VaultRole) => void;
}) {
  return (
    <Pressable
      onPress={() => props.onSelect(props.value)}
      style={({ pressed }) => [
        styles.rolePill,
        props.selected && styles.rolePillSelected,
        pressed && { opacity: 0.85 },
      ]}
    >
      <Text style={[styles.rolePillLabel, props.selected && styles.rolePillLabelSelected]}>
        {props.label}
      </Text>
      <Text style={[styles.rolePillHint, props.selected && styles.rolePillHintSelected]}>
        {props.hint}
      </Text>
    </Pressable>
  );
}

function formatExpires(epochMs: number): string {
  const diff = epochMs - Date.now();
  if (diff <= 0) return t("invite.expiresIn.soon");
  const hours = Math.floor(diff / 3600_000);
  if (hours < 24) return t("invite.expiresIn.hours", { hours: Math.max(1, hours) });
  return t("invite.expiresIn.days", { days: Math.floor(hours / 24) });
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },

  scrollContent: { paddingBottom: 48 },
  formInset: { paddingHorizontal: 20, paddingTop: 4 },

  intro: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    lineHeight: sansLineHeight(14, 20),
  },

  fieldHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 6,
    lineHeight: sansLineHeight(12, 18),
  },

  // IdentityRow-style invitation result -----------------------------------
  identityRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    minHeight: 64,
  },
  identityAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  identityName: {
    fontSize: 16,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  identitySub: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 1,
  },

  // Role pills (kept as toggle buttons; not converted to NavRow because
  // they're a 2-up choice surface, not a list of destinations) ------------
  roleRow: { flexDirection: "row", gap: 10 },
  rolePill: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 10,
    backgroundColor: colors.bgDefault,
  },
  rolePillSelected: {
    borderColor: colors.textEmphasis,
    backgroundColor: colors.bgInverted,
  },
  rolePillLabel: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  rolePillLabelSelected: { color: colors.textInverted },
  rolePillHint: {
    fontSize: 11,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 4,
  },
  rolePillHintSelected: { color: colors.textMuted },

  urlBox: {
    padding: 14,
    backgroundColor: colors.bgMuted,
    borderRadius: 10,
  },
  urlText: {
    fontSize: 13,
    fontFamily: fonts.monoRegular,
    color: colors.textEmphasis,
  },

  // D-UI-UNIFICATION: offline disclosure + fallback CTA -------------------
  disclosure: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: colors.bgMuted,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  disclosureOffline: {
    backgroundColor: colors.bgMuted,
  },
  disclosureText: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    flex: 1,
  },
  fallbackCta: {
    marginTop: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: colors.bgInverted,
    alignItems: "center",
  },
  fallbackCtaText: {
    fontSize: 14,
    fontFamily: fonts.sansSemi,
    color: colors.textInverted,
  },
});
