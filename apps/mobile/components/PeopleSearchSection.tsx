import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { ltrIsolate, rowDir, textDir, trackingSafe, useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { type DiscoveredPerson, usePeopleSearch } from "../lib/people-search";
import { discoveredPersonId } from "../lib/people-connections";
import { radius, TOUCH_MIN, typography } from "../lib/tokens";
import { InitialAvatar } from "./InitialAvatar";

const AVATAR_SIZE = 36;

function SearchAvatar({ name, pictureUrl }: { name: string; pictureUrl?: string }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");
  const initials = (
    <InitialAvatar label={Array.from(name)[0]?.toUpperCase() ?? ""} size={AVATAR_SIZE} />
  );
  if (!pictureUrl || status === "failed") return initials;
  return (
    <View style={styles.avatar}>
      {status === "loading" ? initials : null}
      <Image
        accessible={false}
        source={{ uri: pictureUrl }}
        style={styles.photo}
        resizeMode="cover"
        fadeDuration={0}
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("failed")}
      />
    </View>
  );
}

/** Continues the existing results list; it has no separate search field or navigation. */
export function PeopleSearchSection(props: {
  search: ReturnType<typeof usePeopleSearch>;
  onSelect: (person: DiscoveredPerson) => void;
  disabled?: boolean;
  /** Different callers may invite an account without creating a contact. */
  actionLabel?: string;
  opensProfile?: boolean;
  localPeople: readonly { id: string }[];
  visiblePeople: readonly { id: string }[];
}) {
  const rtl = useIsRTL();
  const { search } = props;
  if (!search.visible) return null;
  const localIds = new Set(props.localPeople.map((person) => person.id));
  const visibleIds = new Set(props.visiblePeople.map((person) => person.id));
  const existingId = (person: DiscoveredPerson) => {
    const id =
      search.existingPersonIds[person.account_id] ??
      (search.vaultId ? discoveredPersonId(search.vaultId, person.account_id) : "");
    return localIds.has(id) ? id : null;
  };
  const people = search.people.filter((person) => !visibleIds.has(existingId(person) ?? ""));
  if (
    !search.loading &&
    !search.error &&
    search.people.length > 0 &&
    people.length === 0 &&
    !search.hasMore
  )
    return null;
  return (
    <View testID="people-search-section" style={styles.section}>
      <Text style={[styles.title, textDir(rtl), trackingSafe(rtl)]}>{t("peopleSearch.title")}</Text>
      {search.loading ? (
        <View style={[styles.status, rowDir(rtl)]} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={colors.textSubtle} />
          <Text style={[styles.hint, textDir(rtl)]}>{t("peopleSearch.loading")}</Text>
        </View>
      ) : search.error ? (
        <Pressable
          onPress={search.retry}
          accessibilityRole="button"
          accessibilityLabel={t("peopleSearch.failed")}
          style={styles.status}
        >
          <Text style={[styles.hint, textDir(rtl)]}>{t("peopleSearch.failed")}</Text>
        </Pressable>
      ) : people.length === 0 ? (
        <Text style={[styles.empty, textDir(rtl)]}>{t("peopleSearch.empty")}</Text>
      ) : (
        <View style={styles.card}>
          {people.map((person, index) => (
            <Pressable
              key={person.account_id}
              onPress={() => props.onSelect(person)}
              disabled={props.disabled}
              accessibilityRole="button"
              accessibilityLabel={[
                person.name,
                person.username ? `@${person.username}` : null,
                person.is_friend ? t("peopleSearch.friend") : null,
                props.actionLabel ?? t(existingId(person) ? "peopleSearch.existing" : "peopleSearch.add"),
              ]
                .filter(Boolean)
                .join(", ")}
              accessibilityState={{ disabled: props.disabled }}
              style={({ pressed }) => [
                styles.row,
                rowDir(rtl),
                index > 0 && styles.divider,
                pressed && styles.pressed,
              ]}
            >
              <SearchAvatar
                key={person.picture_url}
                name={person.name}
                pictureUrl={person.picture_url}
              />
              <View style={styles.identity}>
                <Text style={[styles.name, textDir(rtl)]} numberOfLines={1}>
                  {person.name}
                </Text>
                {person.username || person.is_friend ? (
                  <View style={[styles.subtitle, rowDir(rtl)]}>
                    {person.username ? (
                      <Text style={[styles.hint, textDir(rtl)]} numberOfLines={1}>
                        {ltrIsolate(`@${person.username}`)}
                      </Text>
                    ) : null}
                    {person.is_friend ? (
                      <Text style={[styles.friend, textDir(rtl)]}>{t("peopleSearch.friend")}</Text>
                    ) : null}
                  </View>
                ) : null}
                {existingId(person) ? (
                  <Text style={[styles.hint, textDir(rtl)]}>{t("peopleSearch.existing")}</Text>
                ) : null}
              </View>
              <Ionicons
                name={
                  props.opensProfile || existingId(person)
                    ? rtl
                      ? "chevron-back"
                      : "chevron-forward"
                    : "person-add-outline"
                }
                size={20}
                color={colors.textSubtle}
              />
            </Pressable>
          ))}
        </View>
      )}
      {!search.loading && !search.error && search.hasMore ? (
        <Text style={[styles.empty, textDir(rtl)]}>{t("peopleSearch.more")}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 12, marginBottom: 8, paddingHorizontal: 16 },
  title: {
    ...typography.caption,
    color: colors.textSubtle,
    textTransform: "uppercase",
    paddingVertical: 8,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: colors.bgDefault,
  },
  row: { minHeight: TOUCH_MIN, alignItems: "center", gap: 12, padding: 12 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderDefault },
  pressed: { backgroundColor: colors.bgMuted },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: colors.bgMuted,
    overflow: "hidden",
  },
  photo: { position: "absolute", top: 0, left: 0, width: AVATAR_SIZE, height: AVATAR_SIZE },
  identity: { flex: 1, minWidth: 0 },
  name: { ...typography.labelBold, color: colors.textEmphasis },
  subtitle: { alignItems: "center", flexWrap: "wrap", gap: 6 },
  hint: { ...typography.bodySm, color: colors.textSubtle, flexShrink: 1 },
  friend: {
    ...typography.bodySm,
    color: colors.textDefault,
    backgroundColor: colors.bgMuted,
    borderRadius: radius.pill,
    overflow: "hidden",
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  status: { minHeight: TOUCH_MIN, alignItems: "center", gap: 8, paddingVertical: 8 },
  empty: { ...typography.bodySm, color: colors.textSubtle, paddingVertical: 8 },
});
