"""OpenAI 兼容 API 客户端：模型列表 / 向量化 / 流式与非流式对话。

用户填 Base URL 时经常漏掉 /v1（如填 https://api.deepseek.com），
这里在请求 404/返回非 JSON 时自动用 `<base>/v1` 重试一次，并缓存可用的地址。
"""
import json
import re
import threading

import httpx


class LLMError(Exception):
    def __init__(self, message, status=None, parse_error=False):
        super().__init__(message)
        self.status = status
        self.parse_error = parse_error


_base_cache = {}  # 原始 base -> 验证可用的 base
_cache_lock = threading.Lock()


def _base(url):
    return (url or "").strip().rstrip("/")


def _base_candidates(base_url):
    base = _base(base_url)
    with _cache_lock:
        cached = _base_cache.get(base)
    cands = []
    if cached:
        cands.append(cached)
    if base not in cands:
        cands.append(base)
    # 结尾不是 /v1、/v4 这类版本段时，补一个 /v1 的备选
    if not re.search(r"/v\d+[a-z]*$", base):
        alt = base + "/v1"
        if alt not in cands:
            cands.append(alt)
    return cands


def _remember_base(base_url, working):
    with _cache_lock:
        _base_cache[_base(base_url)] = working


def _retryable(e):
    return isinstance(e, LLMError) and (e.status in (404, 405) or e.parse_error)


def _with_fallback(base_url, fn):
    """依次尝试候选 base，404/非 JSON 时换下一个；成功则记住可用地址。"""
    cands = _base_candidates(base_url)
    last = None
    for i, b in enumerate(cands):
        try:
            result = fn(b)
            _remember_base(base_url, b)
            return result
        except LLMError as e:
            last = e
            if not _retryable(e) or i == len(cands) - 1:
                raise
    raise last


def _headers(api_key):
    h = {"Content-Type": "application/json"}
    if api_key:
        h["Authorization"] = "Bearer " + api_key
    return h


def _err_detail(resp):
    try:
        data = resp.json()
        err = data.get("error")
        if isinstance(err, dict) and err.get("message"):
            return err["message"]
        if isinstance(err, str):
            return err
        return data.get("message") or data.get("msg") or resp.text[:300]
    except Exception:
        return resp.text[:300]


def _json_of(resp, what):
    try:
        return resp.json()
    except Exception:
        raise LLMError(
            "{}接口返回的不是有效 JSON，请检查 Base URL 是否正确".format(what),
            parse_error=True,
        )


# ---------- 模型列表 ----------

def _list_models_at(base, api_key):
    url = base + "/models"
    try:
        resp = httpx.get(url, headers=_headers(api_key), timeout=20)
    except httpx.HTTPError as e:
        raise LLMError("无法连接 {}：{}".format(url, e))
    if resp.status_code != 200:
        raise LLMError(
            "获取模型列表失败 (HTTP {})：{}".format(resp.status_code, _err_detail(resp)),
            status=resp.status_code,
        )
    data = _json_of(resp, "模型列表")
    items = data.get("data") or data.get("models") or []
    ids = []
    for m in items:
        if isinstance(m, dict):
            mid = m.get("id") or m.get("name")
            if mid:
                ids.append(str(mid))
        elif isinstance(m, str):
            ids.append(m)
    return sorted(set(ids))


def list_models(base_url, api_key):
    return _with_fallback(base_url, lambda b: _list_models_at(b, api_key))


# ---------- 向量化 ----------

def _embed_at(base, api_key, model, texts, batch_size):
    out = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        try:
            resp = httpx.post(
                base + "/embeddings",
                headers=_headers(api_key),
                json={"model": model, "input": batch},
                timeout=120,
            )
        except httpx.HTTPError as e:
            raise LLMError("向量化请求失败：{}".format(e))
        if resp.status_code != 200:
            raise LLMError(
                "向量化失败 (HTTP {})：{}".format(resp.status_code, _err_detail(resp)),
                status=resp.status_code,
            )
        data = _json_of(resp, "向量化").get("data") or []
        if len(data) != len(batch):
            raise LLMError("向量化接口返回数量与请求不一致")
        data.sort(key=lambda d: d.get("index", 0))
        for d in data:
            emb = d.get("embedding")
            if not isinstance(emb, list) or not emb:
                raise LLMError("向量化接口返回了空向量")
            out.append(emb)
    return out


