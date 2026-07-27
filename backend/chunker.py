"""中文友好的文本切片：按句子边界聚合到目标长度，块间保留少量重叠。"""
import re

_SENT_RE = re.compile(r"[^。！？!?；;\n]*[。！？!?；;\n]+|[^。！？!?；;\n]+$")


def _split_sentences(text):
    return [s for s in _SENT_RE.findall(text) if s.strip()]


def chunk_text(text, target=500, overlap=100):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        return []

    sents = []
    for s in _split_sentences(text):
        # 超长"句子"（如无标点的表格文本）硬切，避免单块过大
        while len(s) > target * 2:
            sents.append(s[:target])
            s = s[target:]
        sents.append(s)

    chunks = []
    cur = []
    cur_len = 0
    for s in sents:
        if cur and cur_len + len(s) > target:
            chunks.append("".join(cur).strip())
            tail = []
            tail_len = 0
            for t in reversed(cur):
                if tail_len + len(t) > overlap:
                    break
                tail.insert(0, t)
                tail_len += len(t)
            cur = tail
            cur_len = tail_len
        cur.append(s)
        cur_len += len(s)
    if cur:
        chunks.append("".join(cur).strip())

    return [c for c in chunks if len(c) >= 10]
