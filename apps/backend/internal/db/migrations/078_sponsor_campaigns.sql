CREATE TABLE sponsor_campaigns (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sponsor TEXT NOT NULL CHECK (char_length(sponsor) BETWEEN 1 AND 80),
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
    body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 180),
    image_url TEXT CHECK (octet_length(image_url) BETWEEN 1 AND 2048),
    cta_label TEXT CHECK (char_length(cta_label) BETWEEN 1 AND 32),
    cta_url TEXT CHECK (octet_length(cta_url) BETWEEN 1 AND 2048),
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((cta_label IS NULL) = (cta_url IS NULL)),
    CHECK (isfinite(starts_at) AND isfinite(ends_at) AND starts_at < ends_at)
);

CREATE INDEX sponsor_campaigns_active_window ON sponsor_campaigns (ends_at, starts_at)
    WHERE is_active;
