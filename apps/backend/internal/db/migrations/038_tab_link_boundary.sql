-- Preserve the per-party local cutover across device restore. Party B can
-- attach to a contact long after the tab was created; using tabs.created_at
-- would count their private pre-link tallies a second time after reinstall.
ALTER TABLE tab_parties ADD COLUMN linked_at_ms BIGINT;
UPDATE tab_parties p SET linked_at_ms =
  (EXTRACT(EPOCH FROM COALESCE(p.joined_at, t.created_at)) * 1000)::BIGINT
FROM tabs t WHERE t.id = p.tab_id AND p.relationship_id IS NOT NULL;
