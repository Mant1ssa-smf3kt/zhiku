"""模型配置解析 + 基于 numpy 余弦相似度的向量检索（可选图谱加成）。"""
import numpy as np

from . import database as db
from .llm import embed_texts


def _resolve(subject, kind):
    """kind: 'embed' | 'chat' -> (base_url, api_key, model) 或 None"""
    pid = subject.get(kind + "_provider_id")
    model = subject.get(kind + "_model")
    if not pid or not model:
        pid = db.get_setting("default_{}_provider_id".format(kind))
        model = db.get_setting("default_{}_model".format(kind))
    if not pid or not model:
        return None
    if pid == "local":  # 内置本地向量模型（仅限 embedding）
        return ("local", "", model) if kind == "embed" else None
    p = db.query_one("SELECT * FROM providers WHERE id=?", (pid,))
    if not p:
        return None
    return (p["base_url"], p["api_key"], model)


def resolve_embed(subject):
    return _resolve(subject, "embed")


def resolve_chat(subject):
    return _resolve(subject, "chat")


def _match_entities(subject_id, query_text):
    """问题中命中的实体（规范化子串 / 原名子串）。"""
    q = (query_text or "").strip()
    if not q:
        return []
    q_lower = q.lower()
    entities = db.query(
        "SELECT id, name, norm_name FROM entities WHERE subject_id=?", (subject_id,)
    )
    hits = []
    for e in entities:
        name = e["name"] or ""
        norm = e["norm_name"] or ""
        if name and name in q:
            hits.append(e["id"])
        elif norm and len(norm) >= 2 and norm in q_lower:
            hits.append(e["id"])
    return list(dict.fromkeys(hits))


def _graph_boost_chunk_ids(subject_id, entity_ids):
    """实体及其 1 跳邻居关联的 chunk_id 集合。"""
    if not entity_ids:
        return set()
    expand = set(entity_ids)
    placeholders = ",".join("?" * len(entity_ids))
    rels = db.query(
        "SELECT src_entity_id, dst_entity_id FROM relations WHERE subject_id=? AND "
        "(src_entity_id IN ({0}) OR dst_entity_id IN ({0}))".format(placeholders),
        tuple([subject_id] + list(entity_ids) + list(entity_ids)),
    )
    for r in rels:
        expand.add(r["src_entity_id"])
        expand.add(r["dst_entity_id"])
    expand = list(expand)
    ph = ",".join("?" * len(expand))
    mentions = db.query(
        "SELECT chunk_id FROM entity_mentions WHERE subject_id=? AND entity_id IN ({})".format(ph),
        tuple([subject_id] + expand),
    )
    return set(m["chunk_id"] for m in mentions)


def search_subject(subject, query_text, top_k=None, use_graph=True, topic_id=None):
    """返回 (results, warning)。未配置向量模型时抛 ValueError。

    use_graph=True 时：扩大向量候选并用实体邻域 chunk 做线性加分，无图则等价纯向量。
    """
    cfg = resolve_embed(subject)
    if not cfg:
        raise ValueError("尚未配置向量化（Embedding）模型，请先在「全局设置」或「科目设置」中配置")
    top_k = int(top_k or subject.get("top_k") or 5)

    qv = np.asarray(embed_texts(cfg[0], cfg[1], cfg[2], [query_text])[0], dtype=np.float32)

    sql = (
        "SELECT c.id, c.document_id, c.seq, c.location, c.text, c.embedding, c.dim, d.filename "
        "FROM chunks c JOIN documents d ON d.id = c.document_id "
        "WHERE c.subject_id=? AND c.embedding IS NOT NULL"
    )
    args = [subject["id"]]
    if topic_id:
        sql += (
            " AND c.document_id IN (SELECT document_id FROM doc_topics WHERE topic_id=?)"
        )
        args.append(topic_id)

    rows = db.query(sql, tuple(args))
    if not rows:
        return [], None

    dim = int(qv.shape[0])
    usable = [r for r in rows if r["dim"] == dim]
    warning = None
    if not usable:
        return [], "资料库向量维度与当前向量模型不一致，请在「科目设置」中重建索引"
    if len(usable) < len(rows):
        warning = "部分资料的向量与当前模型维度不一致已被忽略，建议在「科目设置」中重建索引"

    mat = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in usable])
    qn = qv / (np.linalg.norm(qv) + 1e-8)
    mn = mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-8)
    vec_scores = mn @ qn

    graph_boost = {}
    entity_ids = []
    if use_graph:
        flag = db.get_setting("graph_enabled")
        if flag is None or flag == "" or flag == "1":
            try:
                entity_ids = _match_entities(subject["id"], query_text)
                boosted = _graph_boost_chunk_ids(subject["id"], entity_ids)
                for cid in boosted:
                    graph_boost[cid] = 1.0
            except Exception:
                graph_boost = {}

    alpha, beta = 0.75, 0.25
    if not graph_boost:
        alpha, beta = 1.0, 0.0

    cand_n = max(top_k * 3, 15)
    cand_n = min(cand_n, len(usable))
    order_vec = np.argsort(-vec_scores)[:cand_n]

    scored = []
    for i in order_vec:
        r = usable[int(i)]
        vs = float(vec_scores[int(i)])
        gb = graph_boost.get(r["id"], 0.0)
        final = alpha * vs + beta * gb
        scored.append((final, vs, gb, r))
    scored.sort(key=lambda x: -x[0])

    results = []
    for final, vs, gb, r in scored[:top_k]:
        results.append(
            {
                "chunk_id": r["id"],
                "document_id": r["document_id"],
                "doc_name": r["filename"],
                "location": r["location"],
                "seq": r["seq"],
                "text": r["text"],
                "score": round(float(final), 4),
                "vec_score": round(float(vs), 4),
                "graph_boost": round(float(gb), 4),
                "entity_ids": entity_ids if gb else [],
            }
        )
    return results, warning
