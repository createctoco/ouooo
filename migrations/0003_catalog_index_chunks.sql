-- The single-row catalog_index shipped in 0002 could not be written: the JSON
-- payload is ~390 KB and D1 rejects a SQL statement that long ("statement too
-- long: SQLITE_TOOBIG"). Store the same payload as ~32 KB chunks instead.
DROP TABLE IF EXISTS catalog_index;

CREATE TABLE IF NOT EXISTS catalog_index (
  locale TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (locale, chunk)
);
