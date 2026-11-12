import { Ionicons } from "@expo/vector-icons";
import { useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { ltrIsolate, rowDir, textDir, trackingSafe, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import type { DiscoveredPerson } from "../lib/people-search";
import { normalize, scoreMatch } from "../lib/search";
import { radius, TOUCH_MIN, typography } from "../lib/tokens";
import { useFriends } from "../lib/use-friends";
import { InitialAvatar } from "./InitialAvatar";

const AVATAR_SIZE = 40;
function FriendAvatar({ person }: { person: DiscoveredPerson }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const uri = person.picture_url;
  const showPhoto = !!uri && /^https:\/\//i.test(uri) && !failed;
  return (
    <View style={styles.avatar}>
      {!showPhoto || !loaded ? (
        <InitialAvatar size={AVATAR_SIZE} label={Array.from(person.name)[0]?.toUpperCase() ?? ""} />
      ) : null}
      {showPhoto ? (
        <Image
          accessible={false}
          source={{ uri }}
          style={styles.photo}
          resizeMode="cover"
          fadeDuration={0}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
    </View>
  );
}

export function HomeFriendsSection(props: {
  query: string;
  enabled?: boolean;
  disabled?: boolean;
  /** Includes server matches for phone numbers and cross-script spellings. */
  directoryMatches?: readonly DiscoveredPerson[];
  onSelect: (person: DiscoveredPerson) => void;
  onScanQr?: () => void;
}) {
  const rtl = useIsRTL();
  const friends = useFriends(props.enabled ?? true);
  const latest = useRef(props);
  latest.current = props;
  const query = normalize(props.query).replace(/^@/, "");
  const byAccount = new Map(
    friends.rows
      .map((person) => ({
        person,
        score: query
          ? Math.max(scoreMatch(query, person.name), scoreMatch(query, person.username ?? ""))
          : 1,
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.person.name.localeCompare(b.person.name))
      .map(({ person }) => [person.account_id, person]),
  );
  const knownFriends = new Map(friends.rows.map((person) => [person.account_id, person]));
  if (query)
    for (const person of props.directoryMatches ?? [])
      if (person.is_friend && !friends.removedAccountIds.has(person.account_id))
        byAccount.set(person.account_id, knownFriends.get(person.account_id) ?? person);
  const people = [...byAccount.values()];
  const available = () => friends.isCurrent() && !latest.current.disabled;
  if (!friends.accountId) return null;
  return (
    <View testID="home-friends-section" style={styles.section}>
      <View style={[styles.header, rowDir(rtl)]}>
        <Text accessibilityRole="header" style={[styles.title, textDir(rtl), trackingSafe(rtl)]}>
          {t("friends.title")}
        </Text>
        {props.onScanQr ? (
          <Pressable
            testID="home-friends-qr"
            accessibilityRole="button"
            accessibilityLabel={t("peopleQr.title")}
            accessibilityState={{ disabled: !!props.disabled }}
            disabled={props.disabled}
            onPress={() => {
              if (available()) latest.current.onScanQr?.();
            }}
            style={({ pressed }) => [styles.qr, pressed && styles.pressed]}
          >
            <Ionicons name="qr-code-outline" size={22} color={colors.textEmphasis} />
          </Pressable>
        ) : null}
      </View>
      {people.length > 0 ? (
        <View style={styles.card}>
          {people.map((person, index) => (
            <Pressable
              key={person.account_id}
              testID={`home-friend-${person.account_id}`}
              accessibilityRole="button"
              accessibilityLabel={`${person.name}, ${t("peopleProfile.view")}`}
              accessibilityState={{ disabled: !!props.disabled }}
              disabled={props.disabled}
              onPress={() => {
                if (available()) latest.current.onSelect(person);
              }}
              style={({ pressed }) => [
                styles.row,
                rowDir(rtl),
                index > 0 && styles.divider,
                pressed && styles.pressed,
              ]}
            >
              <FriendAvatar
                key={`${person.account_id}:${person.picture_url ?? ""}`}
                person={person}
              />
              <View style={styles.identity}>
                <Text style={[styles.name, textDir(rtl)]}>{person.name}</Text>
                <Text style={[styles.subtitle, textDir(rtl)]}>
                  {person.username ? ltrIsolate(`@${person.username}`) : t("peopleSearch.friend")}
                </Text>
              </View>
              <Ionicons
                name={rtl ? "chevron-back" : "chevron-forward"}
                size={18}
                color={colors.textSubtle}
              />
            </Pressable>
          ))}
        </View>
      ) : null}
      {!people.length && !friends.loaded && friends.loading ? (
        <View style={[styles.status, rowDir(rtl)]} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={colors.textSubtle} />
          <Text style={[styles.hint, textDir(rtl)]}>{t("friends.loading")}</Text>
        </View>
      ) : !people.length && friends.offline && !friends.loaded ? (
        <Text style={[styles.hint, styles.empty, textDir(rtl)]}>{t("friends.offline")}</Text>
      ) : !people.length && friends.loaded && !friends.failed ? (
        <Text style={[styles.hint, styles.empty, textDir(rtl)]}>
          {t(query ? "friends.searchEmpty" : "friends.emptyHint")}
        </Text>
      ) : null}
      {friends.failed && !friends.offline ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("friends.failed")}
          disabled={props.disabled}
          onPress={() => {
            if (available()) friends.retry();
          }}
          style={styles.status}
        >
          <Text style={[styles.hint, textDir(rtl)]}>
            {t("friends.failed")} {t("peopleProfile.retry")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 16, marginTop: 12, marginBottom: 8 },
  header: { alignItems: "center", gap: 12, minHeight: TOUCH_MIN },
  title: { ...typography.caption, color: colors.textSubtle, textTransform: "uppercase", flex: 1 },
  qr: {
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: colors.bgDefault,
  },
  row: { alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 64 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderDefault },
  pressed: { backgroundColor: colors.bgMuted },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    overflow: "hidden",
    backgroundColor: colors.bgMuted,
  },
  photo: { position: "absolute", top: 0, left: 0, width: AVATAR_SIZE, height: AVATAR_SIZE },
  identity: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  subtitle: { fontSize: 12, fontFamily: fonts.sansRegular, color: colors.textSubtle, marginTop: 2 },
  hint: { ...typography.bodySm, color: colors.textSubtle, flexShrink: 1 },
  status: { minHeight: TOUCH_MIN, alignItems: "center", gap: 8, paddingVertical: 8 },
  empty: { paddingVertical: 8 },
});
