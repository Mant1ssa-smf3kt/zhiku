"""空书桌首次启动时导入仓库自带的 Hello_agent 示例科目。

只在「还没有任何科目」时跑一次。不碰服务商、密钥、对话；资料来自
samples/hello-agent/，复制进 data/files/ 后再走正规入库管线。
"""
import os
import shutil
import threading

from . import database as db

SAMPLE_DIR = os.path.join(db.BASE_DIR, "samples", "hello-agent")
SAMPLE_FILE = "Hello-Agents.md"
SEED_FLAG = "sample_hello_agent_seeded"
SUBJECT_NAME = "Hello_agent"
SUBJECT_DESC = "零基础学习 agent"
SUBJECT_COLOR = "#8a3a28"
SUBJECT_ICON = "Ag"


def maybe_seed_hello_agent():
    """有科目、已记过导入、或缺文件时直接返回。"""
    if db.get_setting(SEED_FLAG):
        return False
    if db.query_one("SELECT id FROM subjects LIMIT 1"):
        db.set_setting(SEED_FLAG, "skipped")
        return False
    src = os.path.join(SAMPLE_DIR, SAMPLE_FILE)
    if not os.path.isfile(src):
        return False

    sid = db.new_id()
    doc_id = db.new_id()
    dest = os.path.join(db.FILES_DIR, doc_id + ".md")
    os.makedirs(db.FILES_DIR, exist_ok=True)
    shutil.copy2(src, dest)
    size = os.path.getsize(dest)
    ts = db.now()
    db.execute(
        "INSERT INTO subjects(id,name,color,icon,description,created_at) VALUES(?,?,?,?,?,?)",
        (sid, SUBJECT_NAME, SUBJECT_COLOR, SUBJECT_ICON, SUBJECT_DESC, ts),
    )
    db.execute(
        "INSERT INTO documents(id,subject_id,filename,filetype,size,status,"
        "error,chunk_count,total_chunks,processed_chunks,file_path,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            doc_id, sid, SAMPLE_FILE, "md", size, "processing",
            "", 0, 0, 0, dest, ts,
        ),
    )
    db.set_setting(SEED_FLAG, "1")

    def _ingest():
        from .ingest import process_document_async

        process_document_async(doc_id)

    threading.Thread(target=_ingest, daemon=True).start()
    return True
