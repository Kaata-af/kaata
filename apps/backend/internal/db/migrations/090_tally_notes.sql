-- Keep note-only recovery independent of the size of the financial ledger.
CREATE INDEX events_tally_note_history ON events(vault_id, server_seq)
  WHERE event_type IN ('tally_note_added', 'tally_note_removed') AND redacted_at IS NULL;

-- A note can only name an existing relationship from its own Kaata.
CREATE INDEX events_person_relationship ON events(vault_id, relationship_id)
  WHERE event_type = 'person_added' AND redacted_at IS NULL;