def embed_texts(base_url, api_key, model, texts, batch_size=16):
    if base_url == "local":  # 内置本地向量模型
        from .local_embed import LocalEmbedError, embed_texts as _local

        try:
            return _local(model, texts)
        except LocalEmbedError as e:
            raise LLMError(str(e))
    return _with_fallback(
        base_url, lambda b: _embed_at(b, api_key, model, texts, batch_size)
    )


# ---------- 对话 ----------

def _chat_stream_at(base, api_key, model, messages, temperature):
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": temperature,
    }
    try:
        with httpx.stream(
            "POST",
            base + "/chat/completions",
            headers=_headers(api_key),
            json=payload,
            timeout=httpx.Timeout(30, read=300),
        ) as resp:
            if resp.status_code != 200:
                resp.read()
                raise LLMError(
                    "对话请求失败 (HTTP {})：{}".format(resp.status_code, _err_detail(resp)),
                    status=resp.status_code,
                )
            saw_sse = False
            raw = []  # 未见到 SSE 帧时缓存原始返回体，便于判断真实格式
            raw_len = 0
            for line in resp.iter_lines():
                line = line.strip()
                if not line.startswith("data:"):
                    if not saw_sse and raw_len < 200000:
                        raw.append(line)
                        raw_len += len(line)
                    continue
                saw_sse = True
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                for ch in obj.get("choices") or []:
                    delta = ch.get("delta") or {}
                    # 推理模型（grok/deepseek-r1 等）先输出思考过程
                    rc = delta.get("reasoning_content") or delta.get("reasoning")
                    if rc:
                        yield ("reasoning", rc)
                    c = delta.get("content")
                    if c:
                        yield ("content", c)
            if not saw_sse:
                # HTTP 200 但没有任何 SSE 帧：可能是不支持流式的 JSON 回复，或路径错误返回了网页
                body = "\n".join(raw).strip()
                try:
                    obj = json.loads(body)
                    msg = (obj.get("choices") or [{}])[0].get("message") or {}
                    content = msg.get("content") or msg.get("reasoning_content") or ""
                    if content:
                        yield ("content", content)
                        return
                except (ValueError, AttributeError, IndexError):
                    pass
                raise LLMError(
                    "对话接口返回的不是流式数据（可能是 Base URL 路径不对）",
                    parse_error=True,
                )
    except httpx.HTTPError as e:
        raise LLMError("对话请求失败：{}".format(e))


def chat_stream(base_url, api_key, model, messages, temperature=0.7):
    """产出 (kind, text) 元组，kind 为 'content' 或 'reasoning'。"""
    cands = _base_candidates(base_url)
    for i, b in enumerate(cands):
        yielded = False
        try:
            for delta in _chat_stream_at(b, api_key, model, messages, temperature):
                if not yielded:
                    yielded = True
                    _remember_base(base_url, b)
                yield delta
            if yielded:
                return
            # 流结束但一个字都没有：视为该地址不可用，换下一个候选
            raise LLMError("模型返回了空的流式响应", parse_error=True)
        except LLMError as e:
            # 已经吐过内容或不是路径类错误就直接抛；否则换下一个候选地址
            if yielded or not _retryable(e) or i == len(cands) - 1:
                raise


def _chat_once_at(base, api_key, model, messages, temperature):
    try:
        resp = httpx.post(
            base + "/chat/completions",
            headers=_headers(api_key),
            json={"model": model, "messages": messages, "temperature": temperature, "stream": False},
            timeout=60,
        )
    except httpx.HTTPError as e:
        raise LLMError("对话请求失败：{}".format(e))
    if resp.status_code != 200:
        raise LLMError(
            "对话请求失败 (HTTP {})：{}".format(resp.status_code, _err_detail(resp)),
            status=resp.status_code,
        )
    try:
        msg = _json_of(resp, "对话")["choices"][0]["message"]
        # 推理模型可能只有 reasoning_content
        return msg.get("content") or msg.get("reasoning_content") or msg.get("reasoning") or ""
    except LLMError:
        raise
    except Exception:
        raise LLMError("对话接口返回格式异常")


def chat_once(base_url, api_key, model, messages, temperature=0.7):
    return _with_fallback(
        base_url, lambda b: _chat_once_at(b, api_key, model, messages, temperature)
    )
