// Join a mutual tab (docs/mutual-tab-design.md §4.4, D10/D11/D15).
//
// Route: kaata://t/<token> — the web page at kaata.af/t/<token> has an "Open
// in Kaata" button that fires it, and the token in the path IS the credential
// (D11: the invite link is party B's link, and it is never spent on join).
//
// Sign-in is required; the invitation is claimed by an account, not by a browser.
//
// Stages: loading → preview (what am I being invited to?) → pick (which kaata,
// which contact?) → joining → done. Errors are rendered INLINE on the stage
// that produced them — this is a presentation:"modal" screen and toasts cannot
// render above one (components/Toast.tsx).
//
// Three handoffs this screen owns, all through app_meta.pending_tab_token:
//   1. No local self yet (the link opened a fresh install, or one that is
//      mid-onboarding): stash and send the user into onboarding. The screen
//      that finally lands home — onboarding/success — reads the stash and
//      comes back here.
//   2. No kaata in the tab's currency (D9): stash and push /vault/new, which
//      routes back here instead of home after the create.
//   3. Arrived with everything in place: clear the stash, so a later
//      onboarding or vault create does not re-open an already-joined link.

import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "../../components/Button";
import { ScreenLoading } from "../../components/ScreenLoading";
import { ScreenHeader } from "../../components/SettingsScreen";
import { queuePendingToast } from "../../components/Toast";
import { getSessionJWT } from "../../lib/auth";
import { colors } from "../../lib/colors";
import { getCurrencySymbol, applyVaultCurrency } from "../../lib/currency";
import {
  getAppMeta,
  getLocalSelf,
  listActiveVaults,
  setAppMeta,
  type VaultListRow,
} from "../../lib/db";
import { getActiveVaultIdSyncMaybe, setActiveVaultId } from "../../lib/db-tx";
import { toAsciiDigits } from "../../lib/digits";
import {
  ltrIsolate,
  bidiIsolate,
  rowDir,
  textDir,
  trackingSafe,
  useIsRTL,
} from "../../lib/direction";
import { fonts, monoLineHeight, sansLineHeight } from "../../lib/fonts";
import { formatAmount } from "../../lib/format";
import { t } from "../../lib/i18n";
import { fromMinorUnits } from "../../lib/money";
import { getCountry, getCurrentDefaultCountryCode } from "../../lib/phone";
import { PHONE_SEARCH_MIN_DIGITS, searchContacts } from "../../lib/search";
import {
  getPersonIdForRelationship,
  getTabLink,
  listVaultContactsForJoin,
  type TabJoinCandidate,
} from "../../lib/tabs/db";
import { otherRole } from "../../lib/tabs/direction";
import {
  fetchTabPreview,
  joinTabAsContact,
  TabAlreadyLinkedError,
  TabApiError,
  TabClosedError,
  TabCreatePersonError,
  TabCurrencyMismatchError,
  TabPermissionError,
  TabSameKaataError,
  type JoinTarget,
} from "../../lib/tabs/link";
import type { WireEntry, WireTab } from "../../lib/tabs/types";
import { wireToMinor } from "../../lib/tabs/wire";
import { icon, radius, TOUCH_MIN } from "../../lib/tokens";

type Stage = "loading" | "preview" | "pick" | "joining" | "error";

const PENDING_TOKEN_KEY = "pending_tab_token";

// presentation:"modal": SafeAreaView must inset all four edges, and the
// pre-content branches have to say so too or the header shifts when the read
// resolves (see app/tab/dispute.tsx).
const MODAL_EDGES = ["top", "bottom", "left", "right"] as const;

