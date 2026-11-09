CREATE TABLE sponsor_placement (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    button_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    button_label TEXT NOT NULL DEFAULT '' CHECK (char_length(button_label) <= 32),
    banner_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    rotation_seconds INTEGER NOT NULL DEFAULT 6 CHECK (rotation_seconds BETWEEN 3 AND 30),
    slides JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_array_length(slides) BETWEEN 0 AND 8),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (NOT banner_enabled OR jsonb_array_length(slides) > 0)
);

INSERT INTO sponsor_placement DEFAULT VALUES;

CREATE TABLE sponsor_images (
    digest TEXT PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
    content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
    artwork BYTEA NOT NULL CHECK (octet_length(artwork) BETWEEN 1 AND 1048576)
);
