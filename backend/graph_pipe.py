"""W1 知识图谱管线：规则实体 + 共现边 + 异步 job（Semaphore 1）。

挂在 documents.status=ready 之后；失败不改入库 status，只写 graph_status。
"""
import hashlib
import json
import re
import threading

from . import database as db

_sem = threading.Semaphore(1)
_MAX_CHUNKS = 2000
_MAX_NAME_LEN = 40
_MIN_NAME_LEN = 2

# 《书名》、「术语」、【术语】、连续中英专名启发式
_RE_BOOK = re.compile(r"《([^》]{2,40})》")
_RE_QUOTE_CN = re.compile(r"[「『]([^」』]{2,40})[」』]")
_RE_BRACKET = re.compile(r"【([^】]{2,40})】")
_RE_EN_TERM = re.compile(r"\b([A-Z][a-zA-Z0-9]+(?:[ \-][A-Z][a-zA-Z0-9]+){0,4})\b")


def _norm_name(name):
    s = (name or "").strip()
    s = s.replace("　", " ")
    s = re.sub(r"\s+", " ", s)
    s = s.strip(" \t\r\n\"'“”‘’·.•")
    return s.lower()


def _entity_id(subject_id, norm_name, etype):
    raw = "{}|{}|{}".format(subject_id, etype, norm_name)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _now():
    return db.now()


def extract_rule_mentions(text):
    """从单段文本抽 (name, type, score)，需再做 grounding。"""
    if not text:
        return []
    found = []
    for m in _RE_BOOK.finditer(text):
        found.append((m.group(1).strip(), "Concept", 0.95))
    for m in _RE_QUOTE_CN.finditer(text):
        found.append((m.group(1).strip(), "Term", 0.9))
    for m in _RE_BRACKET.finditer(text):
        found.append((m.group(1).strip(), "Term", 0.85))
    for m in _RE_EN_TERM.finditer(text):
        name = m.group(1).strip()
        if len(name) >= _MIN_NAME_LEN:
            found.append((name, "Term", 0.7))
    out = []
    seen = set()
    for name, etype, score in found:
        if len(name) < _MIN_NAME_LEN or len(name) > _MAX_NAME_LEN:
            continue
        if name not in text:
            continue  # grounding
        key = (_norm_name(name), etype)
        if not key[0] or key in seen:
            continue
        seen.add(key)
        out.append((name, etype, score))
    return out


def purge_document_graph(doc_id):
    """删除文档相关图数据，并清理无 mention 的实体与空证据关系。"""
    doc = db.query_one("SELECT subject_id FROM documents WHERE id=?", (doc_id,))
    subject_id = doc["subject_id"] if doc else None
    chunks = db.query("SELECT id FROM chunks WHERE document_id=?", (doc_id,))
    chunk_ids = set(c["id"] for c in chunks)

    db.execute("DELETE FROM entity_mentions WHERE document_id=?", (doc_id,))
    db.execute("DELETE FROM doc_topics WHERE document_id=?", (doc_id,))
    db.execute(
        "DELETE FROM graph_jobs WHERE document_id=? AND status IN ('pending','running')",
        (doc_id,),
    )

    if subject_id and chunk_ids:
        rels = db.query("SELECT id, evidence_json FROM relations WHERE subject_id=?", (subject_id,))
        for r in rels:
            try:
                ev = json.loads(r["evidence_json"] or "[]")
            except (TypeError, ValueError):
                ev = []
            if not isinstance(ev, list):
                ev = []
            new_ev = [c for c in ev if c not in chunk_ids]
            if not new_ev:
                db.execute("DELETE FROM relations WHERE id=?", (r["id"],))
            elif len(new_ev) != len(ev):
                db.execute(
                    "UPDATE relations SET evidence_json=?, weight=? WHERE id=?",
                    (json.dumps(new_ev, ensure_ascii=False), float(len(new_ev)), r["id"]),
                )

    if subject_id:
        orphans = db.query(
            "SELECT e.id FROM entities e WHERE e.subject_id=? AND NOT EXISTS ("
            "SELECT 1 FROM entity_mentions m WHERE m.entity_id=e.id)",
            (subject_id,),
        )
        for e in orphans:
            db.execute("DELETE FROM relations WHERE src_entity_id=? OR dst_entity_id=?", (e["id"], e["id"]))
            db.execute("DELETE FROM entities WHERE id=?", (e["id"],))
        refresh_graph_meta(subject_id)


