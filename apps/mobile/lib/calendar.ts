// Calendar system preference — Gregorian vs Afghan Solar Hijri (Jalali).
//
// WHY THIS EXISTS. Before this module the calendar was a side effect of
// LANGUAGE: `formatSettlementDate(ms, locale)` and the bill renderers all
// keyed off "is the locale fa?", so there was no way to express "Dari
// language, Gregorian dates" — a real combination for shopkeepers who read
// Dari but keep books in the Gregorian convention. The calendar is now an
// explicit, independent choice.
//
// SCOPE IS GLOBAL, like language — not per-vault like currency. A calendar is
// a property of the person READING, not of the shop's books: the same phone
// shows the same date system in every kaata. Stored in app_meta (device-local,
// no migration needed — app_meta is a key/value table).
//
// THE SPLIT THAT MAKES ALL FOUR COMBINATIONS COHERENT (Matee, 2026-08-11):
//
//     calendar → WHICH MONTHS EXIST     language → HOW THEY ARE WRITTEN
//
//                    ENGLISH UI        PERSIAN UI
//     Gregorian      5 Aug 2026        ۵ اگست ۲۰۲۶
//     Solar Hijri    5 Asad 1405       ۵ اسد ۱۴۰۵
//
// So picking Solar Hijri in an English UI gives transliterated Afghan month
// names in Latin digits — readable, not a wall of Arabic script. See
// lib/jalali.ts for the four name tables this implies.
//
// THE DEFAULT IS 'auto', WHICH IS NOT A COP-OUT. It resolves to jalali when
// the app language is Persian and gregorian otherwise — exactly the behaviour
// that shipped before this module existed. Every install therefore upgrades to
// byte-identical output and nobody's dates move until they choose. It also
// keeps working the way a user expects when they later switch language.
//
// RENDER-TIME ONLY. Nothing here ever touches stored data. Every timestamp in
// SQLite, in event payloads, on the sync wire and in bill snapshots stays
// epoch milliseconds. A Jalali value written to any of those is a bug.

import { getAppMeta } from "./db";
import { getLocale, subscribeLocale } from "./i18n";
import { useEffect, useState } from "react";

/** The resolved calendar actually used for rendering. */
export type Calendar = "gregorian" | "jalali";

/** What the user picked. 'auto' follows the app language. */
export type CalendarPref = "auto" | Calendar;

export const DEFAULT_CALENDAR_PREF: CalendarPref = "auto";

/** app_meta key. Named beside `locale_pref` / `default_currency`. */
export const CALENDAR_PREF_KEY = "calendar_pref";

// Module-level mutable so any render path can read it synchronously without
// prop-drilling — same pattern as lib/currency.ts's currentCurrency and
// lib/i18n.ts's currentLocale.
let currentPref: CalendarPref = DEFAULT_CALENDAR_PREF;

/** Narrow an untrusted string (app_meta row, old build, manual edit). */
export function parseCalendarPref(raw: string | null | undefined): CalendarPref {
  return raw === "gregorian" || raw === "jalali" || raw === "auto" ? raw : DEFAULT_CALENDAR_PREF;
}

export function getCalendarPref(): CalendarPref {
  return currentPref;
}

/**
 * The calendar to actually render with. Resolves 'auto' against the CURRENT
 * locale on every call rather than caching, so a language switch moves an
 * 'auto' user's dates on the same render as their strings.
 */
export function getEffectiveCalendar(): Calendar {
  if (currentPref === "auto") return getLocale() === "fa" ? "jalali" : "gregorian";
  return currentPref;
}

// ---- change notification -------------------------------------------------
//
// Mirrors lib/i18n.ts's localeListeners. Currency deliberately has no
// subscription (it is read fresh on every amount render), but dates are held
// in already-mounted list rows, so a pref change with no notify would leave
// every visible date stale until the screen happened to re-render.

const calendarListeners = new Set<() => void>();

function notifyCalendarChange(): void {
  // Snapshot the set so a listener that unsubscribes itself mid-notification
  // doesn't mutate the iteration target (same guard as notifyLocaleChange).
  for (const fn of [...calendarListeners]) {
    try {
      fn();
    } catch (err) {
      console.warn("[calendar] listener threw", err);
    }
  }
}

export function subscribeCalendar(fn: () => void): () => void {
  calendarListeners.add(fn);
  return () => {
    calendarListeners.delete(fn);
  };
}

/**
 * Read the stored choice and apply it. Called from _layout.tsx's user_prefs
 * boot step, which runs BEFORE the Stack renders, so frame zero is already
 * correct and no date visibly re-flows on launch.
 */
export async function initCalendarFromPref(): Promise<void> {
  try {
    const next = parseCalendarPref(await getAppMeta(CALENDAR_PREF_KEY));
    if (next !== currentPref) {
      currentPref = next;
      notifyCalendarChange();
    }
  } catch {
    // app_meta unreadable — stay on 'auto', which reproduces the pre-setting
    // behaviour. Never throw into boot.
  }
}

/**
 * Imperatively change the calendar. Like setLocale, this does NOT persist —
 * the caller also writes app_meta. Keeping the two halves separate is what
 * lets onboarding-style callers apply a choice they persist themselves.
 */
export function setCalendarPref(pref: CalendarPref): void {
  if (currentPref === pref) return;
  currentPref = pref;
  notifyCalendarChange();
}

/**
 * Hook: the effective calendar, re-rendering the consumer whenever the choice
 * OR the language changes.
 *
 * Subscribes to BOTH because both feed the output, and it holds a monotonic
 * counter rather than the derived value. That is deliberate: useIsRTL stores a
 * derived BOOLEAN, so a change that doesn't move the boolean repaints nothing
 * (lib/direction.ts:56 — an 'system'→'en' switch on an English device is a
 * no-op there). The same bug here would be worse, because language changes the
 * SCRIPT even when the calendar is unchanged: a gregorian user switching
 * en→fa must repaint "5 Aug 2026" to "۵ اگست ۲۰۲۶", and a derived-calendar
 * state would see "gregorian" both times and skip it.
 */
export function useCalendar(): Calendar {
  const [, bump] = useState(0);
  useEffect(() => {
    const rerender = () => bump((n) => n + 1);
    const offCalendar = subscribeCalendar(rerender);
    const offLocale = subscribeLocale(rerender);
    return () => {
      offCalendar();
      offLocale();
    };
  }, []);
  return getEffectiveCalendar();
}
