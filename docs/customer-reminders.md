# Personal customer reminders

A reminder is a private task to contact a customer. It never sends a WhatsApp
message or changes a tally. Any member who can read the customer may set their
own reminder; it does not require permission to edit the shared kaata.

## Interface

The customer menu opens **Reminders**, where the user chooses one date, a daily
time, or a weekly day and time. The notification inbox has a quiet shortcut to
the reminder overview, with a count of due tasks. Customer-specific controls stay
on their own screen rather than adding a permanent toolbar to the ledger.

A due reminder remains outstanding until the user explicitly taps **Mark done**.
Opening its notification, viewing the customer, or opening WhatsApp does not
complete it. Completion disables a one-off reminder or advances the next daily
or weekly occurrence. Missed recurring occurrences become one outstanding task,
not a list of duplicated tasks. Native daily/weekly notices can recur while that
task remains outstanding.

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
There is a limit of 40 active reminders per owner and phone, leaving room within
the operating systems' pending-notification limits. Scheduled and delivered
notifications use generic text and opaque reminder IDs, with no customer name,
amount or account credential. A tap resolves the ID against current private
storage and rechecks access before navigation.

Daily and weekly times follow the device's local clock and timezone. An already
due task remains due after a timezone change. Native scheduling follows platform
delivery rules; Android delivery does not request exact-alarm permission. Expo Go
retains the in-app task list but does not schedule these native notices.

## Checks and remaining device QA

The four reminder selftest suites cover civil-time recurrence in Kabul and New
York, the actual SQLite migration and access queries, account/device boundaries,
completion and edit races, permission handling, native schedule/tray cleanup,
opaque notification navigation, actual screens and picker lifecycle. They use
synthetic data and controlled native boundaries.

Signed Android/iOS testing is still required for notification permission,
background delivery, timezone changes, native date/time pickers, notification
taps and English/Dari layouts. No signed binary or store distribution is part of
this local development batch.
