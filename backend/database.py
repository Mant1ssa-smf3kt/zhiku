"""SQLite 存储层：单连接 + 全局锁，WAL 模式，支持后台线程并发读写。"""
import os
import sqlite3
import threading
import time
import uuid

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("RAG_DATA_DIR") or os.path.join(BASE_DIR, "data")
FILES_DIR = os.path.join(DATA_DIR, "files")
DB_PATH = os.path.join(DATA_DIR, "kb.sqlite")

_lock = threading.RLock()
_conn = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS providers(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  chat_model TEXT NOT NULL DEFAULT '',
  embed_model TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS subjects(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4F5BD5',
  icon TEXT NOT NULL DEFAULT '📚',
  description TEXT NOT NULL DEFAULT '',
  embed_provider_id TEXT,
  embed_model TEXT,
  chat_provider_id TEXT,
  chat_model TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  top_k INTEGER NOT NULL DEFAULT 5,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents(
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  filetype TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing',
  error TEXT NOT NULL DEFAULT '',
  chunk_count INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  processed_chunks INTEGER NOT NULL DEFAULT 0,
  file_path TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  graph_status TEXT NOT NULL DEFAULT 'none',
  graph_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  embedding BLOB,
  dim INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunks_subject ON chunks(subject_id);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
CREATE TABLE IF NOT EXISTS conversations(
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '新对话',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_jobs(
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempt INTEGER NOT NULL DEFAULT 3,
  error TEXT NOT NULL DEFAULT '',
  checkpoint TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_graph_jobs_doc ON graph_jobs(document_id);
CREATE INDEX IF NOT EXISTS idx_graph_jobs_status ON graph_jobs(status);
CREATE TABLE IF NOT EXISTS entities(
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Term',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_subject_norm_type
  ON entities(subject_id, norm_name, type);
CREATE INDEX IF NOT EXISTS idx_entities_subject ON entities(subject_id);
CREATE TABLE IF NOT EXISTS entity_mentions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  chunk_id INTEGER NOT NULL,
  document_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 1.0,
  extractor TEXT NOT NULL DEFAULT 'rule'
);
CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_mentions_doc ON entity_mentions(document_id);
CREATE INDEX IF NOT EXISTS idx_mentions_chunk ON entity_mentions(chunk_id);
CREATE TABLE IF NOT EXISTS relations(
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  src_entity_id TEXT NOT NULL,
  dst_entity_id TEXT NOT NULL,
  rel_type TEXT NOT NULL DEFAULT 'CO_OCCURS',
  weight REAL NOT NULL DEFAULT 1.0,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique
  ON relations(subject_id, src_entity_id, dst_entity_id, rel_type);
CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(subject_id);
CREATE TABLE IF NOT EXISTS topics(
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  name TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_subject ON topics(subject_id);
CREATE TABLE IF NOT EXISTS doc_topics(
  document_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (document_id, topic_id)
);
CREATE TABLE IF NOT EXISTS graph_meta(
  subject_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle',
  entity_count INTEGER NOT NULL DEFAULT 0,
  relation_count INTEGER NOT NULL DEFAULT 0,
  topic_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
"""


def _migrate(conn):
    """旧库升级：providers 模型列 + 文档图状态列。"""
    pcols = {r[1] for r in conn.execute("PRAGMA table_info(providers)").fetchall()}
    if "chat_model" not in pcols:
        conn.execute("ALTER TABLE providers ADD COLUMN chat_model TEXT NOT NULL DEFAULT ''")
    if "embed_model" not in pcols:
        conn.execute("ALTER TABLE providers ADD COLUMN embed_model TEXT NOT NULL DEFAULT ''")
    dcols = {r[1] for r in conn.execute("PRAGMA table_info(documents)").fetchall()}
    if "graph_status" not in dcols:
        conn.execute(
            "ALTER TABLE documents ADD COLUMN graph_status TEXT NOT NULL DEFAULT 'none'"
        )
    if "graph_error" not in dcols:
        conn.execute(
            "ALTER TABLE documents ADD COLUMN graph_error TEXT NOT NULL DEFAULT ''"
        )
    conn.commit()


def get_conn():
    global _conn
    if _conn is None:
        os.makedirs(FILES_DIR, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(SCHEMA)
        _conn.commit()
        _migrate(_conn)
    return _conn


def query(sql, args=()):
    with _lock:
        cur = get_conn().execute(sql, args)
        return [dict(r) for r in cur.fetchall()]


def query_one(sql, args=()):
    rows = query(sql, args)
    return rows[0] if rows else None


def execute(sql, args=()):
    with _lock:
        conn = get_conn()
        cur = conn.execute(sql, args)
        conn.commit()
        return cur


def executemany(sql, rows):
    with _lock:
        conn = get_conn()
        conn.executemany(sql, rows)
        conn.commit()


def get_setting(key, default=None):
    row = query_one("SELECT value FROM settings WHERE key=?", (key,))
    return row["value"] if row and row["value"] else default


def set_setting(key, value):
    execute(
        "INSERT INTO settings(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def new_id():
    return uuid.uuid4().hex[:12]


def now():
    return int(time.time())