def purge_subject_graph(subject_id):
    db.execute("DELETE FROM entity_mentions WHERE subject_id=?", (subject_id,))
    db.execute("DELETE FROM relations WHERE subject_id=?", (subject_id,))
    db.execute("DELETE FROM entities WHERE subject_id=?", (subject_id,))
    db.execute(
        "DELETE FROM doc_topics WHERE document_id IN (SELECT id FROM documents WHERE subject_id=?)",
        (subject_id,),
    )
    db.execute("DELETE FROM topics WHERE subject_id=?", (subject_id,))
    db.execute("DELETE FROM graph_jobs WHERE subject_id=?", (subject_id,))
    db.execute("DELETE FROM graph_meta WHERE subject_id=?", (subject_id,))
    db.execute(
        "UPDATE documents SET graph_status='none', graph_error='' WHERE subject_id=?",
        (subject_id,),
    )


def refresh_graph_meta(subject_id):
    entity_count = db.query_one(
        "SELECT COUNT(*) AS n FROM entities WHERE subject_id=?", (subject_id,)
    )["n"]
    relation_count = db.query_one(
        "SELECT COUNT(*) AS n FROM relations WHERE subject_id=?", (subject_id,)
    )["n"]
    topic_count = db.query_one(
        "SELECT COUNT(*) AS n FROM topics WHERE subject_id=?", (subject_id,)
    )["n"]
    pending = db.query_one(
        "SELECT COUNT(*) AS n FROM documents WHERE subject_id=? AND graph_status IN ('pending','building')",
        (subject_id,),
    )["n"]
    err_n = db.query_one(
        "SELECT COUNT(*) AS n FROM documents WHERE subject_id=? AND graph_status='error'",
        (subject_id,),
    )["n"]
    ready_n = db.query_one(
        "SELECT COUNT(*) AS n FROM documents WHERE subject_id=? AND graph_status='ready'",
        (subject_id,),
    )["n"]
    if pending:
        status = "building"
    elif ready_n and err_n:
        status = "degraded"
    elif ready_n:
        status = "ready"
    elif err_n:
        status = "degraded"
    else:
        status = "idle"

    row = db.query_one("SELECT version FROM graph_meta WHERE subject_id=?", (subject_id,))
    version = int(row["version"]) if row else 0
    if row:
        db.execute(
            "UPDATE graph_meta SET status=?, entity_count=?, relation_count=?, topic_count=?, updated_at=? "
            "WHERE subject_id=?",
            (status, entity_count, relation_count, topic_count, _now(), subject_id),
        )
    else:
        db.execute(
            "INSERT INTO graph_meta(subject_id,version,status,entity_count,relation_count,topic_count,updated_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (subject_id, version, status, entity_count, relation_count, topic_count, _now()),
        )
    return {
        "subject_id": subject_id,
        "version": version,
        "status": status,
        "entity_count": entity_count,
        "relation_count": relation_count,
        "topic_count": topic_count,
    }


def bump_graph_version(subject_id):
    row = db.query_one("SELECT version FROM graph_meta WHERE subject_id=?", (subject_id,))
    if not row:
        db.execute(
            "INSERT INTO graph_meta(subject_id,version,status,entity_count,relation_count,topic_count,updated_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (subject_id, 1, "building", 0, 0, 0, _now()),
        )
        return 1
    version = int(row["version"]) + 1
    db.execute(
        "UPDATE graph_meta SET version=?, updated_at=? WHERE subject_id=?",
        (version, _now(), subject_id),
    )
    return version


