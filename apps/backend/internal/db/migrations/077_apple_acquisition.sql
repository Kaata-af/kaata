-- Aggregate Apple campaign downloads by report date. Suppressed or missing
-- observations have no row. A reported zero is stored explicitly.
CREATE TABLE apple_acquisition_import_days (
  report_date DATE PRIMARY KEY,
  processing_date DATE NOT NULL CHECK (processing_date >= report_date)
);

CREATE TABLE apple_acquisition_daily (
  report_date DATE NOT NULL REFERENCES apple_acquisition_import_days(report_date) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('facebook_ads', 'organic_posts', 'bill_share')),
  first_downloads INTEGER NOT NULL CHECK (first_downloads >= 0),
  PRIMARY KEY (report_date, source)
);
