// Vault creation — Phase 5.2 "Add a Kaata".
//
// Surfaced from the hamburger menu's "Add a Kaata" row. Creates a new vault
// LOCALLY in one transaction, then fire-and-forget POSTs /v1/vaults if the
// install has a signed-in account_id. Local-only installs (no Google sign-in)
// must succeed end-to-end — server registration is skipped and the next
// successful sign-in will reconcile via GET /v1/vaults.
//
// Key correctness contracts:
//   1. account_id is NOT NULL in vault_members_mirror (migration 007). For
//      the local-only path we DO NOT insert a mirror row — useVaultRole's
//      LOCAL_OWNER_DEFAULT fallback returns 'owner' when no mirror row
//      exists (use-vault-role.ts), which is what we want.
//   2. The vault becomes the active vault in the SAME transaction that
//      inserts the vault row. If the active-vault write fails, the vault
//      insert rolls back — no orphan "created but not active" vault rows
//      that would lie to the user with a success toast. We update the
//      in-memory cache only AFTER the txn commits successfully.
//   3. Server POST is fire-and-forget: if it fails (offline, 5xx, 409
//      collision), the local vault still works — the next AutoSync /
//      reconcile pass picks it up. We toast a soft warning on failure but
//      do NOT block navigation or roll back the local vault.
//   4. Double-tap guard: `creating` state disables the Create button after
//      the first tap and stays disabled until navigation fires.

import { Ionicons } from "@expo/vector-icons";
import * as Crypto from "expo-crypto";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { ScreenHeader } from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { getBackendUrl } from "../../lib/api";
import { getSessionJWT } from "../../lib/auth";
import { colors } from "../../lib/colors";
import { CURRENCIES, DEFAULT_CURRENCY, getCurrencyName } from "../../lib/currency";
import {
  ACTIVE_VAULT_META_KEY,
  getDb,
  getAccountIdSync,
  getInstallIdSync,
  setActiveVaultIdCache,
  setAppMetaInTx,
} from "../../lib/db-tx";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { appendShopProfileUpdated } from "../../lib/event-log";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { ensureDeviceKey, getDevicePubkey } from "../../lib/mesh/device-key";
import { buildLocalAccountId, issueLocalVMC } from "../../lib/mesh/local-vmc";
import { cacheVMC } from "../../lib/mesh/vmc";

const NAME_MAX = 50;

