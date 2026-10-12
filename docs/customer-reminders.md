# Personal customer reminders

A reminder is a private task to contact a customer. It never sends a WhatsApp
message or changes a tally. Any member who can read the customer may set their
own reminder; it does not require permission to edit the shared kaata.

## Interface

The customer menu opens **Reminders**, where the user chooses one date, a daily
time, any selected weekdays, or a monthly date and time. Monthly intervals are
one, two, three, six or twelve months. The notification inbox has a quiet shortcut to
the reminder overview, with a count of due tasks. Customer-specific controls stay
on their own screen rather than adding a permanent toolbar to the ledger.

A due reminder remains outstanding until the user explicitly taps **Mark done**.
Opening its notification, viewing the customer, or opening WhatsApp does not
complete it. Completion disables a one-off reminder or advances the next daily
weekly, selected-weekday or monthly occurrence. Missed recurring occurrences become one outstanding task,
not a list of duplicated tasks. Native recurring notices can recur while that
task remains outstanding.

Monthly schedules explicitly use the **Gregorian calendar**, regardless of the
ledger's chosen display calendar. The selected month fixes the repeating phase:
every two months anchored in November means November, January, March, May, July
and September each year. It is a repeating day/month pattern, not a deferred
first-start date; the editor shows the actual next occurrence. The chosen clock
time follows the phone's civil timezone and daylight-saving changes.

Monthly days are **1–28**. Days 29–31 and “last day of the month” are not offered
because native repeating triggers behave differently on short months. The editor
states the calendar and range, and blocks saving an out-of-range date. This keeps
the due task and Android/iOS notices on the same predictable date without relying
on the app to refill a queue. One-off dates retain the ledger's chosen display
calendar and accept any valid future day.

## Privacy and delivery

Mobile migration 036 stores reminders separately from signed ledger events. They
belong to the current account and this physical phone. Signed-out reminders have
a local owner scope. There is no cloud or mesh sharing, and signing in does not
silently transfer signed-out reminders to an account.

The physical-device key is kept in SecureStore, outside Android backups and with
iOS `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Copying SQLite to another phone cannot
activate the original phone's tasks. A local database recovery on the same phone
keeps the key. Sign-out, account changes, removed customers and revoked kaata
access remove the corresponding tasks from the visible list and cancel their
native notices. Tasks are retained privately in local storage until deleted or
the app's local data is reset.

Save asks for notification permission explicitly. If permission is unavailable
or denied, the reminder still appears in-app; launch and resume never prompt.
There is a limit of 40 active reminders per owner and phone, and 56 native
notification requests. A one-off, daily, weekly or every-month reminder uses one
request; selected weekdays use one per selected day. An interval of two, three,
six or twelve months uses six, four, two or one repeating yearly requests,
respectively. These are persistent native recurrences; reopening Kaata is not
required to refill future dates. Saves and edits reject a plan that exceeds the
request budget, with a visible message, rather than leaving some active reminders
without notices. Editing replaces its own slots; re-enabling an old reminder
rechecks both limits. Eight iOS pending-request slots remain available for other
features. On Android, the month plans use Expo's monthly/yearly triggers; on iOS
they use repeating ISO-calendar triggers so a non-Gregorian system calendar
cannot reinterpret the chosen month/day. Scheduled and delivered
notifications use generic text and opaque reminder IDs, with no customer name,
amount or account credential. A tap resolves the ID against current private
storage and rechecks access before navigation.

All recurring times follow the device's local clock and timezone. An already
due task remains due after a timezone change. Native scheduling follows platform
delivery rules; Android delivery does not request exact-alarm permission. Expo Go
retains the in-app task list but does not schedule these native notices.

## Checks and remaining device QA

The four reminder selftest suites cover civil-time recurrence in Kabul and New
York, the actual SQLite migration and access queries, account/device boundaries,
month phase/year boundaries, multiple weekdays, schedule-slot budgets,
completion and edit races, permission handling, native schedule/tray cleanup,
opaque notification navigation, actual screens and picker lifecycle. They use
synthetic data and controlled native boundaries.

Signed Android/iOS testing is still required for notification permission,
background delivery, timezone changes, native date/time pickers, notification
taps and English/Dari layouts. Signed binaries are available in TestFlight 34 and
Play internal 54; those deliveries do not complete the physical-device checks.

The schedule JSON adds new kinds without altering migration 036 or rewriting
existing reminders. Existing once/daily/weekly JSON remains valid. As personal
phone state, reminders are not projected through backend or shared-ledger events.
Downgrading to an older app cannot read the new monthly/selected-weekday kinds;
use the updated app on a phone where those schedules were created.