def get_graph_status(subject_id):
    meta = refresh_graph_meta(subject_id)
    jobs_pending = db.query_one(
        "SELECT COUNT(*) AS n FROM graph_jobs WHERE subject_id=? AND status IN ('pending','running')",
        (subject_id,),
    )["n"]
    meta["jobs_pending"] = jobs_pending

    # 科目级建图进度：按文档 graph_status + 当前 job checkpoint 汇总
    total_ready_docs = db.query_one(
        "SELECT COUNT(*) AS n FROM documents WHERE subject_id=? AND status='ready'",
        (subject_id,),
    )["n"]
    g_ready = db.query_one(
        "SELECT COUNT(*) AS n FROM documents WHERE subject_id=? AND graph_status='ready'",
        (subject_id,),
    )["n"]
    g_pending = db.query_one(
        "SELECT COUNT(*) AS n FROM documents WHERE subject_id=? AND graph_status='pending'",
        (subject_id,),
    )["n"]
    g_building = db.query_one(
        "SELECT COUNT(*) AS n FROM documents WHERE subject_id=? AND graph_status='building'",
        (subject_id,),
    )["n"]
    g_error = db.query_one(
        "SELECT COUNT(*) AS n FROM documents WHERE subject_id=? AND graph_status='error'",
        (subject_id,),
    )["n"]

    # 当前 running job 的细粒度进度（0~1）
    running = db.query(
        "SELECT document_id, checkpoint FROM graph_jobs "
        "WHERE subject_id=? AND status='running' ORDER BY started_at DESC LIMIT 3",
        (subject_id,),
    )
    active = []
    partial = 0.0
    for j in running:
        cp = _parse_checkpoint(j.get("checkpoint"))
        frac = 0.0
        total = int(cp.get("total") or 0)
        done = int(cp.get("done") or 0)
        if total > 0:
            frac = max(0.0, min(1.0, float(done) / float(total)))
        partial += frac
        active.append(
            {
                "document_id": j["document_id"],
                "phase": cp.get("phase") or "building",
                "done": done,
                "total": total,
                "message": cp.get("message") or "",
            }
        )

    # 进度：已完成文档 + 在建文档的部分进度
    unit = float(total_ready_docs) if total_ready_docs else 0.0
    if unit <= 0:
        pct = 100 if meta.get("status") in ("ready", "idle") else 0
    else:
        pct = (float(g_ready) + partial) / unit * 100.0
        if g_pending + g_building + g_error == 0 and g_ready > 0:
            pct = 100.0
        pct = max(0.0, min(100.0, pct))

    meta["docs_total"] = int(total_ready_docs)
    meta["docs_graph_ready"] = int(g_ready)
    meta["docs_graph_pending"] = int(g_pending)
    meta["docs_graph_building"] = int(g_building)
    meta["docs_graph_error"] = int(g_error)
    meta["progress_pct"] = round(pct, 1)
    meta["active_jobs"] = active
    return meta


def _parse_checkpoint(raw):
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else {}
    except (TypeError, ValueError):
        return {}


def document_graph_progress(doc_id):
    """单文档建图进度，供列表/轮询。"""
    doc = db.query_one(
        "SELECT id, graph_status, graph_error FROM documents WHERE id=?", (doc_id,)
    )
    if not doc:
        return None
    job = db.query_one(
        "SELECT status, checkpoint, error, attempt, updated_at FROM graph_jobs "
        "WHERE document_id=? ORDER BY created_at DESC LIMIT 1",
        (doc_id,),
    )
    cp = _parse_checkpoint(job.get("checkpoint") if job else None)
    total = int(cp.get("total") or 0)
    done = int(cp.get("done") or 0)
    gs = doc.get("graph_status") or "none"
    if gs == "ready":
        pct = 100.0
    elif gs == "pending":
        pct = 0.0
    elif gs == "error":
        pct = 0.0
    elif total > 0:
        pct = max(0.0, min(99.0, float(done) / float(total) * 100.0))
    elif gs == "building":
        pct = 5.0
    else:
        pct = 0.0
    return {
        "document_id": doc_id,
        "graph_status": gs,
        "graph_error": doc.get("graph_error") or "",
        "phase": cp.get("phase") or gs,
        "done": done,
        "total": total,
        "progress_pct": round(pct, 1),
        "message": cp.get("message") or "",
        "job_status": (job or {}).get("status") or "",
    }


