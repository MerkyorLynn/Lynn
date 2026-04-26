-- Lynn brain · v0.77 sqlite-vec memory schema
-- 依赖: better-sqlite3 + sqlite-vec extension (https://github.com/asg017/sqlite-vec)
-- 安装: npm install sqlite-vec
--
-- 应用方式 (Lynn brain 启动时):
--   import * as sqliteVec from "sqlite-vec";
--   const db = new Database("~/.lynn/memory.db");
--   sqliteVec.load(db);
--   db.exec(fs.readFileSync("20260420_001_memory_vec.sql", "utf8"));

-- ============ 元数据表 ============
CREATE TABLE IF NOT EXISTS memory_meta (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT    NOT NULL,
  layer       TEXT    NOT NULL CHECK(layer IN ('L1','L2','L3','L4','L5','L6')),
  source      TEXT    NOT NULL CHECK(source IN ('chat','note','doc','voice','code','web','manual')),
  timestamp   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  metadata    TEXT,
  document_id TEXT,                    -- knowledge ingest 关联文档
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memory_layer       ON memory_meta(layer)       WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_memory_source      ON memory_meta(source)      WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_memory_timestamp   ON memory_meta(timestamp)   WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_memory_document_id ON memory_meta(document_id) WHERE document_id IS NOT NULL;

-- ============ 向量表 (sqlite-vec virtual table) ============
-- bge-m3 输出 1024 维 float
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
  embedding float[1024]
);

-- ============ 文档元数据 (knowledge ingest 用) ============
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id            TEXT    PRIMARY KEY,           -- uuid
  name          TEXT    NOT NULL,
  source_path   TEXT,
  mime_type     TEXT,
  chunks_count  INTEGER NOT NULL DEFAULT 0,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','processing','ready','failed')),
  indexed_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  tags          TEXT,                          -- 逗号分隔
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_doc_status     ON knowledge_documents(status);
CREATE INDEX IF NOT EXISTS idx_doc_indexed_at ON knowledge_documents(indexed_at);

-- ============ 触发器: 删除 doc 时连带删除 chunks ============
CREATE TRIGGER IF NOT EXISTS trg_doc_delete_cascade
AFTER DELETE ON knowledge_documents
BEGIN
  UPDATE memory_meta SET deleted = 1 WHERE document_id = OLD.id;
  -- 注意: memory_vec 没有 FK,定期清理脚本删除 deleted=1 的 vec rows
END;

-- ============ 视图: 活跃记忆 (软删除过滤) ============
CREATE VIEW IF NOT EXISTS v_memory_active AS
SELECT id, text, layer, source, timestamp, metadata, document_id
FROM memory_meta
WHERE deleted = 0;

-- ============ 元数据 KV (schema 版本等) ============
CREATE TABLE IF NOT EXISTS migrations (
  version    TEXT    PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

INSERT OR IGNORE INTO migrations (version) VALUES ('20260420_001_memory_vec');
