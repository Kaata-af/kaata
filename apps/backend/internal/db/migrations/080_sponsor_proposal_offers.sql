ALTER TABLE sponsor_proposals
    ADD COLUMN budget_offer TEXT NOT NULL DEFAULT '' CHECK (char_length(budget_offer) <= 1000),
    ALTER COLUMN budget_amount DROP NOT NULL,
    ALTER COLUMN budget_currency DROP NOT NULL,
    DROP CONSTRAINT sponsor_proposals_business_name_check,
    DROP CONSTRAINT sponsor_proposals_contact_name_check,
    DROP CONSTRAINT sponsor_proposals_phone_check,
    ADD CHECK (char_length(business_name) <= 120),
    ADD CHECK (char_length(contact_name) <= 100),
    ADD CHECK (phone = '' OR phone ~ '^\+[1-9][0-9]{6,14}$'),
    ADD CHECK (
        (budget_offer <> '' AND budget_amount IS NULL AND budget_currency IS NULL)
        OR
        (budget_offer = '' AND budget_amount IS NOT NULL AND budget_currency IS NOT NULL
            AND business_name <> '' AND contact_name <> '' AND phone <> '')
    );
