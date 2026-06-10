// Vault invite — Phase 7 redesigned to match the settings design language.
//
// Phase 8 D-UI-UNIFICATION: this screen is no longer the PRIMARY add-
// member affordance. In-person QR pair (vault/pair.tsx) is. This
// screen survives for cross-account, not-physically-present invitations:
// shopkeeper wants to add an accountant who lives in another city.
// Requires sign-in + internet (the server holds the invite token until
// the recipient signs in to accept). On offline, the form is rendered
// in a disabled state with a clear "switch to in-person flow" CTA —
// previously the user could fill out a form and hit an opaque API
// error on submit, which was the worst possible UX.
//
// Owner-only modal screen. Collects an email + a role (editor / viewer),
// POSTs to /v1/vaults/:vault_id/invites, and shows the resulting share URL
// with Copy / Share rows. Email normalization (trim + lowercase + gmail
// dot-strip) happens on the backend; we only do a coarse pre-flight here so
// the user sees inline feedback before the round-trip.

import { Ionicons } from "@expo/vector-icons";
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
  type TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import {
  EmptyHint,
  NavRow,
  ScreenHeader,
  SectionGap,
  SectionHeader,
} from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getActiveVaultId } from "../../lib/db-tx";
import { getAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { useVaultPermission } from "../../lib/use-vault-role";
import { createVaultInvite } from "../../lib/vault-api";
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
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [role, setRole] = useState<VaultRole>("editor");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InviteResult | null>(null);
  // D-UI-UNIFICATION: online gate. We snapshot connectivity once at
  // mount; the form submit is also gated by the live state so a user
  // who goes offline mid-edit gets a clear disabled CTA instead of an
  // opaque API error. `null` = unknown (initial state), treated as
  // online for UI purposes until the check resolves.
  const [online, setOnline] = useState<boolean | null>(null);
  const emailRef = useRef<TextInput>(null);

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
      const accId = await getAppMeta("account_id");
      setAccountId(accId);
    })();
    // Slight delay before focusing — pushed-screen slide-in needs to
    // finish or the soft keyboard never opens on Android (the recurring
    // kaata pattern).
    const timer = setTimeout(() => emailRef.current?.focus(), 280);
    return () => clearTimeout(timer);
  }, [router, toast]);

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

  function validateEmail(s: string): string | null {
    const trimmed = s.trim();
    if (!trimmed) return t("invite.email.required");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return t("invite.email.invalid");
    }
    return null;
  }

  async function onSubmit() {
    if (!canInvite) return;
    if (busy) return;
    if (!accountId) {
      // Email invites are server-mediated (the server holds the invite
      // token until the recipient signs in to accept) and the API requires
      // a Bearer JWT. A local-only user with no account_id can't reach
      // those endpoints. Surface a clear toast and route them to the QR
      // pair flow instead of letting them tap Submit and get
      // "POST /v1/vaults/.../invites: 401 — not signed in" as the toast.
      toast.push(t("invite.signInRequired"), "error");
      return;
    }
    const err = validateEmail(email);
    if (err) {
      setEmailError(err);
      return;
    }
    setEmailError(null);
    setBusy(true);
    try {
      const r = await createVaultInvite(vaultId, {
        email: email.trim(),
        role,
      });
      setResult(r);
      toast.push(t("invite.created"), "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("invite.failed");
      // Sanitize server error messages so the user doesn't see raw URLs
      // like "POST /v1/vaults/<uuid>/invites: 404 — vault_not_found".
      // Pattern-match on substrings the backend returns; fall back to a
      // generic "couldn't send invite — try again" toast.
      if (msg.includes("already_invited") || msg.includes("already")) {
        setEmailError(t("invite.email.alreadyInvited"));
      } else if (msg.includes("already_member")) {
        setEmailError(t("invite.email.alreadyMember"));
      } else if (msg.includes("not signed in") || msg.includes("401")) {
        toast.push(t("invite.signInRequired"), "error");
      } else if (msg.includes("vault_not_found") || msg.includes("404") || msg.includes("403")) {
        // The most common case for local-CA users who DID sign in once
        // but never registered THIS vault with the server: the vault
        // exists locally but the server has no record, so /v1/vaults/<id>
        // returns 404. Tell them to sync first, or use QR pair.
        toast.push(t("invite.vaultNotOnServer"), "error");
      } else {
        // Generic fallback. Never surface the raw URL.
        toast.push(t("invite.failed"), "error");
        if (__DEV__) console.warn("[vault/invite] submit failed:", msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!result) return;
    // UX critique #12: Without expo-clipboard, the cleanest fallback is
    // the system share sheet (which includes "Copy" on both iOS and
    // Android). The toast no longer claims "Link ready to share" when
    // it actually opened a share sheet — the user is in the sheet
    // already, so the toast says the link is in a sharable state.
    try {
      await Share.share({
        message: result.invite_url,
        url: result.invite_url,
      });
      toast.push(t("invite.copy.fallback"), "success");
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
                online === false || !accountId ? styles.disclosureOffline : null,
              ]}
            >
              <Ionicons
                name={
                  !accountId
                    ? "person-circle-outline"
                    : online === false
                      ? "cloud-offline-outline"
                      : "information-circle-outline"
                }
                size={18}
                color={online === false || !accountId ? colors.danger : colors.textSubtle}
                style={isRTL ? { marginLeft: 10 } : { marginRight: 10 }}
              />
              <Text style={[styles.disclosureText, textDir(isRTL)]}>
                {!accountId
                  ? t("invite.signInRequired")
                  : online === false
                    ? t("invite.offline.banner")
                    : t("invite.online.banner")}
              </Text>
            </View>
          ) : null}

          {(online === false || !accountId) && !result ? (
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

          {!result ? (
            <>
              <SectionHeader label={t("invite.section.invitee")} isRTL={isRTL} />
              <View style={styles.formInset}>
                <FormField
                  ref={emailRef}
                  label={t("invite.email.label")}
                  required
                  value={email}
                  editable={canInvite && !busy}
                  onChangeText={(s) => {
                    setEmail(s);
                    if (emailError) setEmailError(null);
                  }}
                  placeholder={t("invite.email.placeholder")}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="next"
                  error={emailError}
                />
                <Text style={[styles.fieldHint, textDir(isRTL)]}>{t("invite.gmailDotHint")}</Text>
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

                <View style={{ height: 24 }} />
                <Button
                  label={t("invite.submit")}
                  onPress={onSubmit}
                  loading={busy}
                  disabled={!canInvite || online === false || online === null || !accountId}
                />
              </View>
            </>
          ) : (
            <>
              {/* Result: invitation summary mirrors ProfileSettingsSheet's
                  identity row (avatar + name + sub). */}
              <View style={[styles.identityRow, rowDir(isRTL)]}>
                <View
                  style={[styles.identityAvatar, isRTL ? { marginLeft: 14 } : { marginRight: 14 }]}
                >
                  <Ionicons name="checkmark" size={22} color={colors.textEmphasis} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.identityName, textDir(isRTL)]} numberOfLines={1}>
                    {t("invite.result.sent")}
                  </Text>
                  <Text style={[styles.identitySub, textDir(isRTL)]} numberOfLines={1}>
                    {t("invite.result.sub", {
                      email: result.invite_email,
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
              <NavRow icon="copy-outline" label={t("invite.copy")} onPress={onCopy} isRTL={isRTL} />
              <NavRow
                icon="share-outline"
                label={t("invite.share")}
                onPress={onShare}
                isRTL={isRTL}
                emphasis
                isLast
              />

              <SectionGap />
              <View style={styles.formInset}>
                <Button
                  label={t("invite.again")}
                  variant="secondary"
                  onPress={() => {
                    setResult(null);
                    setEmail("");
                    setRole("editor");
                    setTimeout(() => emailRef.current?.focus(), 100);
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
  const days = Math.ceil(diff / (24 * 3600_000));
  if (days <= 1) return t("invite.expiresIn.lessThanDay");
  return t("invite.expiresIn.days", { days });
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },

  scrollContent: { paddingBottom: 48 },
  formInset: { paddingHorizontal: 20, paddingTop: 4 },

  fieldHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 6,
    lineHeight: 18,
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
