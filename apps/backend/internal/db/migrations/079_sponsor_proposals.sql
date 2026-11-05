CREATE TABLE sponsor_proposals (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    submission_id UUID NOT NULL UNIQUE CHECK (submission_id <> '00000000-0000-0000-0000-000000000000'),
    business_name TEXT NOT NULL CHECK (char_length(business_name) BETWEEN 1 AND 120),
    contact_name TEXT NOT NULL CHECK (char_length(contact_name) BETWEEN 1 AND 100),
    phone TEXT NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
    proposal TEXT NOT NULL CHECK (char_length(proposal) BETWEEN 1 AND 3000),
    budget_amount NUMERIC(14,2) NOT NULL CHECK (budget_amount > 0),
    budget_currency TEXT NOT NULL CHECK (budget_currency ~ '^[A-Z]{3}$'),
    duration TEXT NOT NULL DEFAULT '' CHECK (char_length(duration) <= 120),
    app_locale TEXT NOT NULL CHECK (app_locale IN ('en', 'fa', 'ps')),
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'contacted', 'accepted', 'declined', 'archived')),
    notes TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 5000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sponsor_proposals_created ON sponsor_proposals (created_at DESC, id DESC);
