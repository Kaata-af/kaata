ALTER TABLE sponsor_placement ADD COLUMN locale_settings JSONB;

UPDATE sponsor_placement
SET locale_settings = jsonb_build_object(
    'en', jsonb_build_object('button_label', button_label, 'slides', slides),
    'fa', jsonb_build_object('button_label', button_label, 'slides', slides),
    'ps', jsonb_build_object('button_label', button_label, 'slides', slides)
);

ALTER TABLE sponsor_placement
    ALTER COLUMN locale_settings SET NOT NULL,
    ADD CONSTRAINT sponsor_placement_locale_settings_valid CHECK ((
        jsonb_typeof(locale_settings) = 'object'
        AND locale_settings ?& ARRAY['en', 'fa', 'ps']
        AND locale_settings - ARRAY['en', 'fa', 'ps'] = '{}'::jsonb
        AND jsonb_typeof(locale_settings->'en'->'button_label') = 'string'
        AND jsonb_typeof(locale_settings->'fa'->'button_label') = 'string'
        AND jsonb_typeof(locale_settings->'ps'->'button_label') = 'string'
        AND char_length(locale_settings->'en'->>'button_label') <= 32
        AND char_length(locale_settings->'fa'->>'button_label') <= 32
        AND char_length(locale_settings->'ps'->>'button_label') <= 32
        AND jsonb_array_length(locale_settings->'en'->'slides') BETWEEN 0 AND 8
        AND jsonb_array_length(locale_settings->'fa'->'slides') BETWEEN 0 AND 8
        AND jsonb_array_length(locale_settings->'ps'->'slides') BETWEEN 0 AND 8
        AND (NOT banner_enabled OR
            jsonb_array_length(locale_settings->'en'->'slides') +
            jsonb_array_length(locale_settings->'fa'->'slides') +
            jsonb_array_length(locale_settings->'ps'->'slides') > 0)
    ) IS TRUE),
    DROP COLUMN button_label,
    DROP COLUMN slides;

DROP TABLE sponsor_campaigns;
