-- A party may attach to its book long after an invitation was created.
-- New checkpoint order belongs to the first book/contact binding,
-- independently of user-selected entry dates and local cutover timestamps.
-- Historical first-binding time was not recorded. Preserve the old selector's
-- active-period precedence and cutover ordering during backfill, then use
-- stable server timestamps/IDs only as tie-breakers. Do not reinterpret an
-- active delayed binding as older than the closed balance it replaced.
CREATE SEQUENCE tab_party_history_order_seq;
ALTER TABLE tab_parties ADD COLUMN history_order BIGINT CHECK (history_order > 0);

WITH ordered AS (
  SELECT p.tab_id, p.role,
    ROW_NUMBER() OVER (ORDER BY (t.closed_at IS NULL),
      COALESCE(p.linked_at_ms, (EXTRACT(EPOCH FROM COALESCE(p.joined_at, t.created_at))*1000)::bigint),
      COALESCE(p.joined_at, t.created_at), t.created_at, t.id, p.role) AS history_order
  FROM tab_parties p JOIN tabs t ON t.id=p.tab_id
  WHERE p.vault_id IS NOT NULL AND p.relationship_id IS NOT NULL
)
UPDATE tab_parties p SET history_order=o.history_order
FROM ordered o WHERE p.tab_id=o.tab_id AND p.role=o.role;

SELECT setval('tab_party_history_order_seq',
  COALESCE((SELECT MAX(history_order) FROM tab_parties), 1),
  EXISTS (SELECT 1 FROM tab_parties WHERE history_order IS NOT NULL));

CREATE UNIQUE INDEX idx_tab_parties_history_order ON tab_parties(history_order)
  WHERE history_order IS NOT NULL;
