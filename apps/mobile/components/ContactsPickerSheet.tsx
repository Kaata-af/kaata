import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import * as Contacts from "expo-contacts";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Keyboard,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";

// Slide-up sheet for picking a contact from the device's phone book. Asks for
// permission on first open; on grant, lists contacts with names + first phone
// number. Tap a contact → returns its name + first phone to the parent screen,
// which can pre-fill the create-person form. Visual chrome mirrors
// CountryPickerSheet (blur + tint + spring entrance).

const OFFSCREEN = 800;

export type PickedContact = {
  name: string;
  phone: string | null;
};

export function ContactsPickerSheet(props: {
  visible: boolean;
  onPick: (contact: PickedContact) => void;
  onDismiss: () => void;
}) {
  const [rendered, setRendered] = useState(false);
  const [query, setQuery] = useState("");
  const isRTL = useIsRTL();
  const [contacts, setContacts] = useState<Contacts.Contact[] | null>(null);
  const [permission, setPermission] = useState<"unknown" | "granted" | "denied">("unknown");
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(OFFSCREEN)).current;
  // Keyboard height tracked manually. KeyboardAvoidingView wars with this
  // sheet's content-based sizing on Android and produces visible jitter
  // (the sheet shrinks-and-resizes per keyboard animation frame). Adding
  // bottom padding equal to the keyboard height instead just pushes the
  // sheet up smoothly without resizing.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    if (props.visible) {
      setRendered(true);
      setQuery("");
      // Request + load contacts lazily so the prompt only fires when the user
      // actually opens the picker.
      (async () => {
        const { status } = await Contacts.requestPermissionsAsync();
        if (status !== "granted") {
          setPermission("denied");
          return;
        }
        setPermission("granted");
        const { data } = await Contacts.getContactsAsync({
          fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
          // Sort here is best-effort; we re-sort by name client-side anyway.
          sort: Contacts.SortTypes.FirstName,
        });
        // Drop contacts with no usable display name; sort by name asc.
        const usable = data
          .filter((c) => Boolean(c.name && c.name.trim().length > 0))
          .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
        setContacts(usable);
      })();

      requestAnimationFrame(() => {
        Animated.parallel([
          Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            friction: 11,
            tension: 75,
          }),
        ]).start();
      });
    } else if (rendered) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: OFFSCREEN, duration: 180, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setRendered(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  if (!rendered) return null;

  const q = query.trim().toLowerCase();
  const filtered = contacts
    ? q
      ? contacts.filter((c) => (c.name ?? "").toLowerCase().includes(q))
      : contacts
    : [];

  function pick(c: Contacts.Contact) {
    const name = (c.name ?? "").trim();
    const phone = c.phoneNumbers?.[0]?.number?.trim() || null;
    props.onPick({ name, phone });
    props.onDismiss();
  }

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={props.onDismiss}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <BlurView
          intensity={20}
          tint="light"
          experimentalBlurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.tint} />
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onDismiss} />
      </Animated.View>

      <Animated.View
        // bottom = keyboardHeight pushes the bottom-anchored sheet up by
        // exactly the keyboard height, so the sheet always sits flush above
        // the soft keyboard regardless of content size. No KeyboardAvoidingView
        // = no per-frame resize jitter on Android.
        style={[styles.sheetContainer, { bottom: keyboardHeight, transform: [{ translateY }] }]}
        pointerEvents="box-none"
      >
        <SafeAreaView
          // edges={[]} when keyboard is up — the keyboard already accounts for
          // the bottom safe area. With edges={["bottom"]} we'd double-add the
          // nav-bar inset.
          edges={keyboardHeight > 0 ? [] : ["bottom"]}
          // Concrete pixel sizing. maxHeight prevents overflow past status
          // bar; minHeight guarantees the sheet stays tall enough to show
          // the search bar + a usable list area even when filtered results
          // are empty (otherwise it shrinks to ~80px and the empty-state
          // text ends up below the keyboard).
          style={[
            styles.sheetWrap,
            {
              maxHeight: Dimensions.get("window").height * 0.8,
              minHeight: Math.min(360, Dimensions.get("window").height * 0.5),
            },
          ]}
        >
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.grabber} />
            <Text style={[styles.title, textDir(isRTL)]}>{t("contacts.title")}</Text>

            {permission === "denied" ? (
              <View style={styles.permissionBlock}>
                <Text style={styles.permissionTitle}>{t("contacts.permission.title")}</Text>
                <Text style={styles.permissionBody}>{t("contacts.permission.body")}</Text>
                <Pressable
                  onPress={() => Linking.openSettings()}
                  style={({ pressed }) => [styles.permissionBtn, pressed && { opacity: 0.85 }]}
                >
                  <Text style={styles.permissionBtnText}>{t("contacts.permission.button")}</Text>
                </Pressable>
              </View>
            ) : contacts === null ? (
              <View style={styles.centered}>
                <ActivityIndicator color={colors.textDefault} />
              </View>
            ) : (
              <>
                <View style={[styles.searchWrap, rowDir(isRTL)]}>
                  <Ionicons
                    name="search"
                    size={16}
                    color={colors.textMuted}
                    style={[styles.searchIcon, isRTL ? styles.searchIconRTL : styles.searchIconLTR]}
                  />
                  <TextInput
                    style={[styles.searchInput, textDir(isRTL)]}
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t("contacts.search")}
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  style={styles.list}
                  contentContainerStyle={styles.listContent}
                >
                  {filtered.length === 0 ? (
                    <View style={styles.empty}>
                      <Text style={styles.emptyText}>
                        {contacts.length === 0
                          ? t("contacts.empty.none")
                          : t("contacts.empty.noMatch", { query: query.trim() })}
                      </Text>
                    </View>
                  ) : (
                    filtered.map((c, i) => {
                      const phone = c.phoneNumbers?.[0]?.number;
                      return (
                        <Pressable
                          key={`${c.name ?? "contact"}-${i}`}
                          onPress={() => pick(c)}
                          style={({ pressed }) => [
                            styles.row,
                            rowDir(isRTL),
                            pressed && { backgroundColor: colors.bgMuted },
                          ]}
                        >
                          <View style={styles.rowLeft}>
                            <Text style={[styles.rowName, textDir(isRTL)]} numberOfLines={1}>
                              {c.name ?? "—"}
                            </Text>
                            <Text style={[styles.rowSub, textDir(isRTL)]} numberOfLines={1}>
                              {phone ?? t("contacts.noPhone")}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })
                  )}
                </ScrollView>
              </>
            )}
          </View>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  tint: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.08)" },
  sheetContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    // maxHeight moved to the SafeAreaView inline style as a concrete pixel
    // value; percentage maxHeight here was undefined behavior in RN against
    // an absolute-positioned auto-height parent.
  },
  sheetWrap: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  sheet: { paddingTop: 8, paddingBottom: 8, flexShrink: 1 },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderEmphasis,
    marginBottom: 8,
  },
  title: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  centered: { paddingVertical: 32, alignItems: "center" },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    backgroundColor: colors.bgDefault,
    paddingLeft: 12,
  },
  searchIcon: {},
  searchIconLTR: { marginRight: 8 },
  searchIconRTL: { marginLeft: 8 },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    paddingRight: 12,
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
  },
  list: { flexShrink: 1 },
  listContent: { paddingBottom: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  rowLeft: { flex: 1 },
  rowName: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  rowSub: {
    fontSize: 12,
    fontFamily: fonts.monoRegular,
    color: colors.textSubtle,
    marginTop: 2,
  },
  empty: { paddingVertical: 24, paddingHorizontal: 20, alignItems: "center" },
  emptyText: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    textAlign: "center",
  },
  permissionBlock: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 24,
    alignItems: "center",
  },
  permissionTitle: {
    fontSize: 16,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    marginBottom: 8,
    textAlign: "center",
  },
  permissionBody: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    textAlign: "center",
    lineHeight: 19,
    marginBottom: 16,
  },
  permissionBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.bgInverted,
  },
  permissionBtnText: {
    color: colors.textInverted,
    fontFamily: fonts.sansSemi,
    fontSize: 14,
  },
});
