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
// Two things the screen works out BEFORE it asks anything, both pure functions
// in lib/tabs/join-plan.ts so selftest:tab-join pins them:
//   - planCurrency (D9): which kaatas already use the tab's currency, which
//     could be switched to it right here (switchVaultCurrencyForTab), which are
//     locked (an open tab pins the currency; the role may not change settings).
//     "You need a USD kaata" is never a dead end any more.
//   - suggestJoinContact: the invitation carries the sender's account phone
//     (WireParty.phone), so "who is this in your kaata?" usually has an answer
//     before the list renders — an existing contact with that number, else a
//     phone-book entry, else the invitation's own label + number. With one
//     resolvable kaata the preview joins in ONE tap. The user always taps;
//     nothing here joins on its own.
// The contact list itself is the same merge the home Add/find screen renders
// (lib/contacts-merge.ts): this kaata's people + the device phone book.
//
// Three handoffs this screen owns, all through app_meta.pending_tab_token, with
// pending_tab_currency written and cleared alongside it so the kaata-creating
// screens (vault/new, onboarding/kaata) can preset the tab's currency:
//   1. No local self yet (the link opened a fresh install, or one that is
//      mid-onboarding): stash and send the user into onboarding. The screen
//      that finally lands home — onboarding/success — reads the stash and
//      comes back here.
//   2. No kaata in the tab's currency (D9) and none worth switching: stash and
//      push /vault/new, which routes back here instead of home after the create.
//   3. Arrived with everything in place: clear the stash, so a later
//      onboarding or vault create does not re-open an already-joined link.

