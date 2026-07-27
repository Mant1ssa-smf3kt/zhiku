"""内置本地向量模型（fastembed / ONNX CPU 推理）。

- 按需加载：首次调用才加载模型进内存（首次使用会自动下载模型文件）
- 闲置释放：超过 10 分钟没有向量化请求自动卸载，释放内存
- 模型缓存在 data/models/ 下，跟随应用数据
"""
import os
import threading
import time
import traceback

from . import database as db

# huggingface_hub 在导入时就固定了端点，必须在首次 import fastembed 之前设置；
# 默认走国内可达的镜像（用户自己设置过 HF_ENDPOINT 则尊重用户配置）
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

LOCAL_PROVIDER_ID = "local"
DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5"  # 中文优化，512 维，约 100MB
MODELS_DIR = os.path.join(db.DATA_DIR, "models")
IDLE_UNLOAD_SECONDS = 600

_lock = threading.Lock()
_model = None
_model_name = None
_last_used = 0.0
_watcher_started = False


class LocalEmbedError(Exception):
    pass


def available():
    try:
        import fastembed  # noqa: F401

        return True
    except ImportError:
        return False


def model_cached(name=None):
    name = name or DEFAULT_MODEL
    if not os.path.isdir(MODELS_DIR):
        return False
    key = name.split("/")[-1].lower()
    for root, dirs, files in os.walk(MODELS_DIR):
        if key in root.lower() and any(f.endswith(".onnx") for f in files):
            return True
    return False


def loaded():
    return _model is not None


def _watch_idle():
    global _model, _model_name
    while True:
        time.sleep(60)
        with _lock:
            if _model is not None and time.time() - _last_used > IDLE_UNLOAD_SECONDS:
                _model = None
                _model_name = None


def _ensure_model(name):
    global _model, _model_name, _last_used, _watcher_started
    if _model is not None and _model_name == name:
        return _model
    try:
        from fastembed import TextEmbedding
    except ImportError:
        raise LocalEmbedError(
            "本地向量模型组件未安装：请在项目目录执行 .venv/bin/pip install fastembed 后重启应用"
        )
    os.makedirs(MODELS_DIR, exist_ok=True)

    cached = model_cached(name)
    model = None
    errors = []
    if cached:
        # 缓存已存在时完全离线加载，不做任何联网校验（网络抖动不应影响已下载的模型）
        try:
            model = TextEmbedding(model_name=name, cache_dir=MODELS_DIR, local_files_only=True)
        except Exception as e:
            traceback.print_exc()
            errors.append("离线加载失败：{}".format(e))
    if model is None:
        try:
            model = TextEmbedding(model_name=name, cache_dir=MODELS_DIR)
        except Exception as e:
            traceback.print_exc()
            errors.append(str(e))
            raise LocalEmbedError(
                "本地模型加载失败：{}。{}".format(
                    "；".join(errors),
                    "模型已缓存但无法读取，可删除 data/models 目录后重试" if cached
                    else "首次使用需联网下载约 100MB 模型文件，如网络受限可设置 "
                         "HF_ENDPOINT 环境变量指向可用镜像",
                )
            )
    _model = model
    _model_name = name
    _last_used = time.time()
    if not _watcher_started:
        _watcher_started = True
        threading.Thread(target=_watch_idle, daemon=True).start()
    return _model


def embed_texts(model_name, texts):
    """与 llm.embed_texts 返回格式一致：list[list[float]]。"""
    global _last_used
    name = model_name or DEFAULT_MODEL
    if name == LOCAL_PROVIDER_ID:  # 防御：模型名被误填成 "local"
        name = DEFAULT_MODEL
    with _lock:
        m = _ensure_model(name)
        _last_used = time.time()
        try:
            return [v.tolist() for v in m.embed(list(texts), batch_size=16)]
        except Exception as e:
            raise LocalEmbedError("本地向量化失败：{}".format(e))
