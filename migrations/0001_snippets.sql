CREATE TABLE snippets (
  id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL CHECK(length(ciphertext) <= 65536),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX snippets_expires_at_idx ON snippets(expires_at);