export default function VaultNewScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();

  // UX-fix #1 (Phase 7 finalize): /vault/new?forced=1 is the
  // archive-the-last-vault forced-create entry point. In that mode the
  // user has no parent to pop back to (settings did router.replace), so
  // the back chevron would silently dead-end. Hide it instead, and skip
  // the "Cancel" affordance so the screen reads as "you must complete
  // this" rather than "you can bail out". The non-forced flow (add a
  // Kaata from the picker / settings sheet) keeps the back chevron.
  const params = useLocalSearchParams<{ forced?: string }>();
  const forced = params.forced === "1";

  const [shopName, setShopName] = useState("");
  const [currency, setCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [creating, setCreating] = useState(false);
  // Phase 7 D-VAULT-NAME-REQUIRED: inline error surfaces when the user
  // taps Create with an empty name OR when the name is empty on blur.
  // The Button's disabled-on-empty rule still guards the happy path; the
  // inline error is the "tell me why nothing happened" affordance.
  const [nameError, setNameError] = useState<string | null>(null);

  // Snapshot account presence at mount-time so the local-only hint and the
  // server-POST gate don't flicker if a sign-in completes mid-form (vanishingly
  // unlikely, but the hint UI shouldn't reactively appear/disappear under the
  // user mid-tap).
  const accountIdAtMount = useMemo(() => getAccountIdSync(), []);

  const currencyOptions = useMemo(() => CURRENCIES.map((c) => c.code), []);

  async function onCreate() {
    if (creating) return;
    const trimmedShop = shopName.trim();
    // Phase 7 D-VAULT-NAME-REQUIRED: name is required. The Button is
    // disabled-on-empty (happy path), but if a future refactor drops
    // that rule the inline error surfaces and we still refuse to INSERT
    // (DB schema is TEXT NOT NULL but accepts the empty string).
    if (!trimmedShop) {
      setNameError(t("vaultNew.name.required"));
      return;
    }
    setNameError(null);
    setCreating(true);

    const vaultId = Crypto.randomUUID();
    const now = Date.now();
    const accountId = getAccountIdSync();

    // Phase 7 D-LOCAL-CA-ARCHITECTURE: the vault owner's device key is
    // ALWAYS the mesh trust anchor for new vaults — even when signed
    // in. Server sync remains a secondary trust path (used when the
    // user is signed in + opts in). ensureDeviceKey is idempotent +
    // cached; we run it BEFORE the txn so a missing-keystore failure
    // aborts cleanly instead of leaving a half-created vault.
    let trustAnchorPubkey: string;
    try {
      await ensureDeviceKey();
      const pk = getDevicePubkey();
      if (!pk) {
        throw new Error("device pubkey unavailable post-ensureDeviceKey");
      }
      trustAnchorPubkey = pk;
    } catch (err) {
      console.warn("[vault/new] ensureDeviceKey failed", err);
      toast.push(t("vaultNew.failed"), "error");
      setCreating(false);
      return;
    }

    try {
      const db = await getDb();
      await db.withTransactionAsync(async () => {
        // 1) vaults row. is_default=0 — only the bootstrap vault from
        //    migration 007 / createSelfProfile gets is_default=1.
        //    registered_with_server_at stays NULL until the POST /v1/vaults
        //    round-trip succeeds (the AutoSync reconcile pass stamps it).
        //    vault_trust_anchor_pubkey set unconditionally — owner's
        //    device is the root of mesh trust regardless of sign-in.
        await db.runAsync(
          `INSERT INTO vaults
             (id, name, currency, created_at, updated_at, archived_at,
              is_default, account_id, registered_with_server_at,
              vault_epoch, hlc_logical, hlc_wall_ms,
              vault_trust_anchor_pubkey)
           VALUES (?, ?, ?, ?, ?, NULL, 0, ?, NULL, 0, 0, 0, ?)`,
          vaultId,
          trimmedShop,
          currency,
          now,
          now,
          accountId, // nullable column; null on local-only installs
          trustAnchorPubkey,
        );

        // 2) shop_profile row (per-vault, keyed by vault_id). owner_name
        //    is nullable per the post-migration-007 schema; founder removed
        //    the form field in Phase 5.3 after real-device testing (only
        //    shop name + currency are collected). Projection-replay treats
        //    NULL as "no owner name" and renders the shop name standalone.
        await db.runAsync(
          `INSERT INTO shop_profile
             (vault_id, owner_name, shop_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          vaultId,
          null,
          trimmedShop,
          now,
          now,
        );

        // 3) vault_members_mirror — ONLY when signed in. The column is
        //    NOT NULL; local-only installs have no account_id and rely on
        //    useVaultRole's LOCAL_OWNER_DEFAULT fallback for the missing
        //    mirror row. Server reconciliation will populate this row on
        //    the next /v1/vaults pull after sign-in.
        if (accountId) {
          await db.runAsync(
            `INSERT INTO vault_members_mirror
               (vault_id, account_id, role, accepted_at, revoked_at)
             VALUES (?, ?, 'owner', ?, NULL)`,
            vaultId,
            accountId,
            now,
          );
        }

        // 4) Flip active_vault_id INSIDE the txn so a write failure here
        //    rolls back the vault + shop_profile + mirror rows — no
        //    "vault exists but isn't active" orphan state, and no
        //    misleading "Failed to create" toast on the (rare) app_meta
        //    write failure path. Cache flip happens after commit (below).
        await setAppMetaInTx(db, ACTIVE_VAULT_META_KEY, vaultId);
      });

      // Txn committed — sync the in-memory cache to match. Doing this
      // outside the txn keeps the cache in lockstep with the persisted
      // value on the success path only.
      setActiveVaultIdCache(vaultId);

      // Phase 7: self-VMC. The owner's device issues a VMC FOR ITSELF
      // signed with its own privkey, verifiable against the vault's
      // trust anchor (which equals this same pubkey). That lets the
      // owner participate in the mesh immediately — no server round-
      // trip, no sign-in. cacheVMC is idempotent at (vault_id, device_id)
      // so the next sign-in / server VMC issuance doesn't fight this.
      try {
        const selfAccountId = accountId ?? buildLocalAccountId(trustAnchorPubkey);
        const { blob, expiresAtMs } = await issueLocalVMC({
          vaultId,
          peerAccountId: selfAccountId,
          peerDeviceId: getInstallIdSync(),
          peerDevicePubkey: trustAnchorPubkey,
          role: "owner",
          vaultEpoch: 0,
        });
        await cacheVMC(vaultId, blob, expiresAtMs, selfAccountId, trustAnchorPubkey, 0);
      } catch (err) {
        // Non-fatal: a future mesh start can re-issue. The vault row +
        // trust anchor are persisted regardless.
        console.warn("[vault/new] self-VMC issuance failed", err);
      }

      // Emit a shop_profile_updated event so a wipe-and-replay (or a Phase 3
      // second-device restore-from-log) reconstructs THIS vault's shop_name.
      // Without this, the direct INSERT into shop_profile above is invisible
      // to event replay — paired devices would see the vault row arrive via
      // the vaults-reconcile pull but the per-vault shop_name would be NULL.
      // Mirrors the same call in createSelfProfile (db.ts) which does the
      // equivalent for the onboarding-minted default vault. Best-effort: a
      // transient failure leaves the local row in place and the next
      // updateSelfProfile / shop-rename call will re-emit. owner_name is
      // intentionally null — vault/new doesn't collect that field and the
      // projection treats null as "no owner name" (renders shop_name alone).
      try {
        await appendShopProfileUpdated({
          vaultId,
          changes: { shop_name: trimmedShop, owner_name: null },
        });
      } catch (err) {
        console.warn("[vault/new] shop_profile_updated emit failed", err);
      }

      // Fire-and-forget server registration. Skipped for local-only
      // installs; deferred to the next sign-in + sync. Phase 7: we
      // also send the trust anchor pubkey so the server can publish
      // it on GET /v1/vaults for cross-device discovery.
      if (accountId) {
        registerVaultWithServer(vaultId, trimmedShop, currency, now, trustAnchorPubkey).catch(
          (err) => {
            // Not fatal — vault still works locally and AutoSync's
            // vaults-reconcile pass will retry on the next pull.
            console.warn("[vault/new] server register failed", err);
          },
        );
      }

      toast.push(t("vaultNew.created", { name: trimmedShop }), "success");
      router.replace("/");
    } catch (err) {
      console.warn("[vault/new] create failed", err);
      toast.push(t("vaultNew.failed"), "error");
      setCreating(false);
    }
  }

  return (
    // Default SafeAreaView edges (matches vault/settings, vault/members,
    // vault/invite, vault/pair). Explicit edges={["top","bottom"]} caused
    // the form to render half-cut on Android — combined with the previous
    // `presentation: "modal"` Stack.Screen config it pushed content above
    // the visible viewport. Card presentation + default edges is the
    // shared pattern across every vault/* screen.
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      {/* Phase 7 coherence pass: replaced the bespoke "Cancel" left button
          with the shared ScreenHeader (chevron-back). Matches every other
          settings sub-page. The chevron back is disabled while creating
          to avoid mid-transaction navigation.

          UX-fix #1: when entered as the forced post-archive-last flow,
          the back chevron is suppressed (no parent to pop to) and the
          title swaps to a "Create a Kaata" framing instead of the
          neutral "Add a Kaata". */}
      <ScreenHeader
        title={forced ? t("vaultNew.titleForced") : t("vaultNew.title")}
        onBack={
          forced
            ? null
            : () => {
                if (!creating) router.back();
              }
        }
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
          <FormField
            label={t("vaultNew.name.label")}
            required
            value={shopName}
            editable={!creating}
            maxLength={NAME_MAX}
            autoCapitalize="words"
            placeholder={t("vaultNew.name.placeholder")}
            onChangeText={(s) => {
              setShopName(s);
              if (nameError) setNameError(null);
            }}
            onBlur={() => {
              if (!shopName.trim()) {
                setNameError(t("vaultNew.name.required"));
              }
            }}
            error={nameError}
          />

          <Text style={[styles.label, textDir(isRTL)]}>{t("vaultNew.currency.label")}</Text>
          <View style={[styles.currencyRow, rowDir(isRTL)]}>
            {currencyOptions.map((code) => {
              const selected = code === currency;
              const entry = CURRENCIES.find((c) => c.code === code);
              return (
                <Pressable
                  key={code}
                  onPress={() => setCurrency(code)}
                  disabled={creating}
                  accessibilityRole="button"
                  accessibilityLabel={`${code} — ${getCurrencyName(code)}`}
                  style={({ pressed }) => [
                    styles.currencyChip,
                    selected && styles.currencyChipSelected,
                    creating && { opacity: 0.5 },
                    pressed && !selected && { backgroundColor: colors.bgMuted },
                  ]}
                >
                  <Text
                    style={[styles.currencyChipText, selected && styles.currencyChipTextSelected]}
                  >
                    {/* code + symbol so "TRY" / "AED" / "IRR" are recognizable
                        to non-traders who don't know every ISO currency code. */}
                    {code}
                    {entry ? `  ${entry.symbol}` : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={[styles.fieldHint, textDir(isRTL)]}>{t("vaultNew.currency.hint")}</Text>

          {/* Local-only disclosure sits ABOVE the Create button so users
              see it BEFORE they tap. Snapshotted at mount so it doesn't
              flicker if a concurrent sign-in races the form. */}
          {!accountIdAtMount ? (
            <View style={[styles.localOnlyHint, rowDir(isRTL)]}>
              <Ionicons
                name="information-circle-outline"
                size={16}
                color={colors.textSubtle}
                style={isRTL ? { marginLeft: 8 } : { marginRight: 8 }}
              />
              <Text style={[styles.localOnlyHintText, textDir(isRTL)]}>
                {t("vaultNew.localOnlyHint")}
              </Text>
            </View>
          ) : null}

          <View style={{ height: 16 }} />

          <Button
            label={t("vaultNew.submit")}
            onPress={onCreate}
            disabled={creating || shopName.trim().length === 0}
            loading={creating}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// Fire-and-forget POST /v1/vaults. Inlined here (not added to vault-api.ts)
// because the create flow has no other call sites in Phase 5.2 — promote
// when a second screen needs the same call.
async function registerVaultWithServer(
  vaultId: string,
  name: string,
  currency: string,
  createdAtMs: number,
  vaultTrustAnchorPubkey?: string,
): Promise<void> {
  const jwt = await getSessionJWT();
  if (!jwt) return;
  const baseUrl = await getBackendUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${baseUrl}/v1/vaults`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        vault_id: vaultId,
        name,
        currency,
        created_at_ms: createdAtMs,
        // Phase 7: forward the trust anchor when set so the server's
        // GET /v1/vaults can publish it for cross-device discovery.
        // Older backends ignore the unknown field.
        ...(vaultTrustAnchorPubkey ? { vault_trust_anchor_pubkey: vaultTrustAnchorPubkey } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 409 = vault_id collision (essentially impossible with v4 UUID).
      // Surface the body in the console for triage and move on — the next
      // reconcile pass will resolve any divergence.
      let body = "";
      try {
        body = (await res.text()).slice(0, 200);
      } catch {}
      throw new Error(`POST /v1/vaults: ${res.status} ${body}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  scrollContent: { padding: 16, paddingBottom: 48 },

  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  fieldHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 8,
  },

  currencyRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  currencyChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    backgroundColor: colors.bgDefault,
  },
  currencyChipSelected: {
    borderColor: colors.textEmphasis,
    backgroundColor: colors.bgInverted,
  },
  currencyChipText: {
    fontSize: 13,
    fontFamily: fonts.monoMedium,
    color: colors.textEmphasis,
  },
  currencyChipTextSelected: { color: colors.textInverted },

  localOnlyHint: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginTop: 20,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.bgMuted,
    borderRadius: 8,
  },
  localOnlyHintText: {
    flex: 1,
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: 17,
  },
});
