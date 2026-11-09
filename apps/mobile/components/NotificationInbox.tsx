import { ProtectedModal as Modal } from "./ProtectedModal";
import type { ViewInstance } from "react-native";
import { SheetBackdrop, useSheetMotionPreference } from "./SheetBackdrop";
import { Ionicons } from "@expo/vector-icons";
import { useRef, useState, useEffect } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import { ltrIsolate, rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts, monoLineHeight } from "../lib/fonts";
import { formatRelative } from "../lib/format";
import { t } from "../lib/i18n";
import { icon, radius, TOUCH_MIN, typography } from "../lib/tokens";
import { useInbox } from "../lib/tabs/use-inbox";
import { openTabNotification } from "../lib/tabs/open-notification";
import type { InboxItem } from "../lib/tabs/api";
import { useToast } from "./Toast";
import { useCustomerReminders } from "../lib/use-customer-reminders";
import { usePeopleRequests } from "../lib/use-people-requests";
import type { PeopleRequest } from "../lib/people-connections";
import { useVaultMemberRequests } from "../lib/use-vault-member-requests";
import type { VaultMemberRequest } from "../lib/vault-member-requests";
import { prepareVaultMemberInviteAcceptance } from "../lib/vault-member-invite-intent";
import { useFriendRequests } from "../lib/use-friend-requests";
import type { FriendRequest } from "../lib/friends-api";
import { Button } from "./Button";

type Inbox = ReturnType<typeof useInbox>;

function openPeopleRequest(item: PeopleRequest, intent?: "accept") {
  router.push({
    pathname: "/t/[token]",
    params: { token: item.token, ...(intent ? { intent } : {}) },
  });
}

async function openVaultMemberRequest(
  item: VaultMemberRequest,
  isCurrent: () => boolean,
  intent?: "accept",
) {
  if (!isCurrent()) return;
  const acceptance =
    intent === "accept" ? await prepareVaultMemberInviteAcceptance(item.token, isCurrent) : null;
  if (!isCurrent()) return;
  router.push({
    pathname: "/invite/[token]",
    params: { token: item.token, ...(acceptance ? { acceptance } : {}) },
  });
}

