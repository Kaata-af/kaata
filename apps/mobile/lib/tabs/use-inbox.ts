import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { getAccountIdSync } from "../db-tx";
import { getAppMeta, setAppMeta } from "../db";
import { getLocale } from "../i18n";
import { fetchInbox, markInboxRead, type InboxPage } from "./api";
import { onTabApplied } from "./events";

const empty = (): InboxPage => ({ items: [], unread: 0, latest_id: "0", next_before: "" });

/** Server history survives dismissed pushes, reinstalls and permission denial.
 * The first page is cached per ACCOUNT + locale, never across sign-ins. */
export function useInbox() {
  const [page, setPage] = useState<InboxPage>(empty);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const owner = useRef<string | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const refreshPending = useRef(false);
  const locale = getLocale();
  const account = getAccountIdSync();
  const reload = useCallback(
    async (before = ""): Promise<void> => {
      const who = getAccountIdSync();
      if (owner.current !== who) {
        owner.current = who;
        setPage(empty());
      }
      if (!who) return;
      if (busy.current) {
        if (!before) refreshPending.current = true;
        return;
      }
      const run = generation.current;
      busy.current = true;
      setLoading(true);
      try {
        const next = await fetchInbox(locale, before);
        if (run !== generation.current || who !== getAccountIdSync()) return;
        setPage((old) =>
          before
            ? {
                ...next,
                items: [
                  ...old.items,
                  ...next.items.filter((n) => !old.items.some((o) => o.id === n.id)),
                ],
              }
            : next,
        );
        setFailed(false);
        if (!before)
          await setAppMeta("notification_inbox:" + who + ":" + locale, JSON.stringify(next));
      } catch {
        if (run === generation.current) setFailed(true);
      } finally {
        if (run === generation.current) {
          busy.current = false;
          setLoading(false);
          if (refreshPending.current) {
            refreshPending.current = false;
            void reload();
          }
        }
      }
    },
    [locale],
  );

  useFocusEffect(
    useCallback(() => {
      const run = ++generation.current;
      busy.current = false;
      refreshPending.current = false;
      owner.current = account;
      setPage(empty());
      setLoading(false);
      setFailed(false);
      void (async () => {
        if (account) {
          try {
            const cached = await getAppMeta("notification_inbox:" + account + ":" + locale);
            if (cached && run === generation.current && getAccountIdSync() === account) {
              const parsed = JSON.parse(cached) as InboxPage;
              if (Array.isArray(parsed.items)) setPage(parsed);
            }
          } catch {
            /* A broken cache never blocks a fresh read. */
          }
        }
        if (run === generation.current) await reload();
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = onTabApplied(() => {
        if (AppState.currentState !== "active") return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void reload(), 250);
      });
      const app = AppState.addEventListener("change", (state) => {
        if (state === "active") void reload();
      });
      const poll = setInterval(() => {
        if (AppState.currentState === "active") void reload();
      }, 60_000);
      return () => {
        generation.current++;
        busy.current = false;
        refreshPending.current = false;
        off();
        app.remove();
        clearInterval(poll);
        if (timer) clearTimeout(timer);
      };
    }, [account, locale, reload]),
  );

  const read = async (id?: string) => {
    const who = getAccountIdSync();
    if (!who || (id == null && page.latest_id === "0")) return;
    await markInboxRead(id ? { id } : { through: page.latest_id });
    if (who !== getAccountIdSync()) return;
    // Invalidate a pre-mark GET: otherwise its older unread count can land
    // after this acknowledgement and make a read notice look new again.
    generation.current++;
    busy.current = false;
    refreshPending.current = false;
    await reload();
  };
  return {
    page: owner.current === account ? page : empty(),
    loading,
    failed,
    reload,
    read,
    signedIn: !!account,
  };
}