def enqueue_document(doc_id, force=False):
    """文档入库 ready 后入队；已有 pending/running 则跳过。"""
    doc = db.query_one("SELECT * FROM documents WHERE id=?", (doc_id,))
    if not doc or doc["status"] != "ready":
        return None
    if not force and doc.get("graph_status") in ("pending", "building"):
        return None
    active = db.query_one(
        "SELECT id FROM graph_jobs WHERE document_id=? AND status IN ('pending','running')",
        (doc_id,),
    )
    if active and not force:
        return active["id"]

    job_id = db.new_id()
    ts = _now()
    db.execute(
        "INSERT INTO graph_jobs(id,subject_id,document_id,status,attempt,max_attempt,error,"
        "checkpoint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (job_id, doc["subject_id"], doc_id, "pending", 0, 3, "", "", ts, ts),
    )
    db.execute(
        "UPDATE documents SET graph_status='pending', graph_error='' WHERE id=?",
        (doc_id,),
    )
    refresh_graph_meta(doc["subject_id"])
    threading.Thread(target=_run_job, args=(job_id,), daemon=True).start()
    return job_id


def _run_job(job_id):
    with _sem:
        job = db.query_one("SELECT * FROM graph_jobs WHERE id=?", (job_id,))
        if not job or job["status"] not in ("pending", "running"):
            return
        attempt = int(job["attempt"]) + 1
        db.execute(
            "UPDATE graph_jobs SET status='running', attempt=?, started_at=?, updated_at=?, error='' WHERE id=?",
            (attempt, _now(), _now(), job_id),
        )
        doc_id = job["document_id"]
        subject_id = job["subject_id"]
        try:
            if not db.query_one("SELECT id FROM documents WHERE id=?", (doc_id,)):
                db.execute(
                    "UPDATE graph_jobs SET status='done', finished_at=?, updated_at=?, error=? WHERE id=?",
                    (_now(), _now(), "document deleted", job_id),
                )
                return
            db.execute(
                "UPDATE documents SET graph_status='building', graph_error='' WHERE id=?",
                (doc_id,),
            )
            refresh_graph_meta(subject_id)
            _build_document_graph(doc_id, subject_id, job_id=job_id)
            if not db.query_one("SELECT id FROM documents WHERE id=?", (doc_id,)):
                purge_document_graph(doc_id)
                db.execute(
                    "UPDATE graph_jobs SET status='done', finished_at=?, updated_at=?, error=? WHERE id=?",
                    (_now(), _now(), "document deleted mid-build", job_id),
                )
                return
            bump_graph_version(subject_id)
            db.execute(
                "UPDATE documents SET graph_status='ready', graph_error='' WHERE id=?",
                (doc_id,),
            )
            db.execute(
                "UPDATE graph_jobs SET status='done', finished_at=?, updated_at=? WHERE id=?",
                (_now(), _now(), job_id),
            )
            refresh_graph_meta(subject_id)
        except Exception as e:
            msg = "{}: {}".format(type(e).__name__, e)
            msg = msg[:500]
            max_attempt = int(job.get("max_attempt") or 3)
            db.execute(
                "UPDATE graph_jobs SET status='failed', error=?, finished_at=?, updated_at=? WHERE id=?",
                (msg, _now(), _now(), job_id),
            )
            db.execute(
                "UPDATE documents SET graph_status='error', graph_error=? WHERE id=?",
                (msg, doc_id),
            )
            refresh_graph_meta(subject_id)
            if attempt < max_attempt:
                # 简单同步重试一次机会：重新入队（attempt 记在新 job）
                pass


