import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Pressable,
  FlatList,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type FlatListInstance,
  type ScrollViewInstance,
} from "react-native";
import { ProtectedModal } from "./ProtectedModal";
import { SheetBackdrop } from "./SheetBackdrop";
import { SheetHandle } from "./SheetHandle";
import { SheetSurface } from "./SheetSurface";
import { useOverlayAnimation } from "../lib/use-overlay-animation";
import { useSheetDrag } from "../lib/use-sheet-drag";
import type { EntryActor } from "../lib/attribution";
import type {
  PersonNoteDetails,
  PersonNoteHistoryPage,
  PersonNoteRevision,
} from "../lib/person-note";
import { useCalendar } from "../lib/calendar";
import { colors } from "../lib/colors";
import { bidiIsolate, rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { formatTimestamp } from "../lib/format";
import { getLocale, t } from "../lib/i18n";
import { radius, TOUCH_MIN } from "../lib/tokens";

function actorName(actor: EntryActor | null): string {
  if (!actor) return t("entry.by.someone");
  if (actor.isSelf)
    return actor.name?.trim() ? t("entry.by.self", { name: actor.name }) : t("entry.by.you");
  return actor.name?.trim() || t("entry.by.someone");
}

function byline(kind: "added" | "edited", actor: EntryActor | null, at: number) {
  return `${t(kind === "added" ? "customerNote.firstRecordedBy" : "customerNote.updatedBy", { name: bidiIsolate(actorName(actor)) })} · ${formatTimestamp(at)}`;
}

/** Staff-only note. Attribution comes from the same signed revisions as the text. */
export function CustomerNoteCard(props: {
  scopeKey: string;
  details: PersonNoteDetails;
  onEdit?: () => void;
  loadMoreHistory: (cursor: string) => Promise<PersonNoteHistoryPage | null>;
  isCurrent?: () => boolean;
}) {
  const { details } = props;
  const isRTL = useIsRTL();
  useCalendar();
  const { fontScale } = useWindowDimensions();
  const identity = JSON.stringify([props.scopeKey, details.note, details.updated?.eventId]);
  const currentIdentity = useRef(identity);
  const alive = useRef(true);
  const request = useRef(0);
  const inFlight = useRef<number | null>(null);
  if (currentIdentity.current !== identity) {
    currentIdentity.current = identity;
    request.current++;
    inFlight.current = null;
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current++;
      inFlight.current = null;
    };
  }, []);
  const [width, setWidth] = useState(0);
  const measureKey = JSON.stringify([identity, width, fontScale, getLocale()]);
  const currentMeasureKey = useRef(measureKey);
  currentMeasureKey.current = measureKey;
  const [measurement, setMeasurement] = useState<{ key: string; clipped: boolean } | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const clipped = measurement?.key === measureKey && measurement.clipped;
  const expanded = clipped && expandedKey === identity;
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [older, setOlder] = useState<{
    key: string;
    entries: PersonNoteRevision[];
    cursor: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setBusy(false);
    setFailed(false);
  }, [identity]);
  const historyOpen = historyKey === identity;
  const history = older?.key === identity ? older.entries : details.history;
  const cursor = older?.key === identity ? older.cursor : details.historyCursor;
  const current = () =>
    alive.current && currentIdentity.current === identity && (props.isCurrent?.() ?? true);
  const dismiss = () => {
    request.current++;
    inFlight.current = null;
    setHistoryKey(null);
  };
  const loadOlder = async () => {
    if (inFlight.current !== null || busy || !cursor || !current()) return;
    const serial = ++request.current;
    inFlight.current = serial;
    setBusy(true);
    setFailed(false);
    try {
      const page = await props.loadMoreHistory(cursor);
      if (!current() || serial !== request.current || currentIdentity.current !== identity) return;
      if (!page) {
        setFailed(true);
        return;
      }
      const merged = new Map(history.map((revision) => [revision.eventId, revision]));
      for (const revision of page.entries) merged.set(revision.eventId, revision);
      setOlder({ key: identity, entries: [...merged.values()], cursor: page.nextCursor });
    } catch {
      if (current() && serial === request.current && currentIdentity.current === identity)
        setFailed(true);
    } finally {
      if (inFlight.current === serial) inFlight.current = null;
      if (alive.current && serial === request.current && currentIdentity.current === identity)
        setBusy(false);
    }
  };
  const hasHistory = details.history.length > 0;
  return (
    <View testID="customer-note" style={styles.card}>
      <View
        style={[
          styles.header,
          props.onEdit && (isRTL ? styles.headerWithEditRTL : styles.headerWithEditLTR),
        ]}
      >
        <View style={[styles.titleRow, rowDir(isRTL)]}>
          <Ionicons name="document-text-outline" size={16} color={colors.textSubtle} />
          <Text style={[styles.label, textDir(isRTL)]}>{t("customerNote.label")}</Text>
        </View>
      </View>
      {props.onEdit ? (
        <Pressable
          testID="customer-note-edit"
          accessibilityRole="button"
          accessibilityLabel={t("person.sheet.edit")}
          onPress={() => {
            if (current()) props.onEdit?.();
          }}
          style={[styles.edit, isRTL ? styles.editRTL : styles.editLTR]}
        >
          <Ionicons name="create-outline" size={18} color={colors.textSubtle} />
        </Pressable>
      ) : null}
      <View
        testID="customer-note-text-layout"
        onLayout={(event) => {
          const nextWidth = Math.round(event.nativeEvent.layout.width);
          setWidth((before) => (before === nextWidth ? before : nextWidth));
        }}
      >
        <Text
          testID="customer-note-value"
          accessibilityLabel={details.note ?? t("customerNote.cleared")}
          style={[styles.value, textDir(isRTL), !details.note && styles.cleared]}
          numberOfLines={expanded ? undefined : 3}
        >
          {details.note ?? t("customerNote.cleared")}
        </Text>
        {details.note && measurement?.key !== measureKey ? (
          <Text
            key={measureKey}
            testID="customer-note-measure"
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.value, textDir(isRTL), styles.measure]}
            onTextLayout={(event) => {
              if (alive.current && currentMeasureKey.current === measureKey)
                setMeasurement({ key: measureKey, clipped: event.nativeEvent.lines.length > 3 });
            }}
          >
            {details.note}
          </Text>
        ) : null}
      </View>
      {clipped ? (
        <Pressable
          testID="customer-note-disclosure"
          accessibilityRole="button"
          accessibilityLabel={t(expanded ? "customerNote.collapse" : "customerNote.expand")}
          accessibilityState={{ expanded }}
          onPress={() => {
            if (current()) setExpandedKey(expanded ? null : identity);
          }}
          style={[styles.disclosure, { alignSelf: isRTL ? "flex-end" : "flex-start" }]}
        >
          <Text style={styles.link}>{t(expanded ? "common.less" : "common.more")}</Text>
        </Pressable>
      ) : null}
      <View style={[styles.footer, rowDir(isRTL)]}>
        <View testID="customer-note-attribution" style={styles.attribution}>
          {details.author && details.author.eventId !== details.updated?.eventId ? (
            <Text style={[styles.meta, textDir(isRTL)]}>
              {byline("added", details.author.actor, details.author.at)}
            </Text>
          ) : null}
          {details.updated ? (
            <Text style={[styles.meta, textDir(isRTL)]}>
              {byline("edited", details.updated.actor, details.updated.at)}
            </Text>
          ) : null}
          {!details.author && !details.updated ? (
            <Text style={[styles.meta, textDir(isRTL)]}>{t("customerNote.authorUnavailable")}</Text>
          ) : null}
        </View>
        {hasHistory ? (
          <Pressable
            testID="customer-note-history"
            accessibilityRole="button"
            accessibilityLabel={t("customerNote.history")}
            onPress={() => {
              if (!current()) return;
              request.current++;
              inFlight.current = null;
              setBusy(false);
              setFailed(false);
              setHistoryKey(identity);
            }}
            style={styles.historyButton}
          >
            <Text style={styles.link}>{t("customerNote.history")}</Text>
          </Pressable>
        ) : null}
      </View>
      <NoteHistorySheet
        visible={historyOpen}
        onDismiss={dismiss}
        history={history}
        currentEventId={details.updated?.eventId ?? null}
        cursor={cursor}
        busy={busy}
        failed={failed}
        loadOlder={loadOlder}
      />
    </View>
  );
}

