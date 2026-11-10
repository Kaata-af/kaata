-- Cross-script name hints supplement exact identity matching. Original names
-- stay unchanged, phones are never indexed here, and callers must apply the
-- same discovery/relationship visibility rules before returning a candidate.
CREATE FUNCTION people_name_sound_keys(value TEXT, require_all BOOLEAN DEFAULT FALSE)
RETURNS TEXT[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  cleaned TEXT;
  word TEXT;
  letter TEXT;
  roman TEXT;
  mapped TEXT;
  skeleton TEXT;
  sound_key TEXT;
  keys TEXT[] := ARRAY[]::TEXT[];
  letter_index INTEGER;
  eligible BOOLEAN;
BEGIN
  cleaned := people_search_text(normalize(value, NFKD));
  -- Accent/vowel marks carry no consonant identity. Joining and directional
  -- controls are removed, not turned into artificial name-word boundaries.
  cleaned := regexp_replace(cleaned,
    U&'[\0300-\036f\0610-\061a\064b-\065f\0670\06d6-\06dc\06df-\06e4\06e7-\06e8\06ea-\06ed]', '', 'g');
  cleaned := translate(cleaned,
    U&'\0640\061c\200c\200d\200e\200f\202a\202b\202c\202d\202e\2066\2067\2068\2069', '');

  -- Name scripts stay word characters even on a cluster using the C locale.
  FOREACH word IN ARRAY regexp_split_to_array(cleaned, '[^[:alnum:]ء-يٱ-ۓەßæœøłðđþ]+') LOOP
    CONTINUE WHEN word = '';
    roman := '';
    eligible := char_length(word) >= 3;
    FOR letter_index IN 1..char_length(word) LOOP
      letter := substr(word, letter_index, 1);
      mapped := CASE
        WHEN letter COLLATE "C" BETWEEN 'a' AND 'z' THEN letter
        WHEN letter IN ('ا', 'ع', 'ء', 'ة') THEN 'a'
        WHEN letter = 'ب' THEN 'b'
        WHEN letter = 'پ' THEN 'p'
        WHEN letter IN ('ت', 'ط', 'ټ') THEN 't'
        WHEN letter IN ('ث', 'س', 'ص') THEN 's'
        WHEN letter = 'ج' THEN 'j'
        WHEN letter = 'چ' THEN 'ch'
        WHEN letter IN ('ح', 'ه', 'ھ', 'ۀ', 'ە') THEN 'h'
        WHEN letter = 'خ' THEN 'kh'
        WHEN letter IN ('د', 'ډ') THEN 'd'
        WHEN letter IN ('ذ', 'ز', 'ض', 'ظ') THEN 'z'
        WHEN letter IN ('ر', 'ړ') THEN 'r'
        WHEN letter IN ('ژ', 'ږ') THEN 'zh'
        WHEN letter IN ('ش', 'ښ') THEN 'sh'
        WHEN letter = 'غ' THEN 'gh'
        WHEN letter = 'ف' THEN 'f'
        WHEN letter = 'ق' THEN 'q'
        WHEN letter IN ('ک', 'ك') THEN 'k'
        WHEN letter IN ('گ', 'ګ') THEN 'g'
        WHEN letter = 'ل' THEN 'l'
        WHEN letter = 'م' THEN 'm'
        WHEN letter IN ('ن', 'ڼ') THEN 'n'
        WHEN letter = 'و' THEN CASE WHEN letter_index = 1 THEN 'w' ELSE 'u' END
        WHEN letter IN ('ی', 'ي', 'ى', 'ې', 'ۍ', 'ئ')
          THEN CASE WHEN letter_index = 1 THEN 'y' ELSE 'i' END
        WHEN letter = 'ځ' THEN 'dz'
        WHEN letter = 'څ' THEN 'ts'
        WHEN letter = 'ß' THEN 'ss'
        WHEN letter = 'æ' THEN 'ae'
        WHEN letter = 'œ' THEN 'oe'
        WHEN letter = 'ø' THEN 'o'
        WHEN letter = 'ł' THEN 'l'
        WHEN letter IN ('ð', 'đ') THEN 'd'
        WHEN letter = 'þ' THEN 'th'
        ELSE NULL
      END;
      IF mapped IS NULL THEN
        eligible := FALSE;
        EXIT;
      END IF;
      roman := roman || mapped;
    END LOOP;
    IF NOT eligible THEN
      IF require_all THEN RETURN NULL; END IF;
      CONTINUE;
    END IF;

    -- Medial y/w commonly stand for vowels in Latin name spellings too.
    roman := left(roman, 1) || translate(substr(roman, 2), 'yw', 'iu');
    -- Collapse adjacent consonants BEFORE omitting vowels: Bassit -> Basit,
    -- while the two d's in Dawood remain distinct rather than becoming one.
    roman := regexp_replace(roman, '([bcdfghjklmnpqrstvwxyz])\1+', '\1', 'g');
    skeleton := regexp_replace(roman, '[aeiou]', '', 'g');
    IF char_length(skeleton) >= 2 THEN
      sound_key := 'c:' || skeleton;
    ELSIF char_length(roman) >= 3 AND char_length(skeleton) = 1 THEN
      -- Ali / علی share "ali". Never index a bare "l": unrelated short
      -- names must not all match solely because their vowels were removed.
      sound_key := 'v:' || roman;
    ELSE
      IF require_all THEN RETURN NULL; END IF;
      CONTINUE;
    END IF;
    IF NOT sound_key = ANY(keys) THEN keys := array_append(keys, sound_key); END IF;
  END LOOP;
  IF cardinality(keys) = 0 THEN RETURN NULL; END IF;
  RETURN (SELECT array_agg(key ORDER BY key) FROM unnest(keys) AS key);
END
$$;

CREATE INDEX accounts_discovery_name_sound ON accounts USING gin
  (people_name_sound_keys(COALESCE(NULLIF(display_name,''),name,'')))
  WHERE discovery_enabled AND disabled_at IS NULL AND pending_delete_at IS NULL;