def _write_job_checkpoint(job_id, phase, done, total, message=""):
    if not job_id:
        return
    payload = {
        "phase": phase,
        "done": int(done),
        "total": int(total),
        "message": message or "",
    }
    db.execute(
        "UPDATE graph_jobs SET checkpoint=?, updated_at=? WHERE id=?",
        (json.dumps(payload, ensure_ascii=False), _now(), job_id),
    )


def _build_document_graph(doc_id, subject_id, job_id=None):
    """幂等：清本文档旧 mentions/证据后重写规则实体与共现。"""
    # 清本文件旧 mentions，并收缩关系证据
    _write_job_checkpoint(job_id, "cleanup", 0, 1, "清理旧图谱数据")
    old_chunks = db.query("SELECT id FROM chunks WHERE document_id=?", (doc_id,))
    old_chunk_ids = set(c["id"] for c in old_chunks)
    db.execute("DELETE FROM entity_mentions WHERE document_id=?", (doc_id,))
    if old_chunk_ids:
        rels = db.query("SELECT id, evidence_json, weight FROM relations WHERE subject_id=?", (subject_id,))
        for r in rels:
            try:
                ev = json.loads(r["evidence_json"] or "[]")
            except (TypeError, ValueError):
                ev = []
            if not isinstance(ev, list):
                ev = []
            new_ev = [c for c in ev if c not in old_chunk_ids]
            if not new_ev:
                db.execute("DELETE FROM relations WHERE id=?", (r["id"],))
            elif len(new_ev) != len(ev):
                db.execute(
                    "UPDATE relations SET evidence_json=?, weight=? WHERE id=?",
                    (json.dumps(new_ev, ensure_ascii=False), float(len(new_ev)), r["id"]),
                )

    chunks = db.query(
        "SELECT id, seq, text FROM chunks WHERE document_id=? ORDER BY seq",
        (doc_id,),
    )
    if len(chunks) > _MAX_CHUNKS:
        chunks = chunks[:_MAX_CHUNKS]

    total_steps = max(len(chunks) * 2, 1)  # 抽取 + 共现 约两段
    # chunk_id -> [entity_id]
    chunk_entities = {}
    entity_cache = {}  # (norm, type) -> entity_id

    for i, ch in enumerate(chunks):
        text = ch["text"] or ""
        mentions = extract_rule_mentions(text)
        eids = []
        for name, etype, score in mentions:
            norm = _norm_name(name)
            if not norm:
                continue
            key = (norm, etype)
            if key in entity_cache:
                eid = entity_cache[key]
            else:
                eid = _entity_id(subject_id, norm, etype)
                existing = db.query_one("SELECT id, name FROM entities WHERE id=?", (eid,))
                if not existing:
                    db.execute(
                        "INSERT INTO entities(id,subject_id,name,norm_name,type,created_at) "
                        "VALUES(?,?,?,?,?,?)",
                        (eid, subject_id, name, norm, etype, _now()),
                    )
                entity_cache[key] = eid
            db.execute(
                "INSERT INTO entity_mentions(entity_id,chunk_id,document_id,subject_id,score,extractor) "
                "VALUES(?,?,?,?,?,?)",
                (eid, ch["id"], doc_id, subject_id, float(score), "rule"),
            )
            eids.append(eid)
        # 去重保序
        seen = set()
        uniq = []
        for e in eids:
            if e not in seen:
                seen.add(e)
                uniq.append(e)
        chunk_entities[ch["id"]] = uniq
        # 每 8 片或末片更新进度，避免过度写库
        if job_id and (i % 8 == 0 or i + 1 == len(chunks)):
            _write_job_checkpoint(
                job_id,
                "extract",
                i + 1,
                total_steps,
                "抽取实体 {}/{}".format(i + 1, len(chunks)),
            )

    # 共现：同 chunk 内两两 CO_OCCURS
    for i, ch in enumerate(chunks):
        eids = chunk_entities.get(ch["id"]) or []
        for a_i in range(len(eids)):
            for j in range(a_i + 1, len(eids)):
                a, b = eids[a_i], eids[j]
                if a == b:
                    continue
                src, dst = (a, b) if a < b else (b, a)
                _upsert_cooccur(subject_id, src, dst, ch["id"])
        if job_id and (i % 8 == 0 or i + 1 == len(chunks)):
            _write_job_checkpoint(
                job_id,
                "link",
                len(chunks) + i + 1,
                total_steps,
                "构建关系 {}/{}".format(i + 1, len(chunks)),
            )

    # 邻接 chunk 弱共现（weight 仍按证据条数）
    for idx in range(len(chunks) - 1):
        left = chunk_entities.get(chunks[idx]["id"]) or []
        right = chunk_entities.get(chunks[idx + 1]["id"]) or []
        if not left or not right:
            continue
        for a in left:
            for b in right:
                if a == b:
                    continue
                src, dst = (a, b) if a < b else (b, a)
                _upsert_cooccur(subject_id, src, dst, chunks[idx]["id"])

    # 清理无 mention 实体
    orphans = db.query(
        "SELECT e.id FROM entities e WHERE e.subject_id=? AND NOT EXISTS ("
        "SELECT 1 FROM entity_mentions m WHERE m.entity_id=e.id)",
        (subject_id,),
    )
    for e in orphans:
        db.execute("DELETE FROM relations WHERE src_entity_id=? OR dst_entity_id=?", (e["id"], e["id"]))
        db.execute("DELETE FROM entities WHERE id=?", (e["id"],))

    # 文档主题：用已抽取实体名做轻量标签（W2）；无实体则跳过
    _write_job_checkpoint(job_id, "classify", total_steps, total_steps, "生成主题标签")
    _assign_doc_topics_from_entities(doc_id, subject_id)
    _write_job_checkpoint(job_id, "done", total_steps, total_steps, "完成")


