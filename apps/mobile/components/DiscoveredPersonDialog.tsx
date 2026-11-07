import { useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  applyForCurrentSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "../lib/auth";
import { getLocalSelf, listAllPeopleForSearch } from "../lib/db";
import { getAccountIdSync, getActiveVaultIdSyncMaybe, getDb } from "../lib/db-tx";
import {
  discoveredPersonId,
  getDiscoveredPersonIds,
  prepareDiscoveredContact,
} from "../lib/people-connections";
import type { DiscoveredPerson } from "../lib/people-search";
import { t } from "../lib/i18n";
import { LinkAccountDialog } from "./LinkAccountDialog";
import { colors } from "../lib/colors";
import { textDir, useIsRTL } from "../lib/direction";
import { typography, TOUCH_MIN, radius } from "../lib/tokens";
import { searchPeople } from "../lib/search";
import type { PersonWithBalance } from "../lib/types";
import { getTabGroupLinkForPerson } from "../lib/tabs/db";
import type { TabLink } from "../lib/tabs/types";
import { getPersonProfile } from "../lib/friends-api";
import { TabApiError } from "../lib/tabs/errors";

export function DiscoveredPersonDialog(props: {
  person: DiscoveredPerson | null;
  onDismiss: () => void;
  onAdded: (personId: string) => void;
  /** Optional profile flow: retain its session and stay on the profile after sending. */
  expectedSession?: SessionSnapshot;
  expectedVaultId?: string;
  isCurrent?: () => boolean;
  onDelivered?: (personId: string) => void;
  onUnavailable?: () => void;
}) {
  const router = useRouter();
  const vaultId = props.expectedVaultId ?? getActiveVaultIdSyncMaybe();
  const accountId = getAccountIdSync();
  const rtl = useIsRTL();
  const [contacts, setContacts] = useState<PersonWithBalance[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [query, setQuery] = useState("");
  const prepared = useRef<string | null>(null);
  const [source, setSource] = useState<{
    session: SessionSnapshot;
    vaultId: string;
    targetId: string;
    label: string;
    link: TabLink | null;
    linkedPersonId?: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const current = () =>
      active &&
      (props.isCurrent?.() ?? true) &&
      getAccountIdSync() === accountId &&
      getActiveVaultIdSyncMaybe() === vaultId;
    setSource(null);
    setSelected(null);
    setChoosing(false);
    setQuery("");
    prepared.current = null;
    if (props.person && vaultId && accountId && current()) {
      const targetId = props.person.account_id;
      const relationshipId = props.person.existing_relationship_id;
      const resolveExisting = async () =>
        relationshipId
          ? (
              await (
                await getDb()
              ).getFirstAsync<{ user_b_id: string }>(
                "SELECT user_b_id FROM relationships WHERE id=? AND vault_id=? AND archived_at IS NULL",
                relationshipId,
                vaultId,
              )
            )?.user_b_id
          : undefined;
      void Promise.all([
        props.expectedSession
          ? applyForCurrentSession(props.expectedSession, async () => props.expectedSession!)
          : captureCurrentSession(),
        getLocalSelf(),
        listAllPeopleForSearch(vaultId, undefined, { allCurrencies: true }),
        getDiscoveredPersonIds(vaultId),
        resolveExisting(),
      ])
        .then(async ([session, self, people, identities, serverPersonId]) => {
          if (props.expectedSession) await applyForCurrentSession(session, async () => {});
          if (
            current() &&
            session.accountId === accountId &&
            getActiveVaultIdSyncMaybe() === vaultId
          ) {
            const existingId =
              serverPersonId || identities[targetId] || discoveredPersonId(vaultId, targetId);
            const existing = people.find((person) => person.id === existingId);
            const link = existing ? await getTabGroupLinkForPerson(existing.id) : null;
            if (props.expectedSession) await applyForCurrentSession(session, async () => {});
            if (
              !current() ||
              getAccountIdSync() !== accountId ||
              getActiveVaultIdSyncMaybe() !== vaultId
            )
              return;
            if (
              existing?.tab_id &&
              existing.tab_closed_at == null &&
              existing.tab_other_joined === 1
            ) {
              props.onDismiss();
              props.onAdded(existing.id);
              return;
            }
            setContacts(
              people.filter(
                (person) =>
                  (!person.tab_id || person.tab_closed_at != null || person.id === existingId) &&
                  !Object.entries(identities).some(
                    ([account, id]) => account !== targetId && id === person.id,
                  ),
              ),
            );
            setSelected(existing?.id ?? null);
            setSource({
              session,
              vaultId,
              targetId,
              label: self?.shop_name || self?.name || "Kaata",
              link,
              linkedPersonId: existing?.id,
            });
          }
        })
        .catch(() => {
          if (current()) {
            props.onUnavailable?.();
            props.onDismiss();
          }
        });
    }
    return () => {
      active = false;
    };
  }, [props.person?.account_id, vaultId, accountId, props.expectedSession?.bindingVersion]);
  const person = props.person;
  if (
    !person ||
    !source ||
    !(props.isCurrent?.() ?? true) ||
    source.targetId !== person.account_id ||
    source.vaultId !== vaultId ||
    source.session.accountId !== accountId
  )
    return null;
  const id = selected || discoveredPersonId(vaultId!, person.account_id);
  const choiceStyle = {
    minHeight: TOUCH_MIN,
    justifyContent: "center" as const,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
  };
  return (
    <LinkAccountDialog
      visible
      person={{ id, name: person.name || person.username || "Kaata", phone: null }}
      myLabel={source.label}
      link={selected === source.linkedPersonId ? source.link : null}
      recipientAccountId={person.account_id}
      recipientUsername={person.username}
      expectedSession={props.expectedSession}
      isCurrent={props.isCurrent}
      preparePerson={async () => {
        if (!(props.isCurrent?.() ?? true)) throw new SessionChangedError();
        if (props.expectedSession) {
          const check = () => {
            if (!(props.isCurrent?.() ?? true) || getActiveVaultIdSyncMaybe() !== source.vaultId)
              throw new SessionChangedError();
          };
          const profile = await getPersonProfile(
            person.account_id,
            source.session,
            source.vaultId,
            check,
          );
          check();
          if (profile.can_receive_requests !== true)
            throw new TabApiError(
              404,
              "recipient_unavailable",
              "This person cannot receive a new request",
            );
        }
        const result = await prepareDiscoveredContact(
          person,
          source.session,
          source.vaultId,
          selected,
        );
        prepared.current = result;
        return result;
      }}
      contactChoice={(busy) =>
        contacts.length > 0 ? (
          <View style={{ marginTop: 16, gap: 8 }}>
            <Text style={[typography.hint, { color: colors.textSubtle }, textDir(rtl)]}>
              {t("peopleSearch.contactHint")}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={choiceStyle}
              onPress={() => setChoosing(!choosing)}
            >
              <Text style={[typography.bodySm, { color: colors.textEmphasis }, textDir(rtl)]}>
                {t("peopleSearch.saveAs")}:{" "}
                {contacts.find((item) => item.id === selected)?.name ||
                  t("peopleSearch.newContact")}
              </Text>
            </Pressable>
            {choosing ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  style={choiceStyle}
                  onPress={() => {
                    setSelected(null);
                    setChoosing(false);
                  }}
                >
                  <Text style={[typography.bodySm, { color: colors.textEmphasis }, textDir(rtl)]}>
                    {t("peopleSearch.newContact")}
                  </Text>
                </Pressable>
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  editable={!busy}
                  placeholder={t("peopleSearch.chooseContact")}
                  accessibilityLabel={t("peopleSearch.chooseContact")}
                  style={[
                    choiceStyle,
                    typography.bodySm,
                    { color: colors.textEmphasis },
                    textDir(rtl),
                  ]}
                />
                {searchPeople(query, contacts)
                  .slice(0, 8)
                  .map((contact) => (
                    <Pressable
                      key={contact.id}
                      accessibilityRole="button"
                      disabled={busy}
                      style={choiceStyle}
                      onPress={() => {
                        setSelected(contact.id);
                        setChoosing(false);
                      }}
                    >
                      <Text
                        style={[typography.bodySm, { color: colors.textEmphasis }, textDir(rtl)]}
                      >
                        {contact.name}
                      </Text>
                    </Pressable>
                  ))}
              </>
            ) : null}
          </View>
        ) : null
      }
      onLinked={() => {}}
      onDelivered={() => {
        if (!(props.isCurrent?.() ?? true)) return;
        props.onDismiss();
        if (props.onDelivered) props.onDelivered(prepared.current || id);
        else props.onAdded(prepared.current || id);
      }}
      onDismiss={props.onDismiss}
      onAuthRequired={() => router.push("/account")}
    />
  );
}
