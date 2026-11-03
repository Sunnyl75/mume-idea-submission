-- An editor prevents silent overwrites. Backed requests can transfer editorship.
ALTER TABLE council_reviews ADD COLUMN author_id TEXT;
ALTER TABLE council_reviews ADD COLUMN author_name TEXT;
CREATE TABLE council_review_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  idea_content TEXT NOT NULL,
  proposer_id TEXT NOT NULL,
  proposer_name TEXT NOT NULL,
  draft TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  applied_by_id TEXT,
  applied_by_name TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX council_review_changes_idea ON council_review_changes(idea_id, id);
