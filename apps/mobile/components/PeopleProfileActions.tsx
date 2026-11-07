import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Text, View } from "react-native";
import { applyForCurrentSession, SessionChangedError, type SessionSnapshot } from "../lib/auth";
import { getActiveVaultIdSyncMaybe, getDb } from "../lib/db-tx";
import { getPersonProfile, type PersonProfile } from "../lib/friends-api";
import { getDiscoveredPersonIds, discoveredPersonId } from "../lib/people-connections";
import type { DiscoveredPerson } from "../lib/people-search";
import { useActiveVaultWriteCaps, useVaultPermission } from "../lib/use-vault-role";
import { useLedgerRefresh } from "../lib/ledger-events";
import { t } from "../lib/i18n";
import { colors } from "../lib/colors";
import { textDir, useIsRTL } from "../lib/direction";
import { typography } from "../lib/tokens";
import { DiscoveredPersonDialog } from "./DiscoveredPersonDialog";
import { EmptyHint, NavRow, SectionHeader } from "./SettingsScreen";

type Snapshot = {
  scope: string;
  person: DiscoveredPerson;
  activity: PersonProfile["activity"];
  vaultName: string;
  localPersonId?: string;
  canReceiveRequests: boolean;
};

/** Friendship itself never grants access. These actions keep the existing,
 * separate tally and whole-Kaata consent screens and their permission checks. */
