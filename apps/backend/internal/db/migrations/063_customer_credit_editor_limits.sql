-- Existing clerk-only policies keep their meaning. Warning policies remain
-- advisory regardless of this flag or an individual member's credit setting.
ALTER TABLE customer_credit_limits
  ADD COLUMN restrict_editors BOOLEAN NOT NULL DEFAULT FALSE;
