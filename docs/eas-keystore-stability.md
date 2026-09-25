# EAS project and signing stability

Build from `apps/mobile/`, never the repository root. Preserve the existing
project and signing credentials so each store can update the installed app.

## Preflight

- EAS project: `a612156b-0f0b-47ea-ac66-b54d880d98aa`; owner: `mateesaafi`.
- Android package and iOS bundle identifier: `af.kaata.app`.
- Use `production` for builds and `testing` for submissions:
  `eas build --profile production --platform all --auto-submit-with-profile testing --non-interactive`.
- Verify the build log uses the configured Android keystore. Stop if it proposes
  creating replacement credentials; investigate before distributing anything.
- Keep store updates in place. Never uninstall or clear app data to bypass an
  installation/signature error.

## If a build fails signing checks

Check the working directory, EAS project, account and configured credentials.
Do not change the package identifier or generate replacement keys as a workaround.
Resolve the signing issue through the existing EAS/store credential setup first.

## If data appears missing

An app identity/profile change, clearing app storage, or a migration failure
can affect access to the local database. Inspect diagnostics and backups before
making changes; preserve the installed data while investigating.

See CLAUDE.md's release/deploy flow and `apps/mobile/eas.json` for store delivery.
