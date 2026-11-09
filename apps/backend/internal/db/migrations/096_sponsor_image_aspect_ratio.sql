-- All prior artwork was uploaded at 320 × 50 or an integer multiple.
ALTER TABLE sponsor_images ADD COLUMN aspect_ratio DOUBLE PRECISION NOT NULL DEFAULT 6.4
    CHECK (aspect_ratio BETWEEN 2 AND 2048);