def _assign_doc_topics_from_entities(doc_id, subject_id):
    """把文档高频实体提升为 Topic（ABOUT），locked 主题名不覆盖。"""
    db.execute("DELETE FROM doc_topics WHERE document_id=?", (doc_id,))
    rows = db.query(
        "SELECT e.id, e.name, COUNT(*) AS c FROM entity_mentions m "
        "JOIN entities e ON e.id=m.entity_id "
        "WHERE m.document_id=? GROUP BY e.id ORDER BY c DESC LIMIT 8",
        (doc_id,),
    )
    if not rows:
        return
    for r in rows[:5]:
        name = (r["name"] or "").strip()
        if not name:
            continue
        norm = _norm_name(name)
        topic = db.query_one(
            "SELECT id, locked, name FROM topics WHERE subject_id=? AND lower(name)=? LIMIT 1",
            (subject_id, norm),
        )
        if not topic:
            # 模糊：同 norm 已有实体名主题
            topic = db.query_one(
                "SELECT id, locked, name FROM topics WHERE subject_id=? AND name=?",
                (subject_id, name),
            )
        if topic:
            tid = topic["id"]
        else:
            tid = db.new_id()
            db.execute(
                "INSERT INTO topics(id,subject_id,name,locked,created_at) VALUES(?,?,?,?,?)",
                (tid, subject_id, name, 0, _now()),
            )
        score = min(1.0, 0.35 + 0.1 * float(r["c"]))
        db.execute(
            "INSERT OR REPLACE INTO doc_topics(document_id,topic_id,score) VALUES(?,?,?)",
            (doc_id, tid, score),
        )


