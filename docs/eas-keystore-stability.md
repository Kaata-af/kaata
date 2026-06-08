# EAS keystore stability

> If you only read one paragraph: **never change the EAS `projectId` and never run `eas build` from the repo root.** Both regenerate the Android signing keystore, and Android treats a differently-signed APK as a different app — every existing install loses all SQLite data on update and the saved keystore is irrecoverable.

## The invariant

The mobile app's Android signing keystore is bound 1:1 to the EAS `projectId`. EAS stores the keystore on the Expo servers under that project. There is no password recovery, no re-issue path, and no way to "import" a stable signing certificate back into a project that has lost its key.

Two things must therefore stay stable forever:

1. `apps/mobile/app.json` → `expo.extra.eas.projectId` — currently `a612156b-0f0b-47ea-ac66-b54d880d98aa`.
2. The working directory `eas build` is invoked from — must be `apps/mobile/`, not the repo root.

If either drifts, the next preview/production APK is signed by a different keystore. Android refuses to "update" an installed APK with one signed by a different certificate. Installing the new APK requires uninstalling first, which wipes `/data/data/af.kaata.app/` — that includes the SQLite ledger.

## Symptoms of a drift

- "I installed the new version and all my data is gone."
- `adb install` rejects the new APK with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` / `signatures do not match`.
- A fresh `eas build` log shows `Creating Android Keystore` instead of `Reusing existing Android Keystore`.

## How drift happens

- Someone runs `eas build` (or `eas init`) from the repo root. Expo treats the root `package.json` as a separate project and either creates a new project under your account (`@user/kaata-monorepo`) or links the existing root to a _different_ projectId. Both paths produce a fresh keystore.
- Someone edits `expo.extra.eas.projectId` in `app.json` — including replacing it with another project's projectId, or deleting it and letting `eas init` write a new one.
- Someone runs `eas credentials --clear` or manually deletes the Android keystore in the Expo dashboard.
- The Expo account itself changes (different `owner` in `app.json`). The keystore lives under `owner`, not under the projectId alone.

## How to verify keystore stability before a release

Before publishing a new APK:

1. Confirm `apps/mobile/app.json` still has:

   ```json
   "extra": { "eas": { "projectId": "a612156b-0f0b-47ea-ac66-b54d880d98aa" } },
   "owner": "mateesaafi"
   ```

2. Confirm `apps/mobile/app.json` still has `"android": { "package": "af.kaata.app" }`. The package name is the _other_ half of Android's app identity — a different package name is a different app even with the same keystore.

3. Run the build from `apps/mobile/`, never the repo root:

   ```sh
   cd apps/mobile
   eas build --profile preview --platform android
   ```

4. In the build log, look for **`Reusing existing Android Keystore`**. If you see `Creating Android Keystore` or `Generating a new Android Keystore`, **abort the build immediately** and investigate before downloading the artifact. Distributing that APK guarantees data loss for every existing install.

5. As a belt-and-braces check, you can fetch the SHA-256 of the current keystore via `eas credentials` (from `apps/mobile/`) and compare it to the SHA-256 of a known-good prior APK (`apksigner verify --print-certs kaata-0.4.0.apk`). They must match.

## Recovery if drift has already happened

There is no recovery for the keystore itself. Options:

- If a prior APK signed with the original keystore still exists on disk somewhere (a developer machine, a download mirror), you can keep shipping updates by _that_ keystore only by retrieving and re-uploading it to EAS via `eas credentials`. The original keystore is in `apps/web/public/downloads/kaata-0.4.0.apk` history if it has not been overwritten — extract the v1 signing block with `apksigner`. **This only works if you still have the keystore file itself, not just the APK.** An APK alone is signed _by_ the keystore but does not contain it.
- Otherwise, the only path forward is to ship under a new package name (e.g., `af.kaata.app2`), accept that all existing installs are stranded on the old version, and write off the data on those devices. Do not do this lightly — it ends the upgrade path for every existing user.

## What is _not_ a keystore problem

If users report data loss but the keystore is verifiably stable, look elsewhere:

- Android package name changed in `app.json` (`expo.android.package`). Different package = different app.
- Application ID suffix added via a build variant. We do not currently use variants, so this should not occur.
- A migration crashing on first launch and the app falling back to a fresh database. Check `apps/mobile/lib/db.ts` `initDb()` and the `runMigration00X` series — each one must be idempotent against the prior schema.
- Users manually clearing app data (Android Settings → Apps → Kaata → Storage → Clear data).
- Users installing the APK on a _different_ device profile than the one that holds the original data.

## Related references

- `CLAUDE.md` → "Dev workflow quirks" and "Release / deploy flow".
- `apps/mobile/eas.json` → top-of-file comment block reminding the reader of the same invariants.
- `apps/mobile/app.json` → `expo.extra.eas.projectId`, `expo.owner`, `expo.android.package`, `expo.version`.