export function PeopleProfileActions(props: {
  person: DiscoveredPerson;
  session: SessionSnapshot;
  isCurrent: () => boolean;
  onChanged?: () => void;
  disabled?: boolean;
  onOpenLedger?: (personId: string) => void;
}) {
  const router = useRouter();
  const rtl = useIsRTL();
  const [vaultId, setVaultId] = useState(getActiveVaultIdSyncMaybe);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [dialog, setDialog] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const busy = useRef(false);
  const firstFocus = useRef(true);
  const mounted = useRef(true);
  const generation = useRef(0);
  const latestProps = useRef(props);
  latestProps.current = props;
  const scope = JSON.stringify([
    props.session.accountId,
    props.session.bindingVersion,
    props.person.account_id,
    vaultId,
  ]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const latestVault = useRef(vaultId);
  latestVault.current = vaultId;
  const current = () =>
    mounted.current &&
    latestScope.current === scope &&
    getActiveVaultIdSyncMaybe() === vaultId &&
    latestProps.current.isCurrent() &&
    !latestProps.current.disabled;
  const caps = useActiveVaultWriteCaps(vaultId);
  const canInvite = useVaultPermission(
    vaultId ?? "",
    props.session.accountId,
    "vault.invite_member",
  );
  const permissions = useRef({ share: false, invite: false });
  permissions.current = {
    share: caps.resolved && caps.canCreate && caps.canAmend,
    invite: caps.resolved && canInvite,
  };
  const refresh = useCallback(() => {
    setVaultId(getActiveVaultIdSyncMaybe());
    setRevision((value) => value + 1);
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else refresh();
    }, [refresh]),
  );
  useLedgerRefresh(null, () => {
    // Preparing the explicitly confirmed contact emits ledger changes. Do not
    // tear down its consent dialog halfway through sending the invitation.
    if (!busy.current || getActiveVaultIdSyncMaybe() !== latestVault.current) refresh();
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const run = ++generation.current;
    const valid = () => alive && run === generation.current && current();
    setSnapshot(null);
    setFailed(null);
    setDialog(null);
    setActing(false);
    busy.current = false;
    if (!vaultId || !current()) return;
    void (async () => {
      const check = () => {
        if (!valid()) throw new Error("profile_scope_changed");
      };
      const profile = await getPersonProfile(
        props.person.account_id,
        props.session,
        vaultId,
        check,
      );
      check();
      const db = await getDb();
      const book = await db.getFirstAsync<{ name: string }>(
        "SELECT name FROM vaults WHERE id=? AND archived_at IS NULL",
        vaultId,
      );
      check();
      if (!book) throw new Error("no_active_vault");
      const identities = await getDiscoveredPersonIds(vaultId);
      check();
      const relationshipId =
        profile.person.existing_relationship_id ?? profile.activity?.existing_relationship_id;
      const localId =
        identities[profile.person.account_id] ??
        discoveredPersonId(vaultId, profile.person.account_id);
      const contact = await db.getFirstAsync<{ user_b_id: string }>(
        `SELECT user_b_id FROM relationships WHERE vault_id=? AND archived_at IS NULL
         AND ${relationshipId ? "id" : "user_b_id"}=?`,
        vaultId,
        relationshipId ?? localId,
      );
      await applyForCurrentSession(props.session, async () => {
        if (valid())
          setSnapshot({
            scope,
            person: profile.person,
            activity: profile.activity,
            vaultName: book.name,
            localPersonId: contact?.user_b_id,
            canReceiveRequests: profile.can_receive_requests === true,
          });
      });
    })().catch((error) => {
      if (valid()) {
        setFailed(scope);
        if (error instanceof SessionChangedError) props.onChanged?.();
      }
    });
    return () => {
      alive = false;
    };
  }, [scope, revision, props.disabled]);

  const shown = snapshot?.scope === scope && current() ? snapshot : null;
  const active = shown?.activity?.shared_tally === "active";
  const pending = shown?.activity?.shared_tally === "pending";
  const memberRole = shown?.activity?.kaata_invitation_role;
  const ready = !!shown && !!vaultId && current() && !acting && dialog !== scope;
  const canShare =
    ready &&
    !pending &&
    (active ? !!shown.localPersonId : permissions.current.share && shown.canReceiveRequests);
  const canAddMember =
    ready && !memberRole && permissions.current.invite && shown.canReceiveRequests;

  async function act(kind: "share" | "member") {
    if (
      busy.current ||
      !current() ||
      !shown ||
      !vaultId ||
      (kind === "share" ? !canShare : !canAddMember)
    )
      return;
    const run = generation.current;
    let opened = false;
    busy.current = true;
    setActing(true);
    try {
      await applyForCurrentSession(props.session, async () => {});
      if (
        !current() ||
        generation.current !== run ||
        (kind === "share" ? !active && !permissions.current.share : !permissions.current.invite)
      )
        return;
      if (kind === "member") {
        router.dismissTo({
          pathname: "/vault/invite",
          params: { profileAccountId: props.person.account_id },
        });
      } else if (active && shown.localPersonId) {
        if (props.onOpenLedger) props.onOpenLedger(shown.localPersonId);
        else router.push({ pathname: "/person/[id]", params: { id: shown.localPersonId } });
      } else {
        setDialog(scope);
      }
      opened = true;
    } catch (error) {
      if (current() && generation.current === run) {
        setFailed(scope);
        if (error instanceof SessionChangedError) props.onChanged?.();
      }
    } finally {
      // Keep same-frame navigation/dialog taps serialized until close/refocus.
      if (!opened && generation.current === run) busy.current = false;
      if (mounted.current && generation.current === run) setActing(false);
    }
  }

  return (
    <View>
      <SectionHeader label={t("peopleProfile.actions")} isRTL={rtl} />
      {!vaultId ? <EmptyHint label={t("peopleProfile.noKaata")} isRTL={rtl} /> : null}
      {shown ? (
        <Text
          style={[
            typography.caption,
            textDir(rtl),
            { color: colors.textSubtle, paddingHorizontal: 20 },
          ]}
        >
          {t("peopleProfile.currentKaata", { kaata: shown.vaultName })}
        </Text>
      ) : null}
      {failed === scope ? (
        <NavRow
          icon="refresh-outline"
          label={t("peopleProfile.actionsFailed")}
          onPress={refresh}
          isRTL={rtl}
        />
      ) : null}
      <NavRow
        icon="swap-horizontal-outline"
        label={t(
          pending
            ? "peopleProfile.tallyPending"
            : active
              ? "peopleProfile.openTally"
              : "peopleProfile.shareTally",
        )}
        hint={
          pending
            ? t("peopleProfile.tallyPendingHint")
            : active && !shown?.localPersonId
              ? t("peopleProfile.tallySyncHint")
              : shown && !active && !shown.canReceiveRequests
                ? t("peopleProfile.friendRequired")
                : shown
                  ? t(
                      permissions.current.share || active
                        ? "peopleProfile.shareTallyHint"
                        : "peopleProfile.actionUnavailable",
                      { kaata: shown.vaultName },
                    )
                  : undefined
        }
        onPress={() => void act("share")}
        disabled={!canShare}
        isRTL={rtl}
      />
      <NavRow
        icon="person-add-outline"
        label={t(memberRole ? "peopleProfile.memberPending" : "peopleProfile.inviteMember")}
        hint={
          shown
            ? memberRole
              ? t("peopleProfile.memberPendingHint", {
                  role: t(`invite.role.${memberRole}`),
                  kaata: shown.vaultName,
                })
              : !shown.canReceiveRequests
                ? t("peopleProfile.friendRequired")
                : t(
                    permissions.current.invite
                      ? "peopleProfile.inviteMemberHint"
                      : "peopleProfile.actionUnavailable",
                    { kaata: shown.vaultName },
                  )
            : undefined
        }
        onPress={() => void act("member")}
        disabled={!canAddMember}
        isRTL={rtl}
        isLast
      />
      {dialog === scope && shown && current() ? (
        <DiscoveredPersonDialog
          person={shown.person}
          expectedSession={props.session}
          expectedVaultId={vaultId!}
          isCurrent={() => current() && permissions.current.share}
          onDismiss={() => {
            if (current()) {
              setDialog(null);
              busy.current = false;
            }
          }}
          onUnavailable={() => {
            if (current()) setFailed(scope);
          }}
          onAdded={(id) => {
            if (!current()) return;
            if (props.onOpenLedger) props.onOpenLedger(id);
            else router.push({ pathname: "/person/[id]", params: { id } });
          }}
          onDelivered={() => {
            if (!current()) return;
            setSnapshot({ ...shown, activity: { ...shown.activity, shared_tally: "pending" } });
            props.onChanged?.();
          }}
        />
      ) : null}
    </View>
  );
}