def build_graph_view(subject_id, seed_entity_id=None, depth=1, limit=200):
    """返回前端 vis-network 可用的 nodes/edges；depth 最大 2，节点数截断 limit。

    无种子时按 mention 数取核心实体，并优先保留两端都在集合内的高权重边。
    """
    depth = 1 if depth is None else int(depth)
    if depth < 1:
        depth = 1
    if depth > 2:
        depth = 2
    limit = int(limit or 200)
    if limit < 1:
        limit = 1
    # 个人库可视化上限：过大易卡 UI；1000 足够浏览核心子图
    if limit > 1000:
        limit = 1000

    entities = db.query(
        "SELECT e.*, (SELECT COUNT(*) FROM entity_mentions m WHERE m.entity_id=e.id) AS mentions "
        "FROM entities e WHERE e.subject_id=?",
        (subject_id,),
    )
    if not entities:
        return {"nodes": [], "edges": [], "truncated": False, "seed": seed_entity_id}

    by_id = {e["id"]: e for e in entities}
    # 只拉必要列，大图时减少 IO
    rels = db.query(
        "SELECT id, src_entity_id, dst_entity_id, rel_type, weight FROM relations "
        "WHERE subject_id=? ORDER BY weight DESC LIMIT 20000",
        (subject_id,),
    )

    if seed_entity_id and seed_entity_id in by_id:
        keep = set([seed_entity_id])
        frontier = set([seed_entity_id])
        for _ in range(depth):
            nxt = set()
            for r in rels:
                if r["src_entity_id"] in frontier and r["dst_entity_id"] in by_id:
                    nxt.add(r["dst_entity_id"])
                if r["dst_entity_id"] in frontier and r["src_entity_id"] in by_id:
                    nxt.add(r["src_entity_id"])
            keep |= nxt
            frontier = nxt
        chosen = [by_id[i] for i in keep if i in by_id]
        chosen = sorted(chosen, key=lambda e: (-int(e["mentions"] or 0), e["name"]))
    else:
        chosen = sorted(entities, key=lambda e: (-int(e["mentions"] or 0), e["name"]))

    truncated = len(chosen) > limit
    chosen = chosen[:limit]
    keep_ids = set(e["id"] for e in chosen)

    nodes = []
    for e in chosen:
        nodes.append(
            {
                "id": e["id"],
                "label": e["name"],
                "type": e["type"],
                "mentions": int(e["mentions"] or 0),
                "group": e["type"] or "Term",
            }
        )

    # 边：两端都在节点集内，按 weight 截断（随节点上限放宽）
    edge_limit = min(limit * 4, 4000)
    edges = []
    for r in rels:
        if r["src_entity_id"] in keep_ids and r["dst_entity_id"] in keep_ids:
            if r["src_entity_id"] == r["dst_entity_id"]:
                continue
            edges.append(
                {
                    "id": r["id"],
                    "from": r["src_entity_id"],
                    "to": r["dst_entity_id"],
                    "label": r["rel_type"],
                    "weight": float(r["weight"] or 1),
                }
            )
            if len(edges) >= edge_limit:
                truncated = True
                break

    return {
        "nodes": nodes,
        "edges": edges,
        "truncated": truncated,
        "seed": seed_entity_id,
        "depth": depth,
        "limit": limit,
    }


def entity_sources(entity_id, limit=8):
    """实体回源：关联 chunk 摘要。"""
    limit = int(limit or 8)
    rows = db.query(
        "SELECT m.chunk_id, m.score, c.text, c.location, c.document_id, d.filename "
        "FROM entity_mentions m "
        "JOIN chunks c ON c.id=m.chunk_id "
        "JOIN documents d ON d.id=c.document_id "
        "WHERE m.entity_id=? ORDER BY m.score DESC, m.id DESC LIMIT ?",
        (entity_id, limit),
    )
    out = []
    for r in rows:
        text = r["text"] or ""
        out.append(
            {
                "chunk_id": r["chunk_id"],
                "document_id": r["document_id"],
                "doc_name": r["filename"],
                "location": r["location"],
                "score": float(r["score"] or 0),
                "text": text[:400],
            }
        )
    return out


