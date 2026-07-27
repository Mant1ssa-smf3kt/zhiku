"""模型配置解析 + 基于 numpy 余弦相似度的向量检索。"""
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


def search_subject(subject, query_text, top_k=None):
    """返回 (results, warning)。未配置向量模型时抛 ValueError。"""
    cfg = resolve_embed(subject)
    if not cfg:
        raise ValueError("尚未配置向量化（Embedding）模型，请先在「全局设置」或「科目设置」中配置")
    top_k = int(top_k or subject.get("top_k") or 5)

    qv = np.asarray(embed_texts(cfg[0], cfg[1], cfg[2], [query_text])[0], dtype=np.float32)

    rows = db.query(
        "SELECT c.id, c.document_id, c.seq, c.location, c.text, c.embedding, c.dim, d.filename "
        "FROM chunks c JOIN documents d ON d.id = c.document_id "
        "WHERE c.subject_id=? AND c.embedding IS NOT NULL",
        (subject["id"],),
    )
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
    scores = mn @ qn
    order = np.argsort(-scores)[:top_k]

    results = []
    for i in order:
        r = usable[int(i)]
        results.append(
            {
                "chunk_id": r["id"],
                "document_id": r["document_id"],
                "doc_name": r["filename"],
                "location": r["location"],
                "seq": r["seq"],
                "text": r["text"],
                "score": round(float(scores[int(i)]), 4),
            }
        )
    return results, warning