import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ScreenLoading } from "../../components/ScreenLoading";
import { ScreenHeader } from "../../components/SettingsScreen";
import { queuePendingToast } from "../../components/Toast";
import { getSessionJWT } from "../../lib/auth";
import { colors } from "../../lib/colors";
import {
  mergeContactSections,
  splitSearchQuery,
  type MergedSection,
} from "../../lib/contacts-merge";
import { splitName, type DeviceContact } from "../../lib/contacts-sync";
import { getCurrencySymbol, applyVaultCurrency } from "../../lib/currency";
import { getAppMeta, getLocalSelf, setAppMeta } from "../../lib/db";
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
import { getCountry, getCurrentDefaultCountryCode, inferCountryFromE164 } from "../../lib/phone";
import {
  getPersonIdForRelationship,
  getTabLink,
  listVaultContactsForJoin,
  type TabJoinCandidate,
} from "../../lib/tabs/db";
import { otherRole } from "../../lib/tabs/direction";
import {
  planCurrency,
  suggestJoinContact,
  type CurrencyPlan,
  type JoinSuggestion,
  type VaultFacts,
} from "../../lib/tabs/join-plan";
import {
  fetchTabPreview,
  joinTabAsContact,
  listVaultFactsForJoin,
  switchVaultCurrencyForTab,
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
import { useDeviceContacts } from "../../lib/use-device-contacts";
import { VaultHasOpenTabError } from "../../lib/vault-router";

type Stage = "loading" | "preview" | "pick" | "joining" | "error";

const PENDING_TOKEN_KEY = "pending_tab_token";
// The tab's currency, stashed WITH the token: vault/new and onboarding/kaata
// preset their currency row from it (D9), so "Create a USD kaata" no longer
// mints an AFN kaata that bounces straight back to the same prompt. Written
// wherever the token is — the tab's currency when known, "" when clearing.
const PENDING_CURRENCY_KEY = "pending_tab_currency";

// presentation:"modal": SafeAreaView must inset all four edges, and the
// pre-content branches have to say so too or the header shifts when the read
// resolves (see app/tab/dispute.tsx).
const MODAL_EDGES = ["top", "bottom", "left", "right"] as const;

type Section = MergedSection<TabJoinCandidate, DeviceContact>;

/** The kaata the pick stage starts on: one match is not a choice; with
 *  several, the one the user is already looking at, if it fits; else ask. The
 *  preview's one-tap join resolves the same way, so both stages agree. */
function preselectVault(plan: CurrencyPlan): VaultFacts | null {
  if (plan.matching.length === 1) return plan.matching[0];
  const active = getActiveVaultIdSyncMaybe();
  return plan.matching.find((v) => v.id === active) ?? null;
}

/** The picker country for a number: its own dial code when it carries one,
 *  else the install default — person/new's rule for a tapped phone-book row.
 *  The string itself is handed to createPerson VERBATIM (lib/phone.ts owns the
 *  parsing; see person/new's onDeviceContactTap for the doubled-code bug). */
function countryCodeFor(phone: string | null | undefined): string {
  const p = (phone ?? "").trim();
  return p.startsWith("+")
    ? inferCountryFromE164(toAsciiDigits(p))
    : getCurrentDefaultCountryCode();
}

/** What joining a suggestion means: the existing contact, or a new person
 *  built from the phone book / the invitation. createPerson also writes a new
 *  person to the phone book best-effort — hence tab.join.suggestWillCreate. */
function targetFor(s: JoinSuggestion, vaultId: string): JoinTarget {
  if (s.source === "kaata") return { vaultId, personId: s.personId };
  return {
    vaultId,
    newPerson: {
      firstName: s.firstName,
      lastName: s.lastName,
      phone: s.phone,
      countryCode: s.countryCode ?? getCurrentDefaultCountryCode(),
    },
  };
}

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

  // Kaata half of the pick stage: every kaata's facts (null = not read yet),
  // which planCurrency sorts into matching / switchable / locked. The ref
  // mirrors the state for the async paths (openPick, a switch) that must not
  // read a stale closure.
  const [facts, setFacts] = useState<VaultFacts[] | null>(null);
  const factsRef = useRef<VaultFacts[] | null>(null);
  const factsInFlight = useRef<Promise<VaultFacts[]> | null>(null);
  const [vaultId, setVaultId] = useState<string | null>(null);
  // The kaata being switched to the tab's currency, while it is. The ref is
  // the synchronous re-entry guard (state cannot stop a same-frame double
  // tap, which appended two identical currency events).
  const [switching, setSwitching] = useState<string | null>(null);
  const switchingRef = useRef(false);
  // A switch that relabels a book with tallies is confirmed first; this is
  // the kaata waiting on that answer.
  const [confirmSwitch, setConfirmSwitch] = useState<VaultFacts | null>(null);
  // Inline confirmation after a switch — a toast cannot show over this modal.
  const [switchedNote, setSwitchedNote] = useState<string | null>(null);
  // "Choose someone else" on the preview: the declined suggestion is not
  // offered again at the top of the list, and the new-contact form prefills
  // only its number, never its name.
  const [declinedSuggestion, setDeclinedSuggestion] = useState(false);
  // Contact half: the target kaata's contacts, tagged with the kaata they
  // belong to so a list read for one kaata never renders under another's.
  const [contacts, setContacts] = useState<{
    vaultId: string;
    rows: TabJoinCandidate[];
  } | null>(null);
  // Bumped after a failed join: a torn join can leave a contact behind that
  // the list has not seen (lib/tabs/link.ts joinFailure keeps it on a timeout).
  const [contactsAttempt, setContactsAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  // Device phone book, read silently from mount so it is ready by the time the
  // user reaches the list (the hook never prompts; only the explicit card in
  // renderContactsAccess may ask for permission, as on person/new).
  const {
    access: contactsAccess,
    busy: contactsBusy,
    failed: contactsFailed,
    requestAccess,
  } = useDeviceContacts();
  const deviceContacts = useMemo(() => contactsAccess?.contacts ?? [], [contactsAccess]);

  // Synchronous re-entry guard: `stage` is state, so two fast taps both reach
  // joinTabAsContact and the second creates a duplicate contact before the
  // first has committed its link (the invite screen's acceptingRef lesson).
  const joiningRef = useRef(false);
  // Bumped by Retry to re-run the preview effect after a transport failure.
  const [attempt, setAttempt] = useState(0);

  const country = getCountry(getCurrentDefaultCountryCode());

  // One read of every kaata's facts at a time. A failed read keeps the answer
  // already on screen (or an empty one) rather than wiping a plan mid-tap.
  const loadFacts = useCallback((): Promise<VaultFacts[]> => {
    if (factsInFlight.current) return factsInFlight.current;
    const run = (async () => {
      try {
        const f = await listVaultFactsForJoin();
        factsRef.current = f;
        setFacts(f);
        return f;
      } catch (err) {
        console.warn("[tab/join] kaata facts failed", err);
        const f = factsRef.current ?? [];
        factsRef.current = f;
        setFacts(f);
        return f;
      } finally {
        factsInFlight.current = null;
      }
    })();
    factsInFlight.current = run;
    return run;
  }, []);

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
          await setAppMeta(PENDING_CURRENCY_KEY, "");
          router.replace("/sign-in");
          return;
        }
        if (!self) {
          await setAppMeta(PENDING_TOKEN_KEY, token);
          // The currency is not known before the preview is fetched;
          // onboarding/kaata fetches it itself from the stashed token.
          await setAppMeta(PENDING_CURRENCY_KEY, "");
          router.replace(await onboardingRouteForStash());
          return;
        }
        // We are past the handoffs: the stash has done its job. Cleared here
        // rather than after the join so an abandoned link cannot re-open
        // itself the next time onboarding or vault/new finishes.
        await setAppMeta(PENDING_TOKEN_KEY, "");
        await setAppMeta(PENDING_CURRENCY_KEY, "");

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
        // Resolve the kaata plan while the preview is on screen, so Join
        // answers at once — and so the one-tap card can appear at all.
        void loadFacts();
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
  }, [token, router, attempt, loadFacts]);

  // ---- derived -----------------------------------------------------------
  const otherLabel = tab ? tab.parties[otherRole(tab.you)].label.trim() : "";
  const otherName = otherLabel || t("tab.them");
  // The sender's account phone, as the server exposes it to the other party
  // (WireParty.phone: "" for an account without one, absent on old servers).
  const otherPhone = tab ? tab.parties[otherRole(tab.you)].phone || null : null;
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

  // D9: every kaata sorted against the tab's currency.
  const plan = useMemo(
    () => (facts && tab ? planCurrency(facts, tab.currency) : null),
    [facts, tab],
  );
  // The preview's would-be kaata — the same preselect the pick stage starts on.
  const previewVault = plan ? preselectVault(plan) : null;
  // Whose contacts to have ready: the picked kaata, or the preview's would-be one.
  const targetVaultId = stage === "pick" ? vaultId : (previewVault?.id ?? null);

  // ---- pick --------------------------------------------------------------
  const openPick = useCallback(async () => {
    if (!tab) return;
    setPickError(null);
    setStage("pick");
    // Usually already read while the preview was on screen; awaited here for
    // a fast tap so a single matching kaata is never shown as a "choice".
    const f = factsRef.current ?? (await loadFacts());
    setVaultId(preselectVault(planCurrency(f, tab.currency))?.id ?? null);
  }, [tab, loadFacts]);

  // Contacts load whenever the target kaata changes (including the preselect).
  useEffect(() => {
    if (!targetVaultId) return;
    let cancelled = false;
    void listVaultContactsForJoin(targetVaultId)
      .then((rows) => {
        if (!cancelled) setContacts({ vaultId: targetVaultId, rows });
      })
      .catch((err) => {
        console.warn("[tab/join] contact list failed", err);
        if (!cancelled) setContacts({ vaultId: targetVaultId, rows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [targetVaultId, contactsAttempt]);
  const contactRows = contacts && contacts.vaultId === targetVaultId ? contacts.rows : null;

  // Who the invitation is from, as far as this device can tell. Needs the
  // target kaata's contacts: an existing contact with the number wins, and a
  // LINKED one with it blocks the suggestion outright (D3, join-plan.ts).
  const suggestion = useMemo(
    () =>
      tab && contactRows
        ? suggestJoinContact({ otherPhone, otherLabel, candidates: contactRows, deviceContacts })
        : null,
    [tab, contactRows, otherPhone, otherLabel, deviceContacts],
  );
  // A suggestion the screen can act on: a number with no label behind it has
  // no name to join as, so it only prefills the new-contact form.
  const joinable = suggestion && suggestion.name.trim().length > 0 ? suggestion : null;

  // One box, routed onto ONE of person/new's two axes by content
  // (splitSearchQuery): a number is a phone query, anything else a name query.
  // Feeding the same text to both matched nobody, because the merge ANDs the
  // filters and no name contains a phone number. Deferred so each keystroke
  // stays responsive over a big phone book.
  const dQuery = useDeferredValue(query);
  const { sections, deviceTruncated } = useMemo(
    () =>
      mergeContactSections<TabJoinCandidate, DeviceContact>({
        people: contactRows ?? [],
        deviceContacts,
        ...splitSearchQuery(dQuery),
      }),
    [contactRows, deviceContacts, dQuery],
  );

  // The stash is armed by goCreateKaata and normally consumed by vault/new;
  // a join that ends any other way (cancel, a switch instead of a create)
  // must disarm it, or a later, unrelated "New kaata" opens preset to this
  // tab's currency and routes into this invitation after the create.
  async function clearPendingStash() {
    try {
      await setAppMeta(PENDING_TOKEN_KEY, "");
      await setAppMeta(PENDING_CURRENCY_KEY, "");
    } catch (err) {
      console.warn("[tab/join] pending stash clear failed", err);
    }
  }

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
      await clearPendingStash();
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
      // Land on the picker for THIS kaata whichever stage the tap came from:
      // the suggestion card and the list are both there to change the answer
      // or retry, and the message renders under them.
      setVaultId(target.vaultId);
      setStage("pick");
      setContactsAttempt((n) => n + 1);
      console.warn("[tab/join] join failed", err);
      // The facts the plan was built from may be what failed: a currency
      // pulled in from another member, a contact created by the torn join.
      // Re-read them so the plan renders the kaata where it now belongs.
      const refreshed = loadFacts();
      if (err instanceof TabCurrencyMismatchError && !err.serverStale) {
        // The kaata no longer matches HERE: leave its contact list, which
        // would repeat this error on every tap, and let the plan re-sort it
        // into switchable/locked (or preselect another matching kaata).
        void refreshed.then((f) => {
          setVaultId(preselectVault(planCurrency(f, tab.currency))?.id ?? null);
        });
      }
      if (err instanceof TabCreatePersonError) {
        // Same wording person/new.tsx uses, on the field that caused it — so
        // the form must be open, holding what was refused, even when the tap
        // came from the suggestion card or a phone-book row.
        if (!("personId" in target)) {
          setFirstName(target.newPerson.firstName);
          setLastName(target.newPerson.lastName ?? "");
          setPhone(target.newPerson.phone ?? "");
          setCreating(true);
        }
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
          err.serverStale
            ? // The kaata already matches here; only the server's copy of its
              // currency is behind (the change has not been pushed yet).
              t("tab.join.currencyNotSynced")
            : // ISO codes are Latin tokens dropped into Dari prose: isolate each
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

  // ---- currency switch (D9, no dead end) ---------------------------------
  async function runSwitch(vault: VaultFacts) {
    if (!tab || switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(vault.id);
    setPickError(null);
    try {
      await switchVaultCurrencyForTab(vault.id, tab.currency);
      // The kaata now matches: say so locally at once (the plan re-sorts it
      // into `matching`, so the contact list renders) and re-read the facts
      // behind it. The vault's events were pushed best-effort by the switch;
      // a server still behind reports as tab.join.currencyNotSynced on join.
      const patched = (factsRef.current ?? []).map((v) =>
        v.id === vault.id ? { ...v, currency: tab.currency } : v,
      );
      factsRef.current = patched;
      setFacts(patched);
      setSwitchedNote(
        t("tab.join.switched", { name: vault.name, currency: bidiIsolate(tab.currency) }),
      );
      setVaultId(vault.id);
      void loadFacts();
    } catch (err) {
      console.warn("[tab/join] currency switch failed", err);
      if (err instanceof VaultHasOpenTabError) {
        setPickError(t("tab.currencyLocked"));
      } else if (err instanceof TabPermissionError) {
        setPickError(t("entry.roleDenied"));
      } else {
        setPickError(t("entry.saveFailed"));
      }
      // Whatever failed, the plan must show the DB's answer, not the one it
      // was built from: a lock that appeared, a role that changed.
      void loadFacts();
    } finally {
      switchingRef.current = false;
      setSwitching(null);
    }
  }

  // A switch that relabels a book with tallies asks first; an empty book is
  // one tap, as the primary button is.
  function requestSwitch(vault: VaultFacts, relabels: boolean) {
    if (relabels) setConfirmSwitch(vault);
    else void runSwitch(vault);
  }

  // Handoff 2: make a kaata in the tab's currency. The stash is re-armed so
  // vault/new comes back here instead of home, and the currency rides along
  // so its picker starts on the right one.
  function goCreateKaata() {
    if (!tab) return;
    void (async () => {
      if (token) {
        await setAppMeta(PENDING_TOKEN_KEY, token);
        await setAppMeta(PENDING_CURRENCY_KEY, tab.currency);
      }
      router.push("/vault/new");
    })();
  }

  // The new-contact form, prefilled from what the invitation told us unless
  // the user already typed here: a phone-book or invitation suggestion carries
  // a name and number; a bare number with no label still fills the phone. A
  // suggestion the user declined ("Choose someone else") lends only its
  // number — they said the name was wrong.
  function openCreateForm() {
    setPickError(null);
    if (!firstName && !lastName && !phone && suggestion && suggestion.source !== "kaata") {
      if (!declinedSuggestion) {
        setFirstName(suggestion.firstName);
        setLastName(suggestion.lastName ?? "");
      }
      setPhone(suggestion.phone ?? "");
    }
    setCreating(true);
  }

  // Tapping a phone contact joins as a NEW person with its name + number, the
  // fastest path from "browse my phone" to "linked" — person/new's tap, with
  // the join in place of the open.
  function onDeviceContactTap(c: DeviceContact) {
    if (!vaultId) return;
    const { firstName: fn, lastName: ln } = c.firstName.trim()
      ? { firstName: c.firstName, lastName: c.lastName }
      : splitName(c.name);
    if (!fn) {
      // A nameless entry (number only): let the user name it.
      setFirstName("");
      setLastName("");
      setPhone(c.phone ?? "");
      setCreating(true);
      return;
    }
    void runJoin(
      {
        vaultId,
        newPerson: {
          firstName: fn,
          lastName: ln,
          phone: c.phone,
          countryCode: countryCodeFor(c.phone),
        },
      },
      c.name,
    );
  }

  // The dial-code badge on the form follows a typed/prefilled "+" number so a
  // suggestion from abroad shows its own flag; the string itself is parsed by
  // lib/phone.ts, which honours the prefix over the picker either way.
  const formCountry = phone.trim().startsWith("+")
    ? getCountry(inferCountryFromE164(toAsciiDigits(phone.trim())))
    : country;

  // ---- render ------------------------------------------------------------
  const title = t("tab.join.title");
  // Cancel disarms the stash (see clearPendingStash) before leaving.
  const onBack = () => {
    void clearPendingStash();
    router.replace("/");
  };

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

  // Who the invitation resolved to — the preview's one-tap card and the pick
  // stage's card share one body; only the framing line differs.
  function renderSuggestionBody(s: JoinSuggestion, label: string) {
    return (
      <>
        <Text style={[styles.cardLabel, textDir(isRTL), trackingSafe(isRTL)]}>{label}</Text>
        <Text style={[styles.suggestName, textDir(isRTL)]} numberOfLines={1}>
          {s.name}
        </Text>
        <Text style={[styles.suggestSub, textDir(isRTL)]} numberOfLines={1}>
          {s.phone ? ltrIsolate(s.phone) : t("contacts.noPhone")}
        </Text>
        {s.source !== "kaata" ? (
          // What joining creates. The phone-book write is promised only when
          // it will happen: an invitation-sourced person, with contacts
          // access granted (createPerson's write is silent without it); a
          // phone-book match is already in the book.
          <Text style={[styles.suggestHint, textDir(isRTL)]}>
            {s.source === "invitation" && contactsAccess?.granted
              ? t("tab.join.suggestWillCreate")
              : t("tab.join.suggestWillAdd")}
          </Text>
        ) : null}
      </>
    );
  }

  function renderSuggestionCard(s: JoinSuggestion, forVaultId: string) {
    const label =
      s.source === "kaata"
        ? t("tab.join.suggestTitle")
        : s.source === "phone"
          ? t("tab.join.suggestFromPhone")
          : t("tab.join.suggestFromInvite");
    return (
      <View style={styles.suggestCard}>
        {renderSuggestionBody(s, label)}
        <View style={{ height: 12 }} />
        <Button
          label={t("tab.join.joinAs", { name: s.name })}
          onPress={() => void runJoin(targetFor(s, forVaultId), s.name)}
        />
      </View>
    );
  }

  // D9 with no matching kaata: switch one, or make one. `primary: "switch"` is
  // the single-empty-kaata case — nothing to relabel, so the switch is the
  // one-tap default; everything else leads with Create and lists each kaata
  // with what a switch would do to it, or why it cannot be switched.
  function renderCurrencyPlan(p: CurrencyPlan) {
    if (!tab || !facts) return null;
    const tabCode = bidiIsolate(tab.currency);
    const active = getActiveVaultIdSyncMaybe();
    const mine = facts.find((v) => v.id === active) ?? facts[0] ?? null;
    const only = p.primary === "switch" ? p.switchable[0].vault : null;
    const nonMatching = facts.filter((v) => v.currency !== tab.currency);
    const switchableById = new Map(p.switchable.map((s) => [s.vault.id, s]));
    const lockedById = new Map(p.locked.map((l) => [l.vault.id, l]));
    return (
      <View>
        <Text style={[styles.body, textDir(isRTL)]}>
          {mine
            ? t("tab.join.currencyIntro", { kaata: bidiIsolate(mine.currency), tab: tabCode })
            : t("tab.join.noCurrencyKaata", { currency: tabCode })}
        </Text>
        <View style={{ height: 20 }} />
        {only ? (
          <>
            <Button
              label={t("tab.join.switchCurrency", { name: only.name, currency: tabCode })}
              onPress={() => void runSwitch(only)}
              loading={switching === only.id}
              disabled={switching !== null}
            />
            <Text style={[styles.hint, styles.centeredText]}>{t("tab.join.switchEmptyHint")}</Text>
            <View style={{ height: 12 }} />
            <Button
              label={t("tab.join.createSeparate", { currency: tabCode })}
              variant="secondary"
              onPress={goCreateKaata}
              disabled={switching !== null}
            />
          </>
        ) : (
          <>
            <Button
              label={t("tab.join.createKaata", { currency: tabCode })}
              onPress={goCreateKaata}
              disabled={switching !== null}
            />
            {nonMatching.length > 0 ? (
              <>
                {/* The heading names the verb and the trailing slot shows
                    the change ("AFN → USD"): under "choose another kaata"
                    with a bare ؋ these rows read as a picker, and one tap
                    relabelled a full book. Rows with tallies confirm first. */}
                <Text style={[styles.sectionLabel, textDir(isRTL), trackingSafe(isRTL)]}>
                  {t("tab.join.orPick", { currency: tabCode })}
                </Text>
                <View style={styles.listCard}>
                  {nonMatching.map((v, index) => {
                    const sw = switchableById.get(v.id);
                    const lk = lockedById.get(v.id);
                    const sub = sw
                      ? sw.relabels
                        ? t("tab.join.switchRelabelHint", { currency: tabCode })
                        : t("tab.join.switchEmptyHint")
                      : lk?.reason === "open_tab"
                        ? t("tab.join.lockedByTab", { currency: bidiIsolate(v.currency) })
                        : t("tab.join.lockedByRole");
                    const inert = !sw || switching !== null;
                    return (
                      <View key={v.id}>
                        {index > 0 ? <View style={styles.divider} /> : null}
                        <Pressable
                          disabled={inert}
                          onPress={() => (sw ? requestSwitch(v, sw.relabels) : undefined)}
                          accessibilityRole="button"
                          accessibilityState={{ disabled: inert }}
                          style={({ pressed }) => [
                            styles.row,
                            rowDir(isRTL),
                            pressed && styles.rowPressed,
                            !sw && styles.rowDisabled,
                          ]}
                        >
                          <View style={styles.rowLeft}>
                            <Text style={[styles.rowName, textDir(isRTL)]} numberOfLines={1}>
                              {v.name}
                            </Text>
                            <Text style={[styles.rowSub, textDir(isRTL)]} numberOfLines={2}>
                              {sub}
                            </Text>
                          </View>
                          {switching === v.id ? (
                            <ActivityIndicator size="small" color={colors.textSubtle} />
                          ) : sw ? (
                            // One LTR run: two Latin codes around an arrow
                            // reorder inside Dari prose unless isolated as
                            // a unit, and the arrow must keep pointing at
                            // the new currency.
                            <Text style={styles.rowTrailing}>
                              {ltrIsolate(`${v.currency} → ${tab.currency}`)}
                            </Text>
                          ) : (
                            <Ionicons
                              name="lock-closed-outline"
                              size={icon.trailing}
                              color={colors.textMuted}
                            />
                          )}
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              </>
            ) : null}
          </>
        )}
      </View>
    );
  }

  // Before the list, never buried below the user's existing kaata contacts —
  // person/new's card, same labels, same three states.
  function renderContactsAccess() {
    if (!contactsAccess || (contactsAccess.granted && !contactsAccess.limited)) return null;
    const label = contactsAccess.limited
      ? t("personAdd.contacts.manage")
      : contactsAccess.canAskAgain
        ? t("personAdd.contacts.allow")
        : t("personAdd.contacts.openSettings");
    return (
      <View style={styles.permCard}>
        <Pressable
          onPress={() => void requestAccess()}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled: contactsBusy }}
          disabled={contactsBusy}
          style={({ pressed }) => [styles.permRow, rowDir(isRTL), pressed && styles.rowPressed]}
        >
          {contactsBusy ? (
            <ActivityIndicator size="small" color={colors.textSubtle} />
          ) : (
            <Ionicons name="people-outline" size={icon.row} color={colors.textSubtle} />
          )}
          <Text style={[styles.permText, textDir(isRTL)]}>{label}</Text>
          <Ionicons
            name={isRTL ? "chevron-back" : "chevron-forward"}
            size={icon.trailing}
            color={colors.textMuted}
          />
        </Pressable>
        {contactsFailed ? (
          <Text style={[styles.permError, textDir(isRTL)]}>{t("personAdd.contacts.failed")}</Text>
        ) : null}
      </View>
    );
  }

  // The kaata's contacts are listed by name, not by recency, so "Recent" would
  // be a lie here; the join screen says where they are instead. The other
  // three titles are person/new's own.
  function sectionTitle(section: Section): string {
    return section.titleKey === "personAdd.section.recent"
      ? t("tab.join.inKaata")
      : t(section.titleKey);
  }

  function renderContactRow(c: TabJoinCandidate, forVaultId: string) {
    return (
      <Pressable
        // D3: a contact holds at most one open tab, so an already-linked one
        // is shown (the user is looking for a name they know) but inert.
        disabled={c.linked === 1}
        onPress={() => void runJoin({ vaultId: forVaultId, personId: c.id }, c.name)}
        accessibilityRole="button"
        accessibilityState={{ disabled: c.linked === 1 }}
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
              : c.phone
                ? ltrIsolate(c.phone)
                : t("contacts.noPhone")}
          </Text>
        </View>
      </Pressable>
    );
  }

  function renderDeviceRow(c: DeviceContact) {
    return (
      <Pressable
        onPress={() => onDeviceContactTap(c)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.row, rowDir(isRTL), pressed && styles.rowPressed]}
      >
        <View style={styles.rowLeft}>
          <Text style={[styles.rowName, textDir(isRTL)]} numberOfLines={1}>
            {c.name}
          </Text>
          <Text style={[styles.rowSub, textDir(isRTL)]} numberOfLines={1}>
            {c.phone ? ltrIsolate(c.phone) : t("contacts.noPhone")}
          </Text>
        </View>
        <Ionicons name="add-circle-outline" size={icon.row} color={colors.textMuted} />
      </Pressable>
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
              {previewVault && joinable && plan ? (
                // One tap: the kaata is unambiguous and the invitation's
                // number resolved to someone. Everything else stays one tap
                // away behind "Choose someone else" — nothing joins on its own.
                <>
                  <View style={styles.suggestCard}>
                    {renderSuggestionBody(joinable, t("tab.join.linkTo"))}
                    {facts && facts.length > 1 ? (
                      // Which kaata, when there is more than one to wonder about.
                      <View style={[styles.suggestMeta, rowDir(isRTL)]}>
                        <Ionicons
                          name="book-outline"
                          size={icon.trailing}
                          color={colors.textMuted}
                        />
                        <Text style={[styles.suggestMetaText, textDir(isRTL)]} numberOfLines={1}>
                          {previewVault.name}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <View style={{ height: 16 }} />
                  <Button
                    label={t("tab.join.joinAs", { name: joinable.name })}
                    onPress={() =>
                      void runJoin(targetFor(joinable, previewVault.id), joinable.name)
                    }
                  />
                  <Pressable
                    onPress={() => {
                      setDeclinedSuggestion(true);
                      void openPick();
                    }}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.chooseElse, pressed && { opacity: 0.6 }]}
                  >
                    <Text style={styles.chooseElseText}>{t("tab.join.chooseElse")}</Text>
                  </Pressable>
                </>
              ) : (
                <Button label={t("tab.join.join")} onPress={() => void openPick()} />
              )}
            </View>
          ) : null}

          {stage === "pick" && tab ? (
            <View>
              {facts === null || plan === null ? (
                <View style={styles.fillCenter}>
                  <ActivityIndicator color={colors.textDefault} />
                </View>
              ) : plan.matching.length === 0 ? (
                renderCurrencyPlan(plan)
              ) : vaultId === null ? (
                <View>
                  <Text style={[styles.heading, textDir(isRTL)]}>{t("tab.join.pickKaata")}</Text>
                  <View style={styles.listCard}>
                    {plan.matching.map((v, index) => (
                      <View key={v.id}>
                        {index > 0 ? <View style={styles.divider} /> : null}
                        <Pressable
                          onPress={() => {
                            // Another kaata is another list: the declined
                            // suggestion may be right for this one.
                            setDeclinedSuggestion(false);
                            setVaultId(v.id);
                          }}
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
                  {switchedNote ? (
                    <Text style={[styles.switchedNote, textDir(isRTL)]}>{switchedNote}</Text>
                  ) : null}

                  {/* Switch kaata again — only offered when there was a real
                      choice to begin with. */}
                  {plan.matching.length > 1 ? (
                    <Pressable
                      onPress={() => {
                        setVaultId(null);
                        setPickError(null);
                      }}
                      style={({ pressed }) => [styles.switchRow, pressed && styles.rowPressed]}
                    >
                      <Text style={[styles.switchText, textDir(isRTL)]}>
                        {plan.matching.find((v) => v.id === vaultId)?.name ?? ""}
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
                          against the badge's country. A contact abroad is
                          typed (or prefilled) with their own +prefix, which
                          lib/phone.ts honours over it. */}
                      <View style={styles.phoneRow}>
                        <View style={styles.countryBadge}>
                          <Text style={styles.countryFlag}>{formCountry.flag}</Text>
                          <Text style={styles.countryDial}>{ltrIsolate(formCountry.dialCode)}</Text>
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
                                countryCode: formCountry.code,
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
                      {joinable && !declinedSuggestion
                        ? renderSuggestionCard(joinable, vaultId)
                        : null}
                      <TextInput
                        style={[styles.search, textDir(isRTL)]}
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t("tab.join.searchContacts")}
                        placeholderTextColor={colors.textMuted}
                        accessibilityLabel={t("tab.join.searchContacts")}
                        autoCorrect={false}
                      />
                      {renderContactsAccess()}
                      <View style={styles.listCard}>
                        <Pressable
                          onPress={openCreateForm}
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
                      </View>
                      {contactRows === null ? (
                        <View style={styles.centered}>
                          <ActivityIndicator color={colors.textDefault} />
                        </View>
                      ) : sections.length === 0 ? (
                        dQuery.trim() ? (
                          <Text style={[styles.noMatchText, textDir(isRTL)]}>
                            {t("personAdd.noMatch", { query: dQuery.trim() })}
                          </Text>
                        ) : null
                      ) : (
                        // Each section is its OWN bordered card, like person/new
                        // and the home people list: one container per section
                        // avoids the Android per-row asymmetric-border bug.
                        sections.map((section) => (
                          <View key={section.key} style={styles.section}>
                            <Text
                              style={[styles.sectionLabel, textDir(isRTL), trackingSafe(isRTL)]}
                            >
                              {sectionTitle(section)}
                            </Text>
                            <View style={styles.listCard}>
                              {section.data.map((item, index) => (
                                <View
                                  key={
                                    item.kind === "app"
                                      ? `app-${item.person.id}`
                                      : `dev-${item.contact.id}`
                                  }
                                >
                                  {index > 0 ? <View style={styles.divider} /> : null}
                                  {item.kind === "app"
                                    ? renderContactRow(item.person, vaultId)
                                    : renderDeviceRow(item.contact)}
                                </View>
                              ))}
                            </View>
                            {section.key === "device" && deviceTruncated ? (
                              <Text style={[styles.moreHint, textDir(isRTL)]}>
                                {t("personAdd.moreContacts")}
                              </Text>
                            ) : null}
                          </View>
                        ))
                      )}
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

      {/* Relabel confirmation: switching a kaata WITH tallies shows every
          existing amount in the new currency unconverted, and the join that
          follows pins that currency behind the open tab — not a one-tap act. */}
      <ConfirmDialog
        visible={confirmSwitch !== null}
        title={
          confirmSwitch && tab
            ? t("tab.join.switchConfirmTitle", {
                name: confirmSwitch.name,
                currency: bidiIsolate(tab.currency),
              })
            : ""
        }
        description={
          tab ? t("tab.join.switchRelabelHint", { currency: bidiIsolate(tab.currency) }) : ""
        }
        confirmLabel={
          confirmSwitch && tab
            ? t("tab.join.switchCurrency", {
                name: confirmSwitch.name,
                currency: bidiIsolate(tab.currency),
              })
            : ""
        }
        onConfirm={() => {
          const v = confirmSwitch;
          setConfirmSwitch(null);
          if (v) void runSwitch(v);
        }}
        onCancel={() => setConfirmSwitch(null)}
      />
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
  hint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 8,
    lineHeight: sansLineHeight(12, 17),
  },
  // "{kaata} now uses USD" under the pick heading after a switch — the one
  // confirmation the modal can give, since a toast cannot render over it.
  switchedNote: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    marginTop: -8,
    marginBottom: 12,
    lineHeight: sansLineHeight(13, 18),
  },

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

  // Suggestion card — who the invitation's number resolved to. Plain
  // background (the balance card above it is the tinted one) so the two
  // never read as one block.
  suggestCard: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    backgroundColor: colors.bgDefault,
    padding: 16,
    marginBottom: 12,
  },
  suggestName: {
    fontSize: 17,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    marginTop: 6,
    lineHeight: sansLineHeight(17, 24),
  },
  suggestSub: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 2,
    lineHeight: sansLineHeight(13, 18),
  },
  suggestHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textMuted,
    marginTop: 6,
    lineHeight: sansLineHeight(12, 17),
  },
  suggestMeta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  suggestMetaText: {
    flex: 1,
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.textMuted,
    lineHeight: sansLineHeight(12, 17),
  },
  chooseElse: {
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  chooseElseText: {
    fontSize: 14,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(14, 20),
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

  // Merged contacts list — person/new's section cards, inside this screen's
  // 16px scroll gutter (so no marginHorizontal on the cards here).
  section: { marginTop: 4 },
  sectionLabel: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    lineHeight: sansLineHeight(11, 15),
    paddingTop: 16,
    paddingBottom: 6,
  },
  moreHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    paddingTop: 8,
    lineHeight: sansLineHeight(12, 17),
  },
  noMatchText: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    paddingVertical: 16,
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

  // Phone-book permission card (person/new's, same three states).
  permCard: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    marginBottom: 12,
    overflow: "hidden",
  },
  permRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  permText: {
    flex: 1,
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(13, 18),
  },
  permError: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.danger,
    paddingHorizontal: 16,
    paddingBottom: 12,
    lineHeight: sansLineHeight(13, 18),
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