def list_topics(subject_id):
    rows = db.query(
        "SELECT t.*, (SELECT COUNT(*) FROM doc_topics dt WHERE dt.topic_id=t.id) AS doc_count "
        "FROM topics t WHERE t.subject_id=? ORDER BY doc_count DESC, t.name",
        (subject_id,),
    )
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "locked": bool(r["locked"]),
            "doc_count": int(r["doc_count"] or 0),
        }
        for r in rows
    ]


def documents_for_topic(subject_id, topic_id):
    topic = db.query_one(
        "SELECT * FROM topics WHERE id=? AND subject_id=?", (topic_id, subject_id)
    )
    if not topic:
        return None
    rows = db.query(
        "SELECT d.*, dt.score AS topic_score FROM doc_topics dt "
        "JOIN documents d ON d.id=dt.document_id "
        "WHERE dt.topic_id=? AND d.subject_id=? ORDER BY dt.score DESC, d.created_at DESC",
        (topic_id, subject_id),
    )
    return rows


def rename_topic(topic_id, name, locked=None):
    topic = db.query_one("SELECT * FROM topics WHERE id=?", (topic_id,))
    if not topic:
        return None
    name = (name or "").strip()
    fields = []
    args = []
    if name:
        fields.append("name=?")
        args.append(name[:60])
        fields.append("locked=1")  # 用户改名即锁定
    if locked is not None:
        fields.append("locked=?")
        args.append(1 if locked else 0)
    if not fields:
        return topic
    args.append(topic_id)
    db.execute("UPDATE topics SET {} WHERE id=?".format(", ".join(fields)), args)
    return db.query_one("SELECT * FROM topics WHERE id=?", (topic_id,))


def _upsert_cooccur(subject_id, src, dst, chunk_id):
    rid = hashlib.sha1(
        "{}|{}|{}|CO_OCCURS".format(subject_id, src, dst).encode("utf-8")
    ).hexdigest()[:16]
    row = db.query_one("SELECT id, evidence_json FROM relations WHERE id=?", (rid,))
    if not row:
        # 可能 id 算法一致但先查 unique
        row = db.query_one(
            "SELECT id, evidence_json FROM relations WHERE subject_id=? AND src_entity_id=? "
            "AND dst_entity_id=? AND rel_type='CO_OCCURS'",
            (subject_id, src, dst),
        )
    if row:
        try:
            ev = json.loads(row["evidence_json"] or "[]")
        except (TypeError, ValueError):
            ev = []
        if not isinstance(ev, list):
            ev = []
        if chunk_id not in ev:
            ev.append(chunk_id)
        db.execute(
            "UPDATE relations SET evidence_json=?, weight=? WHERE id=?",
            (json.dumps(ev, ensure_ascii=False), float(len(ev)), row["id"]),
        )
    else:
        db.execute(
            "INSERT INTO relations(id,subject_id,src_entity_id,dst_entity_id,rel_type,weight,evidence_json,created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (
                rid,
                subject_id,
                src,
                dst,
                "CO_OCCURS",
                1.0,
                json.dumps([chunk_id], ensure_ascii=False),
                _now(),
            ),
        )


def process_document_graph_sync(doc_id):
    """测试/同步路径：直接建图，不走线程。"""
    doc = db.query_one("SELECT * FROM documents WHERE id=?", (doc_id,))
    if not doc:
        raise ValueError("document not found")
    if doc["status"] != "ready":
        raise ValueError("document not ready")
    db.execute(
        "UPDATE documents SET graph_status='building', graph_error='' WHERE id=?",
        (doc_id,),
    )
    try:
        _build_document_graph(doc_id, doc["subject_id"], job_id=None)
        bump_graph_version(doc["subject_id"])
        db.execute(
            "UPDATE documents SET graph_status='ready', graph_error='' WHERE id=?",
            (doc_id,),
        )
        refresh_graph_meta(doc["subject_id"])
    except Exception as e:
        msg = "{}: {}".format(type(e).__name__, e)[:500]
        db.execute(
            "UPDATE documents SET graph_status='error', graph_error=? WHERE id=?",
            (msg, doc_id),
        )
        refresh_graph_meta(doc["subject_id"])
        raise
