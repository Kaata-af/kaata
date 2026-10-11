-- An explicit Kaata display name is independent of Google/Apple identity data.
-- Provider relogins continue refreshing accounts.name and auth_credentials.name.
ALTER TABLE accounts ADD COLUMN display_name TEXT;
