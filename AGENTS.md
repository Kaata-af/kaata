# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

The app is on **Expo SDK 57 / React Native 0.86 / React 19.2**, and the **New
Architecture is mandatory** — SDK 54 was the last release that could run the
legacy architecture, and `newArchEnabled` no longer exists as a config option.
Anything written against the legacy architecture, or against SDK 54 and
earlier, may be wrong here.

Two SDK 56 changes bite silently — they type-check and bundle cleanly, then
fail at runtime. Do not undo either:

- **`expo-file-system`**: `File.move()` / `File.copy()` are now **async**
  (`Promise<void>`). Use `moveSync()` / `copySync()` in synchronous code, or
  `await`. An unawaited promise in a void context is not a type error, so
  nothing catches this but a device test. See `lib/db-backup.ts`.
- **`expo-contacts`**: the root import is the new class-based API; the
  function-style API moved to **`expo-contacts/legacy`**. The root still
  exports the old names with their old signatures, but the bodies throw. See
  `lib/contacts-sync.ts`.

Toolchain floors: **Node >= 22.13**, iOS >= 16.4, Xcode >= 26.4, Android 7+.
