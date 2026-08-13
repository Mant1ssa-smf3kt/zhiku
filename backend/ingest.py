"""后台入库：解析 -> 切片 -> 分批向量化 -> 入库，以及整科目重建索引。"""
import threading

import numpy as np

from . import database as db
from .chunker import chunk_text
from .llm import LLMError, embed_texts
from .parsers import extract_segments
from .retrieval import resolve_embed

# 限制同时向量化的任务数，避免打爆 API 限速
_sem = threading.Semaphore(2)
_BATCH = 16


def _fail(doc_id, exc):
    if isinstance(exc, (ValueError, LLMError)):
        msg = str(exc)
    else:
        msg = "{}: {}".format(type(exc).__name__, exc)
    db.execute("UPDATE documents SET status='error', error=? WHERE id=?", (msg[:500], doc_id))


def _doc_alive(doc_id):
    return db.query_one("SELECT id FROM documents WHERE id=?", (doc_id,)) is not None


def _process(doc_id):
    with _sem:
        doc = db.query_one("SELECT * FROM documents WHERE id=?", (doc_id,))
        if not doc:
            return
        subject = db.query_one("SELECT * FROM subjects WHERE id=?", (doc["subject_id"],))
        if not subject:
            return
        try:
            cfg = resolve_embed(subject)
            if not cfg:
                raise ValueError(
                    "尚未配置向量化（Embedding）模型，请先在「全局设置」或「科目设置」中配置，"
                    "然后删除本文件重新上传"
                )
            segments = extract_segments(doc["file_path"], doc["filename"])
            pieces = []
            for loc, text in segments:
                for c in chunk_text(text):
                    pieces.append((loc, c))
            if not pieces:
                raise ValueError("未能从文件中提取到有效文字内容")

            db.execute(
                "UPDATE documents SET total_chunks=?, processed_chunks=0 WHERE id=?",
                (len(pieces), doc_id),
            )
            db.execute("DELETE FROM chunks WHERE document_id=?", (doc_id,))

            seq = 0
            for i in range(0, len(pieces), _BATCH):
                batch = pieces[i : i + _BATCH]
                vecs = embed_texts(cfg[0], cfg[1], cfg[2], [t for _, t in batch])
                if not _doc_alive(doc_id):  # 处理途中文件被删除
                    db.execute("DELETE FROM chunks WHERE document_id=?", (doc_id,))
                    return
                rows = []
                for (loc, text), v in zip(batch, vecs):
                    arr = np.asarray(v, dtype=np.float32)
                    rows.append(
                        (doc_id, doc["subject_id"], seq, loc, text, arr.tobytes(), int(arr.shape[0]))
                    )
                    seq += 1
                db.executemany(
                    "INSERT INTO chunks(document_id,subject_id,seq,location,text,embedding,dim) "
                    "VALUES(?,?,?,?,?,?,?)",
                    rows,
                )
                db.execute("UPDATE documents SET processed_chunks=? WHERE id=?", (seq, doc_id))

            db.execute(
                "UPDATE documents SET status='ready', chunk_count=?, error='' WHERE id=?",
                (seq, doc_id),
            )
            # 入库成功后异步建图（规则实体 + 共现）；失败不回滚 ready
            try:
                from .graph_pipe import enqueue_document

                enqueue_document(doc_id)
            except Exception:
                pass
        except Exception as e:
            _fail(doc_id, e)


def process_document_async(doc_id):
    threading.Thread(target=_process, args=(doc_id,), daemon=True).start()


def _reindex(subject_id, doc_ids):
    with _sem:
        subject = db.query_one("SELECT * FROM subjects WHERE id=?", (subject_id,))
        if not subject:
            return
        cfg = resolve_embed(subject)
        for doc_id in doc_ids:
            try:
                if not cfg:
                    raise ValueError("尚未配置向量化模型")
                chunks = db.query(
                    "SELECT id, text FROM chunks WHERE document_id=? ORDER BY seq", (doc_id,)
                )
                db.execute(
                    "UPDATE documents SET total_chunks=?, processed_chunks=0 WHERE id=?",
                    (len(chunks), doc_id),
                )
                done = 0
                for i in range(0, len(chunks), _BATCH):
                    batch = chunks[i : i + _BATCH]
                    vecs = embed_texts(cfg[0], cfg[1], cfg[2], [c["text"] for c in batch])
                    if not _doc_alive(doc_id):
                        break
                    rows = []
                    for c, v in zip(batch, vecs):
                        arr = np.asarray(v, dtype=np.float32)
                        rows.append((arr.tobytes(), int(arr.shape[0]), c["id"]))
                    db.executemany("UPDATE chunks SET embedding=?, dim=? WHERE id=?", rows)
                    done += len(batch)
                    db.execute(
                        "UPDATE documents SET processed_chunks=? WHERE id=?", (done, doc_id)
                    )
                if _doc_alive(doc_id):
                    db.execute(
                        "UPDATE documents SET status='ready', chunk_count=?, error='' WHERE id=?",
                        (len(chunks), doc_id),
                    )
            except Exception as e:
                _fail(doc_id, e)


def reindex_subject_async(subject_id):
    """把有切片的文档标记为 processing 后台重嵌入，返回涉及的文档数。"""
    docs = db.query(
        "SELECT DISTINCT document_id AS id FROM chunks WHERE subject_id=?", (subject_id,)
    )
    if not docs:
        return 0
    doc_ids = [d["id"] for d in docs]
    for doc_id in doc_ids:
        db.execute(
            "UPDATE documents SET status='processing', error='', processed_chunks=0 WHERE id=?",
            (doc_id,),
        )
    threading.Thread(target=_reindex, args=(subject_id, doc_ids), daemon=True).start()
    return len(docs)