export default function TabJoinScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const { token: tokenParam } = useLocalSearchParams<{ token: string }>();
  const token = typeof tokenParam === "string" ? tokenParam : null;

  const [stage, setStage] = useState<Stage>("loading");
  const [tab, setTab] = useState<WireTab | null>(null);
  const [entries, setEntries] = useState<WireEntry[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  // Only a transport failure is worth a Retry button; a closed or unknown tab
  // is a verdict the server will repeat forever (lib/tabs/errors.ts).
  const [retryable, setRetryable] = useState(false);
  // Inline failure on the pick/join stages — the preview and the picker stay
  // on screen so the user can change their answer and retry.
  const [pickError, setPickError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // Vault half of the pick stage.
  const [vaults, setVaults] = useState<VaultListRow[] | null>(null);
  const [vaultId, setVaultId] = useState<string | null>(null);
  // Contact half.
  const [contacts, setContacts] = useState<TabJoinCandidate[] | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");

  // Synchronous re-entry guard: `stage` is state, so two fast taps both reach
  // joinTabAsContact and the second creates a duplicate contact before the
  // first has committed its link (the invite screen's acceptingRef lesson).
  const joiningRef = useRef(false);
  // Bumped by Retry to re-run the preview effect after a transport failure.
  const [attempt, setAttempt] = useState(0);

  const country = getCountry(getCurrentDefaultCountryCode());

  // ---- preview -----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!token) {
        setErrorMsg(t("tab.join.notFound"));
        setStage("error");
        return;
      }
      try {
        // Onboarding handoff. getLocalSelf() is null on a fresh install and
        // through the whole of onboarding until the kaata step mints the self
        // + first vault, and there is nothing to join INTO before that.
        const self = await getLocalSelf();
        if (cancelled) return;
        if (!(await getSessionJWT())) {
          await setAppMeta(PENDING_TOKEN_KEY, token);
          router.replace("/sign-in");
          return;
        }
        if (!self) {
          await setAppMeta(PENDING_TOKEN_KEY, token);
          router.replace(await onboardingRouteForStash());
          return;
        }
        // We are past the handoffs: the stash has done its job. Cleared here
        // rather than after the join so an abandoned link cannot re-open
        // itself the next time onboarding or vault/new finishes.
        await setAppMeta(PENDING_TOKEN_KEY, "");

        const preview = await fetchTabPreview(token);
        if (cancelled) return;
        // Already joined on THIS device: the link row is the proof (a join
        // from another device of a shared kaata would arrive via /mine). Go
        // straight to the contact rather than offering to join twice.
        const existing = await getTabLink(preview.tab.id);
        if (cancelled) return;
        if (preview.tab.parties[preview.tab.you].joined_at_ms != null && existing) {
          const personId = await getPersonIdForRelationship(existing.relationship_id);
          if (cancelled) return;
          if (personId) {
            await setActiveVaultId(existing.vault_id);
            await applyVaultCurrency(existing.vault_id);
            router.replace({ pathname: "/person/[id]", params: { id: personId } });
            return;
          }
        }
        if (preview.tab.closed_at_ms != null) {
          setErrorMsg(t("tab.join.closed"));
          setStage("error");
          return;
        }
        setTab(preview.tab);
        setEntries(preview.entries);
        setStage("preview");
      } catch (err) {
        if (cancelled) return;
        // Raw err stays in the console; the user sees localized copy only.
        console.warn("[tab/join] preview failed", err);
        if (err instanceof TabApiError && err.status === 404) {
          setErrorMsg(t("tab.join.notFound"));
        } else {
          setErrorMsg(t("tab.link.failed"));
          setRetryable(true);
        }
        setStage("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, router, attempt]);

  // ---- pick --------------------------------------------------------------
  const openPick = useCallback(async () => {
    if (!tab) return;
    setPickError(null);
    setStage("pick");
    // D9: a tab can only be linked into a kaata of the SAME currency, because
    // the app never computes a rate and a mixed-currency balance is a lie.
    const all = await listActiveVaults().catch(() => [] as VaultListRow[]);
    const matching = all.filter((v) => v.currency === tab.currency);
    setVaults(matching);
    const active = getActiveVaultIdSyncMaybe();
    // One candidate is not a choice — skip straight to the contact list. With
    // several, preselect the one the user is already looking at, if it fits.
    const preselect =
      matching.length === 1
        ? matching[0].id
        : matching.some((v) => v.id === active)
          ? active
          : null;
    setVaultId(preselect);
  }, [tab]);

  // Contacts load whenever the picked kaata changes (including the preselect).
  useEffect(() => {
    if (stage !== "pick" || !vaultId) return;
    let cancelled = false;
    setContacts(null);
    void listVaultContactsForJoin(vaultId)
      .then((rows) => {
        if (!cancelled) setContacts(rows);
      })
      .catch((err) => {
        console.warn("[tab/join] contact list failed", err);
        if (!cancelled) setContacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [stage, vaultId]);

  // ---- join --------------------------------------------------------------
  async function runJoin(target: JoinTarget, displayName: string) {
    if (!token || !tab || joiningRef.current) return;
    joiningRef.current = true;
    setPickError(null);
    setPhoneError(null);
    setStage("joining");
    try {
      const self = await getLocalSelf();
      // How I will appear to the other party. The shop name is the name they
      // know me by; the personal name is the fallback for a kaata that never
      // got one.
      const myLabel = self?.shop_name?.trim() || self?.name?.trim() || "";
      const link = await joinTabAsContact(token, tab, target, myLabel);
      const personId =
        "personId" in target
          ? target.personId
          : await getPersonIdForRelationship(link.relationship_id);
      queuePendingToast(t("tab.join.done", { name: displayName }), "success");
      if (personId) {
        router.replace({ pathname: "/person/[id]", params: { id: personId } });
      } else {
        // The link committed but the contact could not be resolved (torn local
        // state). Home still shows it — never strand the user on this modal.
        router.replace("/");
      }
    } catch (err) {
      joiningRef.current = false;
      setStage("pick");
      console.warn("[tab/join] join failed", err);
      if (err instanceof TabCreatePersonError) {
        // Same wording person/new.tsx uses, on the field that caused it.
        if (err.result.error === "phone_invalid") {
          setPhoneError(t("personAdd.phone.invalid"));
        } else if (err.result.error === "phone_is_self") {
          setPhoneError(t("personAdd.phone.isSelf"));
        } else if (err.result.error === "phone_conflict") {
          setPhoneError(t("personAdd.phone.conflict", { name: err.result.existing.name }));
        } else {
          setPickError(t("personAdd.save.failed"));
        }
      } else if (err instanceof TabCurrencyMismatchError) {
        setPickError(
          // ISO codes are Latin tokens dropped into Dari prose: isolate each
          // one or the bidi algorithm runs it into the punctuation beside it.
          t("tab.join.currencyMismatch", {
            kaata: bidiIsolate(err.vaultCurrency),
            tab: bidiIsolate(err.tabCurrency),
          }),
        );
      } else if (err instanceof TabSameKaataError) {
        setPickError(t("tab.join.sameKaata"));
      } else if (err instanceof TabAlreadyLinkedError) {
        setPickError(t("tab.join.alreadyLinked"));
      } else if (err instanceof TabClosedError) {
        setPickError(t("tab.join.closed"));
      } else if (err instanceof TabPermissionError) {
        setPickError(t("entry.roleDenied"));
      } else {
        // Everything left is either a TabInputError the screen's own gates
        // should have caught (an empty label on a kaata with no name) or a
        // transport failure. Both are "it didn't save"; the console keeps the
        // detail.
        setPickError(t("entry.saveFailed"));
      }
    }
  }

  // ---- derived -----------------------------------------------------------
  const otherLabel = tab ? tab.parties[otherRole(tab.you)].label.trim() : "";
  const otherName = otherLabel || t("tab.them");
  const symbol = tab ? getCurrencySymbol(tab.currency) : "";
  // Balance from MY seat, signed: positive = the other party owes me.
  const balance = useMemo(() => {
    if (!tab) return 0;
    try {
      return fromMinorUnits(wireToMinor(tab.balance[tab.you]));
    } catch {
      // A malformed amount is a server bug; showing 0 beats crashing the join.
      return 0;
    }
  }, [tab]);
  // Only tallies that count: void rows and voided originals are not history
  // the joiner needs to be told about up front (D5).
  const liveEntryCount = entries.filter(
    (e) => e.kind !== "void" && e.voided_by_entry_id == null,
  ).length;

  const filteredContacts = useMemo(() => {
    const list = contacts ?? [];
    const name = query.trim();
    const digits = toAsciiDigits(query).replace(/\D/g, "");
    const phoneNeedle = digits.length >= PHONE_SEARCH_MIN_DIGITS ? digits : "";
    if (!name && !phoneNeedle) return list;
    // One box, both axes: searchContacts ranks a first-name query and a phone
    // query together, which is what person/new's two fields feed it.
    return searchContacts(name, "", phoneNeedle, list);
  }, [contacts, query]);

  // ---- render ------------------------------------------------------------
  const title = t("tab.join.title");
  const onBack = () => router.replace("/");

  if (stage === "loading") {
    return <ScreenLoading title={title} onBack={onBack} isRTL={isRTL} edges={MODAL_EDGES} />;
  }

  if (stage === "error") {
    return (
      <SafeAreaView style={styles.container} edges={MODAL_EDGES}>
        <ScreenHeader title={title} onBack={onBack} isRTL={isRTL} backLabel={t("common.cancel")} />
        <View style={styles.fillCenter}>
          <Ionicons name="alert-circle-outline" size={icon.hero} color={colors.danger} />
          <View style={{ height: 12 }} />
          <Text style={[styles.body, styles.centeredText]}>{errorMsg}</Text>
          <View style={{ height: 20 }} />
          {retryable ? (
            <>
              <Button
                label={t("common.retry")}
                onPress={() => {
                  setRetryable(false);
                  setStage("loading");
                  setAttempt((a) => a + 1);
                }}
              />
              <View style={{ height: 12 }} />
            </>
          ) : null}
          <Button label={t("common.backToKaata")} variant="secondary" onPress={onBack} />
        </View>
      </SafeAreaView>
    );
  }

  if (stage === "joining") {
    return (
      <SafeAreaView style={styles.container} edges={MODAL_EDGES}>
        <ScreenHeader title={title} onBack={null} isRTL={isRTL} />
        <View style={styles.fillCenter}>
          <ActivityIndicator color={colors.textDefault} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={MODAL_EDGES}>
      <ScreenHeader title={title} onBack={onBack} isRTL={isRTL} backLabel={t("common.cancel")} />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.scrollContent}
        >
          {stage === "preview" && tab ? (
            <View>
              {/* Who is inviting, in their own words — parties.label is how a
                  party names ITSELF, which is what the other side reads. */}
              <Text style={[styles.heading, textDir(isRTL)]}>
                {t("tab.join.from", { name: otherName })}
              </Text>

              <View style={styles.card}>
                <Text style={[styles.cardLabel, textDir(isRTL), trackingSafe(isRTL)]}>
                  {t("tab.join.balanceLabel")}
                </Text>
                {/* Direction colours (emerald/garnet) are the ONE thing they
                    are allowed to mean here, exactly as on the person screen:
                    positive = they owe me. The sign is carried in the glyph,
                    never in the colour alone. */}
                <View style={[styles.balanceRow, rowDir(isRTL)]}>
                  <Text
                    style={[
                      styles.balance,
                      {
                        color:
                          balance > 0
                            ? colors.collectStrong
                            : balance < 0
                              ? colors.payStrong
                              : colors.textMuted,
                      },
                    ]}
                  >
                    {balance === 0 ? "" : balance > 0 ? "+" : "−"}
                    {formatAmount(Math.abs(balance))}
                  </Text>
                  <Text style={styles.balanceSymbol}>{symbol}</Text>
                </View>
                <Text style={[styles.cardMeta, textDir(isRTL)]}>
                  {t("tab.join.entries", { count: liveEntryCount })}
                </Text>
              </View>

              <View style={{ height: 24 }} />
              <Button label={t("tab.join.join")} onPress={() => void openPick()} />
            </View>
          ) : null}

          {stage === "pick" && tab ? (
            <View>
              {vaults === null ? (
                <View style={styles.fillCenter}>
                  <ActivityIndicator color={colors.textDefault} />
                </View>
              ) : vaults.length === 0 ? (
                // No kaata in this currency (D9). Offer to make one; the stash
                // is re-armed so vault/new comes back here instead of home.
                <View>
                  <Text style={[styles.body, textDir(isRTL)]}>
                    {t("tab.join.noCurrencyKaata", { currency: bidiIsolate(tab.currency) })}
                  </Text>
                  <View style={{ height: 20 }} />
                  <Button
                    label={t("tab.join.createKaata", { currency: bidiIsolate(tab.currency) })}
                    onPress={() => {
                      void (async () => {
                        if (token) await setAppMeta(PENDING_TOKEN_KEY, token);
                        router.push("/vault/new");
                      })();
                    }}
                  />
                </View>
              ) : vaultId === null ? (
                <View>
                  <Text style={[styles.heading, textDir(isRTL)]}>{t("tab.join.pickKaata")}</Text>
                  <View style={styles.listCard}>
                    {vaults.map((v, index) => (
                      <View key={v.id}>
                        {index > 0 ? <View style={styles.divider} /> : null}
                        <Pressable
                          onPress={() => setVaultId(v.id)}
                          accessibilityRole="button"
                          style={({ pressed }) => [
                            styles.row,
                            rowDir(isRTL),
                            pressed && styles.rowPressed,
                          ]}
                        >
                          <Text style={[styles.rowName, textDir(isRTL)]} numberOfLines={1}>
                            {v.name}
                          </Text>
                          <Text style={styles.rowTrailing}>{getCurrencySymbol(v.currency)}</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                </View>
              ) : (
                <View>
                  <Text style={[styles.heading, textDir(isRTL)]}>
                    {t("tab.join.pickContact", { name: otherName })}
                  </Text>

                  {/* Switch kaata again — only offered when there was a real
                      choice to begin with. */}
                  {vaults.length > 1 ? (
                    <Pressable
                      onPress={() => {
                        setVaultId(null);
                        setPickError(null);
                      }}
                      style={({ pressed }) => [styles.switchRow, pressed && styles.rowPressed]}
                    >
                      <Text style={[styles.switchText, textDir(isRTL)]}>
                        {vaults.find((v) => v.id === vaultId)?.name ?? ""}
                      </Text>
                      <Ionicons
                        name="swap-horizontal-outline"
                        size={icon.trailing}
                        color={colors.textMuted}
                      />
                    </Pressable>
                  ) : null}

                  {creating ? (
                    <View style={styles.form}>
                      <View style={[styles.nameRow, rowDir(isRTL)]}>
                        <TextInput
                          style={[styles.nameInput, textDir(isRTL)]}
                          value={firstName}
                          onChangeText={setFirstName}
                          placeholder={t("personAdd.firstName.placeholder")}
                          placeholderTextColor={colors.textMuted}
                          accessibilityLabel={t("personEdit.firstName.label")}
                          autoCorrect={false}
                          autoCapitalize="words"
                          maxLength={40}
                        />
                        <TextInput
                          style={[styles.nameInput, textDir(isRTL)]}
                          value={lastName}
                          onChangeText={setLastName}
                          placeholder={t("personAdd.lastName.placeholder")}
                          placeholderTextColor={colors.textMuted}
                          accessibilityLabel={t("personEdit.lastName.label")}
                          autoCorrect={false}
                          autoCapitalize="words"
                          maxLength={40}
                        />
                      </View>
                      {/* Physical-LTR phone row, like person/new: Western
                          digits are entered left to right in both languages.
                          The dial code is shown, not picked: createPerson is
                          reached through joinTabAsContact, which normalizes
                          against the install's default country. A contact
                          abroad is typed with their own +prefix, which
                          lib/phone.ts honours over the default. */}
                      <View style={styles.phoneRow}>
                        <View style={styles.countryBadge}>
                          <Text style={styles.countryFlag}>{country.flag}</Text>
                          <Text style={styles.countryDial}>{ltrIsolate(country.dialCode)}</Text>
                        </View>
                        <TextInput
                          style={[styles.phoneInput, phoneError ? styles.inputError : null]}
                          value={phone}
                          onChangeText={(v) => {
                            setPhoneError(null);
                            setPhone(v);
                          }}
                          placeholder={t("personAdd.phone.placeholderGeneric")}
                          placeholderTextColor={colors.textMuted}
                          accessibilityLabel={t("personEdit.phone.label")}
                          keyboardType="phone-pad"
                        />
                      </View>
                      {phoneError ? (
                        <Text
                          style={[styles.fieldError, textDir(isRTL)]}
                          accessibilityLiveRegion="polite"
                        >
                          {phoneError}
                        </Text>
                      ) : null}
                      <View style={{ height: 12 }} />
                      <Button
                        label={t("tab.join.join")}
                        disabled={firstName.trim().length === 0}
                        onPress={() =>
                          void runJoin(
                            {
                              vaultId,
                              newPerson: {
                                firstName: firstName.trim(),
                                lastName: lastName.trim() || null,
                                phone: phone.trim() || null,
                              },
                            },
                            [firstName.trim(), lastName.trim()].filter(Boolean).join(" "),
                          )
                        }
                      />
                      <View style={{ height: 8 }} />
                      <Button
                        label={t("common.cancel")}
                        variant="secondary"
                        onPress={() => {
                          setCreating(false);
                          setPhoneError(null);
                        }}
                      />
                    </View>
                  ) : (
                    <>
                      <TextInput
                        style={[styles.search, textDir(isRTL)]}
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t("personAdd.title")}
                        placeholderTextColor={colors.textMuted}
                        accessibilityLabel={t("personAdd.title")}
                        autoCorrect={false}
                      />
                      <View style={styles.listCard}>
                        <Pressable
                          onPress={() => {
                            setCreating(true);
                            setPickError(null);
                          }}
                          accessibilityRole="button"
                          style={({ pressed }) => [
                            styles.row,
                            rowDir(isRTL),
                            pressed && styles.rowPressed,
                          ]}
                        >
                          <Text style={[styles.rowName, textDir(isRTL)]}>
                            {t("tab.join.newContact")}
                          </Text>
                          <Ionicons
                            name="add-circle-outline"
                            size={icon.row}
                            color={colors.textMuted}
                          />
                        </Pressable>
                        {contacts === null ? (
                          <View style={styles.centered}>
                            <ActivityIndicator color={colors.textDefault} />
                          </View>
                        ) : (
                          filteredContacts.map((c) => (
                            <View key={c.id}>
                              <View style={styles.divider} />
                              <Pressable
                                // D3: a contact holds at most one open tab, so
                                // an already-linked one is shown (the user is
                                // looking for a name they know) but inert.
                                disabled={c.linked === 1}
                                onPress={() => void runJoin({ vaultId, personId: c.id }, c.name)}
                                accessibilityRole="button"
                                style={({ pressed }) => [
                                  styles.row,
                                  rowDir(isRTL),
                                  pressed && styles.rowPressed,
                                  c.linked === 1 && styles.rowDisabled,
                                ]}
                              >
                                <View style={styles.rowLeft}>
                                  <Text style={[styles.rowName, textDir(isRTL)]} numberOfLines={1}>
                                    {c.name}
                                  </Text>
                                  <Text style={[styles.rowSub, textDir(isRTL)]} numberOfLines={1}>
                                    {c.linked === 1
                                      ? t("tab.join.alreadyLinked")
                                      : (c.phone ?? t("contacts.noPhone"))}
                                  </Text>
                                </View>
                              </Pressable>
                            </View>
                          ))
                        )}
                      </View>
                    </>
                  )}
                </View>
              )}

              {pickError ? (
                <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
                  {pickError}
                </Text>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * Where to send someone who followed a tab link before they have a kaata.
 *
 * pickInitialRoute in app/_layout.tsx makes the same decision at boot, but it
 * needs boot-time state (fonts, the restore gate, the device locale) that this
 * screen has no business re-deriving — and the destination barely matters:
 * pending_tab_token has already been stashed, and onboarding/success reads it
 * whichever step the user resumes at. So this only avoids the ONE rude
 * outcome, restarting a half-finished flow from the language step.
 */
async function onboardingRouteForStash(): Promise<
  "/onboarding" | "/onboarding/auth" | "/onboarding/profile" | "/onboarding/kaata"
> {
  const step = await getAppMeta("onboarding_step").catch(() => null);
  if (step === "kaata") return "/onboarding/kaata";
  if (step === "profile") return "/onboarding/profile";
  if (step === "auth") return "/onboarding/auth";
  // null, "language", or a stale "done" with no self behind it: the index stub
  // redirects to the language step, which is where a fresh install belongs.
  return "/onboarding";
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  scrollContent: { padding: 16, paddingTop: 20, paddingBottom: 32, flexGrow: 1 },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  centered: { alignItems: "center", paddingVertical: 24 },

  heading: {
    fontSize: 20,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    lineHeight: sansLineHeight(20, 28),
    marginBottom: 16,
  },
  body: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    lineHeight: sansLineHeight(14, 21),
  },
  centeredText: { textAlign: "center" },

  // Preview card — balance hero + count, the two numbers that tell a
  // shopkeeper whether this link is the account he thinks it is.
  card: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    backgroundColor: colors.bgMuted,
    padding: 16,
  },
  cardLabel: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    lineHeight: sansLineHeight(11, 15),
  },
  balanceRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 8 },
  // Every fontFamily Text routes its line height through the helpers: Vazirmatn
  // and JetBrains Mono are taller than their nominal size and iOS clips the
  // glyph tops of a box that is only as tall as the font size (lib/fonts.ts).
  balance: { fontSize: 28, fontFamily: fonts.monoBold, lineHeight: monoLineHeight(28, 37) },
  balanceSymbol: {
    fontSize: 14,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(14, 20),
  },
  cardMeta: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 8,
    lineHeight: sansLineHeight(12, 17),
  },

  // Pickers.
  listCard: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: colors.bgDefault,
  },
  divider: { height: 1, backgroundColor: colors.borderDefault },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: TOUCH_MIN,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.bgDefault,
  },
  rowPressed: { backgroundColor: colors.bgMuted },
  rowDisabled: { opacity: 0.5 },
  rowLeft: { flex: 1, minWidth: 0 },
  rowName: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    lineHeight: sansLineHeight(15, 21),
  },
  rowSub: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 2,
    lineHeight: sansLineHeight(12, 17),
  },
  rowTrailing: {
    fontSize: 13,
    fontFamily: fonts.monoMedium,
    color: colors.textMuted,
    lineHeight: monoLineHeight(13, 18),
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    minHeight: TOUCH_MIN,
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  switchText: {
    flex: 1,
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(13, 18),
  },

  search: {
    minHeight: TOUCH_MIN,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
    backgroundColor: colors.bgDefault,
    marginBottom: 12,
  },

  // New-contact form — person/new's fields, minus the phone book.
  form: { marginTop: 4 },
  nameRow: { flexDirection: "row", gap: 10, marginBottom: 10 },
  nameInput: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
    backgroundColor: colors.bgDefault,
  },
  phoneRow: { flexDirection: "row", gap: 8 },
  countryBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    backgroundColor: colors.bgMuted,
  },
  countryFlag: { fontSize: 18 },
  countryDial: {
    fontSize: 14,
    fontFamily: fonts.monoMedium,
    color: colors.textEmphasis,
    lineHeight: monoLineHeight(14, 19),
  },
  phoneInput: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
    backgroundColor: colors.bgDefault,
  },
  inputError: { borderColor: colors.danger, backgroundColor: "rgba(220, 38, 38, 0.04)" },
  fieldError: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 8,
    lineHeight: sansLineHeight(12, 17),
  },
});
