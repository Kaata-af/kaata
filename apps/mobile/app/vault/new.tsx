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
import { useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { OptionSheet } from "../../components/OptionSheet";
import { NavRow, ScreenHeader } from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { CURRENCIES, DEFAULT_CURRENCY, getCurrencyName } from "../../lib/currency";
import {
  ACTIVE_VAULT_META_KEY,
  getDb,
  getAccountIdSync,
  setActiveVaultIdCache,
  setAppMetaInTx,
} from "../../lib/db-tx";
// Mythos Issue 1: owner display-name source for the mirror row.
import { getLocalSelf } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { appendShopProfileUpdated, appendVaultMemberAdded } from "../../lib/event-log";
import { t } from "../../lib/i18n";
import { ensureDeviceKey, getDevicePubkey } from "../../lib/mesh/device-key";
import { gutter, icon, radius, space, typography } from "../../lib/tokens";
import { buildLocalAccountId } from "../../lib/trust/account-id";
import { createVaultOnServer } from "../../lib/vault-api";

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
  // Currency is picked through a row→sheet, not a chip grid — see the NavRow
  // in the form below. Only the CONTROL changed; `currency` / setCurrency are
  // still the single source of truth for the INSERT.
  const [currencySheetVisible, setCurrencySheetVisible] = useState(false);
  const [creating, setCreating] = useState(false);
  // Synchronous re-entry guard — `creating` state can't stop a same-frame
  // double-tap (setState is async); see entry/new.tsx. Without it a
  // double-tap inserts two vaults.
  const creatingRef = useRef(false);
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

  async function onCreate() {
    if (creatingRef.current) return;
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
    creatingRef.current = true;
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
      creatingRef.current = false;
      setCreating(false);
      return;
    }

    // Mythos Issue 1: fetch the owner's display name BEFORE the txn (so we
    // don't nest a getDb query inside withTransactionAsync) and persist it
    // into the owner's own vault_members_mirror row. Without this, the
    // owner's own Members tab shows "Owner" instead of their name on a
    // brand-new vault before any sync round-trip.
    let ownerDisplayName: string | null = null;
    try {
      const self = await getLocalSelf();
      ownerDisplayName = (self?.name ?? "").trim() || null;
    } catch {
      ownerDisplayName = null;
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

        // 3) vault_members_mirror — ALWAYS insert, using the synthesized
        //    local account id when the user isn't signed in. The
        //    previous "if (accountId)" gate left local-only vaults with
        //    NO mirror row, which:
        //      (a) made vault/settings.tsx's COUNT(*) return 0 while
        //          useMembersCount's floor returned 1 → UI inconsistency
        //          (now both surfaces would read 1 from the real row).
        //      (b) left role-gate.resolveRoleAt with no binding for the
        //          OWNER's actor_account_id when remote events from
        //          this owner reach a peer — peers would refuse the
        //          owner's events because the owner isn't a member in
        //          the peer's mirror. Combined with the missing
        //          vault_member_added event for self (fixed below),
        //          this is why peers never showed owner-authored
        //          entries.
        //    The mirror INSERT below is the LOCAL projection; the
        //    appendVaultMemberAdded call after the txn emits the
        //    corresponding event so peers learn the binding via mesh.
        const ownerAccountId = accountId ?? buildLocalAccountId(trustAnchorPubkey);
        await db.runAsync(
          `INSERT INTO vault_members_mirror
             (vault_id, account_id, role, accepted_at, revoked_at, display_name)
           VALUES (?, ?, 'owner', ?, NULL, ?)`,
          vaultId,
          ownerAccountId,
          now,
          ownerDisplayName,
        );

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

      // M4: no self-VMC. The owner's trust authority comes from the
      // genesis vault_member_added (emitted below), which the chain fold
      // binds to this anchor device. The owner participates in the mesh
      // immediately via the chain handshake — no credential to mint.

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

      // Emit a vault_member_added event for SELF (the vault creator,
      // who is the owner). M2 membership chain: this IS the genesis
      // admission — the chain root (docs/m2-membership-chain.md §3.1).
      // It is authored + signed by THIS device through the normal local
      // append path, and the chain fold implicitly binds the anchor
      // device from it, so NO vault_device_added is emitted for the
      // creator. Pre-M2 rationale (still true): without this, peers
      // receiving entry/person/relationship events from this owner via
      // mesh would hit role-gate.resolveRoleAt finding no binding for
      // the owner's account_id → refuse with unknown_actor → events
      // silently dropped (Bug 3: joiner sees the vault but no entries).
      // The local applier reaches role-gate's local-only fallback
      // (origin='local' + actorAccountId=null → ok) so this is a no-op
      // for the local mirror but materially fixes the mesh
      // propagation path for both signed-in and local-CA owners.
      try {
        await appendVaultMemberAdded({
          targetVaultId: vaultId,
          accountId: accountId ?? buildLocalAccountId(trustAnchorPubkey),
          role: "owner",
        });
      } catch (err) {
        console.warn("[vault/new] vault_member_added emit failed", err);
      }

      // BUG-A: tell mesh the vault set changed so the new vault's
      // hash is added to BLE advertising AND so peers' advertisements
      // for it can be matched. Without this, the just-created vault
      // is invisible until Nearby sync is toggled off/on. No-op when
      // mesh isn't running.
      try {
        const mesh = await import("../../lib/mesh");
        await mesh.notifyVaultSetChanged();
      } catch (err) {
        console.warn("[vault/new] notifyVaultSetChanged failed", err);
      }

      // Fire-and-forget server registration — but now DURABLE. Skipped for
      // local-only installs. createVaultOnServer is idempotent (409 = already
      // registered = success); on success we stamp registered_with_server_at so
      // reconcileVaultRegistrations() (lib/sync/reconcile.ts) stops retrying. If
      // it fails (offline / 5xx / app killed mid-request), the column stays NULL
      // and the next sync sweep re-registers it. This is what closes the old
      // silent data-loss hole where a failed POST here was never retried.
      if (accountId) {
        void (async () => {
          try {
            await createVaultOnServer({
              vault_id: vaultId,
              name: trimmedShop,
              currency,
              created_at_ms: now,
              vault_trust_anchor_pubkey: trustAnchorPubkey,
            });
            const regDb = await getDb();
            const ts = Date.now();
            await regDb.runAsync(
              `UPDATE vaults
                  SET registered_with_server_at = COALESCE(registered_with_server_at, ?),
                      updated_at = ?
                WHERE id = ?`,
              ts,
              ts,
              vaultId,
            );
          } catch (err) {
            // Not fatal — the sync sweep's register-reconcile retries durably.
            console.warn("[vault/new] server register failed (sweep will retry)", err);
          }
        })();
      }

      toast.push(t("vaultNew.created", { name: trimmedShop }), "success");
      router.replace("/");
    } catch (err) {
      console.warn("[vault/new] create failed", err);
      toast.push(t("vaultNew.failed"), "error");
      creatingRef.current = false;
      setCreating(false);
    }
  }

  // Same trailing composition as vault/settings.tsx's currency row: symbol +
  // localized name, so "₨  Pakistani Rupee" reads to someone who doesn't know
  // the ISO codes. Built here (not in a memo) — it's two lookups per render.
  const currencyValue =
    `${CURRENCIES.find((c) => c.code === currency)?.symbol ?? ""}  ${getCurrencyName(currency)}`.trim();

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
          <View style={[styles.formInset, styles.formInsetTop]}>
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
          </View>

          {/* Currency: row→sheet, IDENTICAL to the edit path (vault/settings.tsx).
              The old control was a 9-chip wrapping grid at ~36px tall — under the
              44pt floor, and a mistap silently mislabels every future amount in
              this kaata (lib/currency.ts relabels, it never converts). NavRow
              clears the floor at 52px and the sheet gives each currency a full
              row, so creating and editing a kaata now use one mental model.
              Full-bleed on purpose: the row carries the 20px settings gutter that
              formInset above matches. */}
          <NavRow
            icon="cash-outline"
            label={t("vaultNew.currency.label")}
            trailing={currencyValue}
            // NavRow puts accessibilityLabel on the Pressable, which SUPPRESSES the
            // child text — so without this TalkBack announced only "Currency" and
            // never the selected value sitting in `trailing`. A blind user could not
            // hear which currency their ledger was about to be created in.
            accessibilityLabel={`${t("vaultNew.currency.label")}: ${currencyValue}`}
            onPress={() => setCurrencySheetVisible(true)}
            disabled={creating}
            isRTL={isRTL}
            isLast
          />

          <View style={styles.formInset}>
            <Text style={[styles.fieldHint, textDir(isRTL)]}>{t("vaultNew.currency.hint")}</Text>

            {/* Local-only disclosure sits ABOVE the Create button so users
                see it BEFORE they tap. Snapshotted at mount so it doesn't
                flicker if a concurrent sign-in races the form. */}
            {!accountIdAtMount ? (
              <View style={[styles.localOnlyHint, rowDir(isRTL)]}>
                <Ionicons
                  name="information-circle-outline"
                  size={icon.trailing}
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
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Per-kaata currency picker — same sheet, same option list and same
          selection tick as vault/settings.tsx. */}
      <OptionSheet
        visible={currencySheetVisible}
        title={t("vaultNew.currency.label")}
        options={CURRENCIES.map((c) => ({
          key: c.code,
          label: getCurrencyName(c.code),
          leading: c.symbol,
        }))}
        selected={currency}
        onSelect={(code) => {
          setCurrencySheetVisible(false);
          setCurrency(code);
        }}
        onDismiss={() => setCurrencySheetVisible(false)}
        isRTL={isRTL}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  // No horizontal padding on the scroll content: the currency NavRow is
  // full-bleed (it carries its own 20px settings gutter and a full-width press
  // surface), so everything else is inset separately at the SAME 20 via
  // formInset — the form's left edge and the row's label line up. That is
  // vault/settings.tsx's composition, which is the point: that screen is the
  // edit half of this one. Note the gutter moves 16 → 20 for the whole form.
  scrollContent: { paddingBottom: 48 },
  formInset: { paddingHorizontal: gutter.settings },
  // Only the first block needs top air under the ScreenHeader; the block below
  // the currency row continues straight on from it.
  formInsetTop: { paddingTop: space.lg },

  fieldHint: { ...typography.hint, color: colors.textSubtle, marginTop: space.sm },

  localOnlyHint: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginTop: 20,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.bgMuted,
    borderRadius: radius.sm,
  },
  localOnlyHintText: { flex: 1, ...typography.hint, color: colors.textSubtle },
});