function renderRequestCard({
  key,
  rtl,
  body,
  subtitle,
  hint,
  acceptLabel,
  rejectLabel,
  disabled,
  loading,
  onOpen,
  onAccept,
  onReject,
}: {
  key: string;
  rtl: boolean;
  body: string;
  subtitle?: string;
  hint: string;
  acceptLabel: string;
  rejectLabel: string;
  disabled: boolean;
  loading?: "accept" | "decline";
  onOpen: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <View key={key} style={styles.notice}>
      {/* The card body and the two action buttons are separate tap targets. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={body}
        accessibilityHint={hint}
        disabled={disabled}
        style={({ pressed }) => [
          StyleSheet.absoluteFill,
          pressed && { backgroundColor: colors.bgSubtle },
        ]}
        onPress={onOpen}
      />
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.requestText, styles.requestHeader, rowDir(rtl)]}
      >
        <View style={styles.text}>
          <Text style={[styles.body, textDir(rtl)]}>{body}</Text>
          {subtitle ? <Text style={[styles.time, textDir(rtl)]}>{subtitle}</Text> : null}
        </View>
        <Ionicons
          name={rtl ? "chevron-back" : "chevron-forward"}
          size={icon.row}
          color={colors.textSubtle}
        />
      </View>
      <View pointerEvents="box-none" style={[styles.requestActions, rowDir(rtl)]}>
        <Button
          label={t("tab.accept")}
          accessibilityLabel={acceptLabel}
          wrapLabel
          disabled={disabled}
          loading={loading === "accept"}
          onPress={onAccept}
        />
        <Button
          label={t("tab.reject")}
          accessibilityLabel={rejectLabel}
          variant="secondary"
          wrapLabel
          disabled={disabled}
          loading={loading === "decline"}
          onPress={onReject}
        />
      </View>
    </View>
  );
}

async function openInboxNotice(inbox: Inbox, item: InboxItem) {
  if (item.kind === "friend_accepted") {
    if (!inbox.isCurrent() || !item.actor_account_id) return;
    router.push({
      pathname: "/people/[accountId]",
      params: { accountId: item.actor_account_id },
    });
  } else if (item.kind !== "vault_invite_rejected") {
    // The tally route also marks this id for the OS tray. The inbox read
    // below is idempotent and refreshes the page.
    await openTabNotification(item.tab_id, item.entry_id, {
      notificationId: item.id,
      rev: item.rev,
    });
  }
  await inbox.read(item.id);
}

function NoticeRow({ item, onPress }: { item: InboxItem; onPress: () => void }) {
  const rtl = useIsRTL();
  const glyph =
    item.kind === "friend_accepted"
      ? "people-outline"
      : item.kind === "entry_accepted" || item.kind === "entry_removal_approved"
        ? "checkmark-outline"
        : item.kind === "vault_invite_rejected" ||
            item.kind === "entry_rejected" ||
            item.kind === "entry_voided" ||
            item.kind === "entry_removal_declined"
          ? "close-outline"
          : "receipt-outline";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={(!item.read ? t("inbox.unread") + ". " : "") + item.body}
      onPress={onPress}
      style={({ pressed }) => [
        styles.notice,
        rowDir(rtl),
        !item.read && styles.unread,
        pressed && { opacity: 0.6 },
      ]}
    >
      <View style={styles.noticeIcon}>
        <Ionicons name={glyph} size={icon.row} color={colors.textSubtle} />
      </View>
      <View style={styles.text}>
        <Text style={[styles.body, textDir(rtl)]}>{item.body}</Text>
        <Text style={[styles.time, textDir(rtl)]}>{formatRelative(item.created_at_ms)}</Text>
      </View>
      {!item.read ? <View style={styles.dot} /> : null}
    </Pressable>
  );
}

function InboxContent({
  inbox,
  compact,
  open,
  openReminders,
  dueReminders,
  hasReminders,
  requests,
  openRequest,
  memberRequests,
  openMemberRequest,
  friendRequests,
  openFriendRequest,
}: {
  inbox: Inbox;
  compact?: boolean;
  open: (item: InboxItem) => void;
  openReminders?: () => void;
  /** A count kept loaded by the caller; without it the row loads its own. */
  dueReminders?: number;
  /** Any reminder at all: the row is then the way into the full list. */
  hasReminders?: boolean;
  requests: ReturnType<typeof usePeopleRequests>;
  openRequest: (item: PeopleRequest, intent?: "accept") => void;
  memberRequests: ReturnType<typeof useVaultMemberRequests>;
  openMemberRequest: (item: VaultMemberRequest, intent?: "accept") => void | Promise<void>;
  friendRequests: ReturnType<typeof useFriendRequests>;
  openFriendRequest: (item: FriendRequest) => void;
}) {
  const rtl = useIsRTL();
  const toast = useToast();
  const [marking, setMarking] = useState(false);
  const [declining, setDeclining] = useState<string | null>(null);
  const decliningRef = useRef(false);
  const [acceptingMember, setAcceptingMember] = useState<string | null>(null);
  const openingMemberRef = useRef(false);
  const { page, loading, failed, signedIn } = inbox;
  const toReminders = openReminders ?? (() => router.push("/reminders"));
  return (
    <>
      {dueReminders === undefined ? (
        <DueRemindersShortcut active onPress={toReminders} />
      ) : (
        <DueRemindersRow count={dueReminders} any={hasReminders} onPress={toReminders} />
      )}
      {compact || page.unread > 0 ? (
        <View style={[styles.heading, rowDir(rtl), !compact && { justifyContent: "flex-end" }]}>
          {compact ? <Text style={[styles.title, textDir(rtl)]}>{t("inbox.title")}</Text> : null}
          {page.unread > 0 ? (
            <Pressable
              accessibilityRole="button"
              disabled={marking}
              style={styles.control}
              onPress={() => {
                setMarking(true);
                void inbox
                  .read()
                  .catch(() => toast.push(t("inbox.failed"), "error"))
                  .finally(() => setMarking(false));
              }}
            >
              <Text style={styles.controlText}>{t("inbox.markAll")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {failed ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => void inbox.reload()}
          style={styles.message}
        >
          <Text style={[styles.time, textDir(rtl)]}>
            {t("inbox.failed")} {t("inbox.retry")}
          </Text>
        </Pressable>
      ) : null}
      <ScrollView showsVerticalScrollIndicator={!compact} contentContainerStyle={styles.content}>
        {friendRequests.failed ? (
          <Pressable
            accessibilityRole="button"
            style={styles.message}
            onPress={() => void friendRequests.reload()}
          >
            <Text style={[styles.time, textDir(rtl)]}>{t("friends.requestsFailed")}</Text>
          </Pressable>
        ) : null}
        {friendRequests.rows.length > 0 ? (
          <Text style={[styles.title, textDir(rtl), { padding: 16 }]}>
            {t("friends.requestsTitle")}
          </Text>
        ) : null}
        {(compact ? friendRequests.rows.slice(0, 3) : friendRequests.rows).map((item) => {
          const name = item.from.name || item.from.username || t("inviteAccept.confirm.someone");
          const body = t("friends.requestBody", { name });
          const responding = friendRequests.responding;
          const respond = (action: "accept" | "decline") => {
            void friendRequests[action](item.id).catch(() => {
              if (friendRequests.isCurrent()) toast.push(t("inbox.failed"), "error");
            });
          };
          return renderRequestCard({
            key: `friend-${item.id}`,
            rtl,
            body,
            subtitle: item.from.username ? ltrIsolate(`@${item.from.username}`) : undefined,
            hint: t("peopleProfile.view"),
            acceptLabel: `${t("peopleProfile.accept")} · ${name}`,
            rejectLabel: `${t("tab.reject")} · ${name}`,
            disabled: responding != null,
            loading: responding?.id === item.id ? responding.action : undefined,
            onOpen: () => {
              if (friendRequests.isRequestCurrent(item.id)) openFriendRequest(item);
            },
            onAccept: () => respond("accept"),
            onReject: () => respond("decline"),
          });
        })}
        {memberRequests.failed ? (
          <Pressable
            accessibilityRole="button"
            style={styles.message}
            onPress={() => void memberRequests.reload()}
          >
            <Text style={[styles.time, textDir(rtl)]}>{t("invite.people.requestsFailed")}</Text>
          </Pressable>
        ) : null}
        {memberRequests.rows.length > 0 ? (
          <Text style={[styles.title, textDir(rtl), { padding: 16 }]}>
            {t("invite.people.requestsTitle")}
          </Text>
        ) : null}
        {(compact ? memberRequests.rows.slice(0, 3) : memberRequests.rows).map((item) => {
          const key = `member-${item.id}`;
          const canAct = () =>
            !decliningRef.current &&
            !openingMemberRef.current &&
            memberRequests.isRequestCurrent(item.id);
          const open = (intent?: "accept") => {
            if (!canAct()) return;
            openingMemberRef.current = true;
            if (intent) setAcceptingMember(key);
            void Promise.resolve(openMemberRequest(item, intent))
              .catch(() => {
                if (memberRequests.isCurrent()) toast.push(t("inbox.failed"), "error");
              })
              .finally(() => {
                openingMemberRef.current = false;
                if (intent) setAcceptingMember(null);
              });
          };
          return renderRequestCard({
            key,
            rtl,
            body: t("invite.people.requestBody", {
              name: item.inviter_name || t("inviteAccept.confirm.someone"),
              kaata: item.vault_name,
              role: t(`invite.role.${item.role}`),
            }),
            hint: t("peopleSearch.review"),
            acceptLabel: `${t("inviteAccept.confirm.accept")} · ${item.vault_name}`,
            rejectLabel: `${t("tab.reject")} · ${item.vault_name}`,
            disabled: declining !== null || acceptingMember !== null,
            loading: declining === key ? "decline" : acceptingMember === key ? "accept" : undefined,
            onOpen: () => open(),
            onAccept: () => open("accept"),
            onReject: () => {
              if (!canAct()) return;
              decliningRef.current = true;
              setDeclining(key);
              void memberRequests
                .decline(item.id)
                .catch(() => {
                  if (memberRequests.isCurrent()) toast.push(t("inbox.failed"), "error");
                })
                .finally(() => {
                  decliningRef.current = false;
                  setDeclining(null);
                });
            },
          });
        })}
        {requests.failed ? (
          <Pressable
            accessibilityRole="button"
            style={styles.message}
            onPress={() => void requests.reload()}
          >
            <Text style={[styles.time, textDir(rtl)]}>{t("peopleSearch.requestsFailed")}</Text>
          </Pressable>
        ) : null}
        {requests.rows.length > 0 ? (
          <Text style={[styles.title, textDir(rtl), { padding: 16 }]}>
            {t("peopleSearch.requestsTitle")}
          </Text>
        ) : null}
        {(compact ? requests.rows.slice(0, 3) : requests.rows).map((item) => {
          const key = `shared-${item.id}`;
          const body = t("peopleSearch.requestBody", {
            name: item.from.name || item.from.username || "Kaata",
          });
          const open = (intent?: "accept") => {
            if (!decliningRef.current) openRequest(item, intent);
          };
          return (
            <View key={key} style={styles.notice}>
              {/* The card's tap target sits behind the separate action buttons. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={body}
                accessibilityHint={t("peopleSearch.review")}
                disabled={declining !== null}
                style={({ pressed }) => [
                  StyleSheet.absoluteFill,
                  pressed && { backgroundColor: colors.bgSubtle },
                ]}
                onPress={() => open()}
              />
              <View
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={styles.requestText}
              >
                <Text style={[styles.body, textDir(rtl)]}>{body}</Text>
                {item.from.username ? (
                  <Text style={[styles.time, textDir(rtl)]}>
                    {ltrIsolate(`@${item.from.username}`)}
                  </Text>
                ) : null}
              </View>
              <View pointerEvents="box-none" style={[styles.requestActions, rowDir(rtl)]}>
                <Button
                  label={t("tab.accept")}
                  wrapLabel
                  disabled={declining !== null}
                  onPress={() => open("accept")}
                />
                <Button
                  label={t("tab.reject")}
                  variant="secondary"
                  wrapLabel
                  disabled={declining !== null}
                  loading={declining === key}
                  onPress={() => {
                    if (decliningRef.current || !requests.isCurrent()) return;
                    decliningRef.current = true;
                    setDeclining(key);
                    void requests
                      .decline(item.id)
                      .catch(() => {
                        if (requests.isCurrent()) toast.push(t("inbox.failed"), "error");
                      })
                      .finally(() => {
                        decliningRef.current = false;
                        setDeclining(null);
                      });
                  }}
                />
              </View>
            </View>
          );
        })}
        {page.items.length === 0 &&
        requests.rows.length === 0 &&
        memberRequests.rows.length === 0 &&
        friendRequests.rows.length === 0 ? (
          <View style={styles.empty}>
            {loading ? (
              <ActivityIndicator color={colors.textSubtle} />
            ) : (
              <>
                <Ionicons name="notifications-outline" size={32} color={colors.textMuted} />
                <Text style={[styles.body, styles.emptyText]}>
                  {t(!signedIn ? "inbox.signIn" : failed ? "inbox.unavailable" : "inbox.empty")}
                </Text>
              </>
            )}
          </View>
        ) : (
          (compact ? page.items.slice(0, 5) : page.items).map((item) => (
            <NoticeRow key={item.id} item={item} onPress={() => open(item)} />
          ))
        )}
        {!compact && page.next_before ? (
          <Pressable
            accessibilityRole="button"
            style={styles.more}
            disabled={loading}
            onPress={() => void inbox.reload(page.next_before)}
          >
            {loading ? (
              <ActivityIndicator color={colors.textSubtle} />
            ) : (
              <Text style={styles.controlText}>{t("common.more")}</Text>
            )}
          </Pressable>
        ) : null}
      </ScrollView>
    </>
  );
}

export function DueRemindersShortcut({
  active,
  onPress,
}: {
  active: boolean;
  onPress: () => void;
}) {
  const { due } = useCustomerReminders(undefined, undefined, active);
  // Called, not mounted: always called, so its hook order never changes.
  return DueRemindersRow({ count: due.length, onPress });
}

/** The "Reminders due" row from a count its owner keeps loaded. The bell's
 * dropdown passes its own count: a row that loaded only while the dropdown was
 * open popped in after opening and vanished as the close fade began, which
 * made the panel jump. */
// With reminders but none due it reads "Reminders": the list of every
// reminder had no way in except a due one or a customer's page (audit #25).
function DueRemindersRow({
  count,
  any = false,
  onPress,
}: {
  count: number;
  any?: boolean;
  onPress: () => void;
}) {
  const rtl = useIsRTL();
  if (!count && !any) return null;
  const label = count ? t("reminders.dueShortcut", { count }) : t("reminders.title");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.reminders, rowDir(rtl)]}
    >
      <Ionicons name="alarm-outline" size={icon.row} color={colors.textSubtle} />
      <Text style={[styles.body, textDir(rtl), { flex: 1 }]}>{label}</Text>
      <Ionicons
        name={rtl ? "chevron-back" : "chevron-forward"}
        size={16}
        color={colors.textMuted}
      />
    </Pressable>
  );
}

export function NotificationBell({
  onOpen,
  onVisibilityChange,
}: {
  onOpen?: () => void;
  onVisibilityChange?: (visible: boolean) => void;
} = {}) {
  const inbox = useInbox();
  const requests = usePeopleRequests();
  const memberRequests = useVaultMemberRequests();
  const friendRequests = useFriendRequests();
  // Due reminders count on the bell too: they used to be invisible until the
  // dropdown was opened. Loaded here, not by the dropdown, so the row stays
  // put through opening and closing.
  const reminders = useCustomerReminders(undefined, undefined, true);
  const dueReminders = reminders.due.length;
  const hasReminders = reminders.rows.length > 0;
  const noticeCount =
    inbox.page.unread +
    requests.rows.length +
    memberRequests.rows.length +
    friendRequests.rows.length;
  const badge = noticeCount + dueReminders;
  const toast = useToast();
  const anchor = useRef<ViewInstance>(null);
  const [position, setPosition] = useState<{ y: number } | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    onVisibilityChange?.(visible);
  }, [visible, onVisibilityChange]);
  const [closing, setClosing] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const phase = useRef<"closed" | "measuring" | "open" | "closing">("closed");
  const generation = useRef(0);
  const mounted = useRef(true);
  const motionPreference = useSheetMotionPreference();
  const reducedMotion = useRef(motionPreference);
  reducedMotion.current = motionPreference;
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Fill the safe viewport, not the bell\'s horizontal position (especially iPhone).
  const sideInset = Math.max(12, insets.left + 12, insets.right + 12);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishClose = useRef<(() => void) | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      animation.current?.stop();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [opacity]);
  useEffect(() => {
    if (!motionPreference) return;
    animation.current?.stop();
    opacity.setValue(phase.current === "open" ? 1 : 0);
    if (phase.current === "closing") finishClose.current?.();
  }, [motionPreference, opacity]);
  const close = (after?: () => void) => {
    // Keep the measured placement even after visible=false: the native Modal
    // can paint its last content frame while dismissing. Clearing it used to
    // teleport the panel to insets.top and flash there before disappearing.
    if (phase.current === "closing") return;
    if (after && phase.current !== "open") return;
    const request = ++generation.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    animation.current?.stop();
    if (phase.current !== "open") {
      phase.current = "closed";
      opacity.setValue(0);
      setVisible(false);
      setClosing(false);
      return;
    }
    phase.current = "closing";
    setClosing(true);
    const finish = () => {
      if (!mounted.current || request !== generation.current || phase.current !== "closing") return;
      phase.current = "closed";
      opacity.setValue(0);
      setVisible(false);
      setClosing(false);
      finishClose.current = null;
      if (after) {
        // Let the native portal disappear before opening another route. A
        // reopened bell or unmount cancels this deferred navigation.
        timer.current = setTimeout(() => {
          timer.current = null;
          if (mounted.current && request === generation.current && phase.current === "closed")
            after();
        }, 250);
      }
    };
    finishClose.current = finish;
    if (reducedMotion.current) finish();
    else {
      animation.current = Animated.timing(opacity, {
        toValue: 0,
        duration: 120,
        useNativeDriver: true,
      });
      animation.current.start(({ finished }) => {
        if (finished) finish();
      });
    }
  };
  const open = (item: InboxItem) => {
    const handle = () => {
      void openInboxNotice(inbox, item).catch(() => toast.push(t("inbox.openFailed"), "error"));
    };
    if (item.kind === "vault_invite_rejected") handle();
    else close(handle);
  };
  return (
    <>
      <View ref={anchor} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            t("inbox.bell", { count: noticeCount }) +
            (dueReminders ? `. ${t("reminders.dueShortcut", { count: dueReminders })}` : "")
          }
          accessibilityState={{ expanded: visible && !closing }}
          style={styles.bell}
          onPress={() => {
            onOpen?.();
            const request = ++generation.current;
            phase.current = "measuring";
            finishClose.current = null;
            animation.current?.stop();
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            void inbox.reload();
            void requests.reload();
            void memberRequests.reload();
            void friendRequests.reload();
            anchor.current?.measureInWindow((_x, y, _w, h) => {
              if (
                !mounted.current ||
                request !== generation.current ||
                phase.current !== "measuring"
              )
                return;
              setPosition({
                y: Math.max(insets.top, Math.min(y + h + 6, height - insets.bottom - 180)),
              });
              phase.current = "open";
              setClosing(false);
              setVisible(true);
              opacity.setValue(reducedMotion.current ? 1 : 0);
              if (!reducedMotion.current) {
                animation.current = Animated.timing(opacity, {
                  toValue: 1,
                  duration: 140,
                  useNativeDriver: true,
                });
                animation.current.start();
              }
            });
          }}
        >
          <Ionicons name="notifications-outline" size={icon.row} color={colors.textEmphasis} />
          {badge > 0 ? (
            <View style={styles.count}>
              <Text style={styles.countText} numberOfLines={1} allowFontScaling={false}>
                {badge > 99 ? "99+" : badge}
              </Text>
            </View>
          ) : null}
        </Pressable>
      </View>
      <Modal
        transparent
        visible={visible}
        animationType="none"
        // Match the host's Android window through the final dismissal frame.
        // A software-rendered dialog with different system-bar insets jumps
        // when its fading blur hands the screen back to the main activity.
        hardwareAccelerated
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => close()}
      >
        <Animated.View
          style={[styles.overlay, { opacity }]}
          pointerEvents={closing ? "none" : "auto"}
        >
          <SheetBackdrop onDismiss={() => close()} />
          <View
            accessibilityViewIsModal
            style={[
              styles.popup,
              {
                left: sideInset,
                right: sideInset,
                top: position?.y ?? insets.top,
                maxHeight: Math.max(
                  180,
                  Math.min(height * 0.65, height - (position?.y ?? 0) - insets.bottom - 16),
                ),
              },
            ]}
          >
            <InboxContent
              inbox={inbox}
              requests={requests}
              memberRequests={memberRequests}
              friendRequests={friendRequests}
              openFriendRequest={(item) =>
                close(() => {
                  if (friendRequests.isRequestCurrent(item.id))
                    router.push({
                      pathname: "/people/[accountId]",
                      params: { accountId: item.from.account_id },
                    });
                })
              }
              openMemberRequest={(item, intent) =>
                close(() => {
                  const opening = generation.current;
                  const current = () =>
                    mounted.current &&
                    opening === generation.current &&
                    memberRequests.isRequestCurrent(item.id);
                  void openVaultMemberRequest(item, current, intent).catch(() => {
                    if (current()) toast.push(t("inbox.failed"), "error");
                  });
                })
              }
              openRequest={(item, intent) =>
                close(() => {
                  if (requests.isCurrent()) openPeopleRequest(item, intent);
                })
              }
              compact
              open={open}
              dueReminders={dueReminders}
              hasReminders={hasReminders}
              openReminders={() =>
                close(() =>
                  router.push(
                    dueReminders > 0
                      ? "/reminders"
                      : { pathname: "/reminders", params: { view: "all" } },
                  ),
                )
              }
            />
            <Pressable
              accessibilityRole="button"
              style={styles.more}
              onPress={() => close(() => router.push("/notifications"))}
            >
              <Text style={styles.controlText}>{t("inbox.seeAll")}</Text>
            </Pressable>
          </View>
        </Animated.View>
      </Modal>
    </>
  );
}

export function FullNotificationInbox() {
  const inbox = useInbox();
  const requests = usePeopleRequests();
  const memberRequests = useVaultMemberRequests();
  const friendRequests = useFriendRequests();
  const toast = useToast();
  const busy = useRef(false);
  const open = (item: InboxItem) => {
    if (busy.current) return;
    busy.current = true;
    void openInboxNotice(inbox, item)
      .catch(() => toast.push(t("inbox.openFailed"), "error"))
      .finally(() => {
        busy.current = false;
      });
  };
  return (
    <InboxContent
      inbox={inbox}
      open={open}
      requests={requests}
      memberRequests={memberRequests}
      friendRequests={friendRequests}
      openFriendRequest={(item) => {
        if (friendRequests.isRequestCurrent(item.id))
          router.push({
            pathname: "/people/[accountId]",
            params: { accountId: item.from.account_id },
          });
      }}
      openMemberRequest={(item, intent) =>
        openVaultMemberRequest(item, () => memberRequests.isRequestCurrent(item.id), intent)
      }
      openRequest={(item, intent) => {
        if (requests.isCurrent()) openPeopleRequest(item, intent);
      }}
    />
  );
}

// The unread badge. Its digits are centred by arithmetic, not by eye: the
// text's line box is EXACTLY the circle's inner height (the size minus the two
// borders), so neither platform has slack to distribute unevenly. Mono digits
// on purpose — JetBrains Mono's natural height at 10px is ceil(10 × 1.32) = 14,
// under the 15 the box asks for, so monoLineHeight(10, 15) is 15 on iOS as
// well as Android. The previous caption style (Vazirmatn 11px, sansLineHeight
// 15) floored to 18 on iOS — taller than the circle — and on Android kept the
// font's Persian-ascender headroom above the glyphs, so the number sat low and
// to one side. includeFontPadding:false removes that headroom; textAlign and
// textAlignVertical centre the run inside the box. selftest:bell-badge pins
// every number here against the real lib/fonts.ts on both platforms.
const BADGE_SIZE = 17;
const BADGE_BORDER = 1;
const BADGE_INNER = BADGE_SIZE - 2 * BADGE_BORDER;

const styles = StyleSheet.create({
  reminders: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  bell: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
  },
  count: {
    position: "absolute",
    right: 1,
    top: 0,
    minWidth: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    // "99+" is three 6px mono glyphs: 18 + 4 + 4 keeps it a pill on ONE line
    // (numberOfLines={1}, no tracking); a single digit stays a full circle
    // because minWidth wins.
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.sharedAccount,
    borderWidth: BADGE_BORDER,
    borderColor: colors.bgDefault,
  },
  countText: {
    fontFamily: fonts.monoSemi,
    fontSize: 10,
    lineHeight: monoLineHeight(10, BADGE_INNER),
    color: colors.textInverted,
    textAlign: "center",
    textAlignVertical: "center",
    includeFontPadding: false,
  },
  overlay: { flex: 1 },
  popup: {
    position: "absolute",
    borderRadius: radius.lg,
    backgroundColor: colors.bgDefault,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    overflow: "hidden",
    elevation: 8,
    boxShadow: "0 8px 28px rgba(0,0,0,0.12)",
  },
  heading: {
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    minHeight: 56,
    gap: 8,
  },
  title: { ...typography.title, color: colors.textEmphasis, flexShrink: 1 },
  control: { minHeight: TOUCH_MIN, justifyContent: "center" },
  controlText: { ...typography.hint, color: colors.textEmphasis },
  content: { paddingBottom: 8 },
  notice: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
    alignItems: "flex-start",
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  noticeIcon: { paddingTop: 2 },
  requestText: { alignSelf: "stretch" },
  requestHeader: { alignItems: "center", gap: 8 },
  requestActions: { alignSelf: "stretch", flexWrap: "wrap", gap: 8 },
  text: { flex: 1, minWidth: 0 },
  body: { ...typography.bodySm, color: colors.textDefault },
  time: { ...typography.caption, color: colors.textSubtle, marginTop: 5 },
  unread: { backgroundColor: colors.bgMuted },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.sharedAccount,
    marginTop: 7,
  },
  message: { paddingHorizontal: 16, paddingBottom: 12 },
  empty: { alignItems: "center", padding: 24, gap: 12 },
  emptyText: { textAlign: "center" },
  more: {
    minHeight: 48,
    padding: 12,
    alignItems: "center",
    justifyContent: "center",
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
});
