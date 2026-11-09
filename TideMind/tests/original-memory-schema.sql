CREATE TABLE memories (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  layer TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  key TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  importance INTEGER NOT NULL DEFAULT 3,
  confidence REAL NOT NULL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'user',
  source_session TEXT,
  source_turn INTEGER,
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  valid_from INTEGER,
  valid_to INTEGER,
  superseded_by TEXT,
  conflict_with TEXT,
  norm_hash TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, tokenize='trigram', content='memories', content_rowid='rowid');
CREATE TABLE memory_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, memory_id TEXT, layer TEXT, detail TEXT NOT NULL DEFAULT '{}');
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE persona (key TEXT PRIMARY KEY, content TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
CREATE TABLE persona_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, reason TEXT);
CREATE TABLE retrieval_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, query TEXT NOT NULL, items INTEGER NOT NULL, chars INTEGER NOT NULL, est_tokens INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'context');
CREATE INDEX ix_mem_layer_status ON memories(layer, status, updated_at DESC);
CREATE INDEX ix_mem_updated ON memories(updated_at DESC);
CREATE UNIQUE INDEX ux_mem_key ON memories(layer, key) WHERE key IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX ux_mem_norm ON memories(layer, norm_hash) WHERE status IN ('active', 'pending');
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
END;
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF content, tags ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;