function NoteHistorySheet(props: {
  visible: boolean;
  onDismiss: () => void;
  history: PersonNoteRevision[];
  currentEventId: string | null;
  cursor: string | null;
  busy: boolean;
  failed: boolean;
  loadOlder: () => void;
}) {
  const isRTL = useIsRTL();
  const { rendered, opacity, position } = useOverlayAnimation(props.visible, 600);
  const drag = useSheetDrag(props.visible, position, props.onDismiss);
  const setListRef = useCallback(
    (list: FlatListInstance | null) => {
      drag.scrollProps.ref((list?.getNativeScrollRef() ?? null) as ScrollViewInstance | null);
    },
    [drag.scrollProps.ref],
  );
  if (!rendered) return null;
  return (
    <ProtectedModal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={drag.dismiss}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <SheetBackdrop onDismiss={drag.dismiss} />
      </Animated.View>
      <Animated.View
        style={[styles.sheetContainer, { transform: [{ translateY: drag.translateY }] }]}
        pointerEvents={props.visible ? "box-none" : "none"}
      >
        <SheetSurface {...drag.surfacePanHandlers} maxHeightRatio={0.78} style={styles.sheet}>
          <SheetHandle panHandlers={drag.panHandlers} onDismiss={drag.dismiss} />
          <View style={[styles.sheetHeader, rowDir(isRTL)]}>
            <Text accessibilityRole="header" style={[styles.sheetTitle, textDir(isRTL)]}>
              {t("customerNote.historyTitle")}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("common.close")}
              onPress={drag.dismiss}
              style={styles.close}
            >
              <Ionicons name="close" size={20} color={colors.textSubtle} />
            </Pressable>
          </View>
          <FlatList
            {...drag.scrollProps}
            ref={setListRef}
            data={props.history}
            keyExtractor={(revision) => revision.eventId}
            extraData={`${getLocale()}:${props.currentEventId}`}
            initialNumToRender={4}
            maxToRenderPerBatch={4}
            windowSize={5}
            showsVerticalScrollIndicator={false}
            style={styles.historyList}
            contentContainerStyle={styles.historyContent}
            ListHeaderComponent={
              <Text style={[styles.meta, styles.historyIntro, textDir(isRTL)]}>
                {t("customerNote.visibility")}
              </Text>
            }
            ItemSeparatorComponent={() => <View style={styles.historySeparator} />}
            renderItem={({ item: revision }) => (
              <View
                key={revision.eventId}
                testID={`customer-note-revision-${revision.eventId}`}
                style={styles.revision}
              >
                <View style={[styles.revisionHeader, rowDir(isRTL)]}>
                  <Text style={[styles.revisionTitle, textDir(isRTL)]}>
                    {t(revision.note === null ? "customerNote.cleared" : "customerNote.saved")}
                  </Text>
                  {revision.eventId === props.currentEventId ? (
                    <Text style={styles.current}>{t("customerNote.current")}</Text>
                  ) : null}
                </View>
                <Text style={[styles.meta, textDir(isRTL)]}>
                  {t("customerNote.by", { name: bidiIsolate(actorName(revision.actor)) })} ·{" "}
                  {formatTimestamp(revision.at)}
                </Text>
                {revision.note !== null ? (
                  <Text selectable style={[styles.value, textDir(isRTL)]}>
                    {revision.note}
                  </Text>
                ) : null}
              </View>
            )}
            ListFooterComponent={
              <View style={styles.historyFooter}>
                {props.failed ? (
                  <Text
                    testID="customer-note-history-error"
                    accessibilityRole="alert"
                    style={[styles.error, textDir(isRTL)]}
                  >
                    {t("customerNote.historyFailed")}
                  </Text>
                ) : null}
                {props.cursor ? (
                  <Pressable
                    testID="customer-note-history-more"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: props.busy }}
                    disabled={props.busy}
                    onPress={props.loadOlder}
                    style={styles.loadMore}
                  >
                    <Text style={styles.link}>
                      {t(
                        props.busy
                          ? "common.loading"
                          : props.failed
                            ? "common.retry"
                            : "customerNote.olderChanges",
                      )}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            }
          />
        </SheetSurface>
      </Animated.View>
    </ProtectedModal>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    backgroundColor: colors.bgMuted,
    marginTop: 12,
    padding: 12,
  },
  header: { minHeight: 24, justifyContent: "center", marginBottom: 10 },
  headerWithEditLTR: { paddingRight: TOUCH_MIN - 10 },
  headerWithEditRTL: { paddingLeft: TOUCH_MIN - 10 },
  titleRow: { alignItems: "center", gap: 6 },
  label: { flexShrink: 1, fontSize: 12, color: colors.textSubtle, fontFamily: fonts.sansMedium },
  edit: {
    position: "absolute",
    top: 2,
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
  },
  editLTR: { right: 2 },
  editRTL: { left: 2 },
  value: {
    fontSize: 14,
    lineHeight: sansLineHeight(14, 20),
    color: colors.textDefault,
    fontFamily: fonts.sansRegular,
  },
  measure: { position: "absolute", top: 0, left: 0, right: 0, opacity: 0 },
  cleared: { color: colors.textSubtle },
  disclosure: {
    minHeight: TOUCH_MIN,
    justifyContent: "center",
    paddingHorizontal: 4,
    marginHorizontal: -4,
  },
  link: { fontSize: 12, fontFamily: fonts.sansMedium, color: colors.textSubtle },
  footer: { alignItems: "center", gap: 8, marginTop: 6 },
  attribution: { flex: 1, minWidth: 0, gap: 3 },
  meta: {
    fontSize: 11,
    lineHeight: sansLineHeight(11, 16),
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
  },
  historyButton: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 8,
    marginHorizontal: -4,
    justifyContent: "center",
  },
  sheetContainer: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingTop: 8,
  },
  sheetHeader: { alignItems: "center", gap: 8, paddingHorizontal: 20 },
  sheetTitle: { flex: 1, fontSize: 18, color: colors.textDefault, fontFamily: fonts.sansSemi },
  close: { width: TOUCH_MIN, height: TOUCH_MIN, alignItems: "center", justifyContent: "center" },
  historyList: { flexGrow: 0, flexShrink: 1 },
  historyContent: { paddingHorizontal: 20, paddingBottom: 16 },
  historyIntro: { marginBottom: 16 },
  historySeparator: { height: 16 },
  historyFooter: { paddingTop: 16 },
  revision: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
    paddingTop: 16,
    gap: 6,
  },
  revisionHeader: { alignItems: "center", justifyContent: "space-between", gap: 8 },
  revisionTitle: { flex: 1, fontSize: 13, fontFamily: fonts.sansMedium, color: colors.textDefault },
  current: { fontSize: 11, fontFamily: fonts.sansMedium, color: colors.textSubtle },
  loadMore: { minHeight: TOUCH_MIN, alignItems: "center", justifyContent: "center" },
  error: { fontSize: 13, fontFamily: fonts.sansRegular, color: colors.danger },
});
