import os
import tempfile
import time
import unittest


class GraphPipeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._data_dir = tempfile.TemporaryDirectory()
        os.environ["RAG_DATA_DIR"] = cls._data_dir.name

        from backend import database as db

        if db._conn is not None:
            db._conn.close()
            db._conn = None
        db.get_conn()
        cls.db = db

    @classmethod
    def tearDownClass(cls):
        from backend import database as db

        if db._conn is not None:
            db._conn.close()
            db._conn = None
        os.environ.pop("RAG_DATA_DIR", None)
        cls._data_dir.cleanup()

    def setUp(self):
        db = self.db
        for table in (
            "entity_mentions",
            "relations",
            "entities",
            "doc_topics",
            "topics",
            "graph_jobs",
            "graph_meta",
            "chunks",
            "documents",
            "subjects",
        ):
            db.execute("DELETE FROM {}".format(table))

    def _seed_ready_doc(self, text_chunks):
        db = self.db
        sid = db.new_id()
        doc_id = db.new_id()
        db.execute(
            "INSERT INTO subjects(id,name,color,icon,description,system_prompt,top_k,created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (sid, "图测", "#4F5BD5", "📚", "", "", 5, db.now()),
        )
        db.execute(
            "INSERT INTO documents(id,subject_id,filename,filetype,size,status,error,"
            "chunk_count,total_chunks,processed_chunks,file_path,created_at,graph_status,graph_error) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                doc_id,
                sid,
                "demo.txt",
                "txt",
                10,
                "ready",
                "",
                len(text_chunks),
                len(text_chunks),
                len(text_chunks),
                "",
                db.now(),
                "none",
                "",
            ),
        )
        for i, text in enumerate(text_chunks):
            db.execute(
                "INSERT INTO chunks(document_id,subject_id,seq,location,text,embedding,dim) "
                "VALUES(?,?,?,?,?,?,?)",
                (doc_id, sid, i, "p{}".format(i + 1), text, None, 0),
            )
        return sid, doc_id

    def test_rule_extract_grounds_to_text(self):
        from backend.graph_pipe import extract_rule_mentions

        mentions = extract_rule_mentions("本章介绍《概率论》与「贝叶斯定理」以及 Bayes Rule。")
        names = {m[0] for m in mentions}
        self.assertIn("概率论", names)
        self.assertIn("贝叶斯定理", names)
        self.assertIn("Bayes Rule", names)
        # 未出现在原文的不得抽出
        self.assertTrue(all(n in "本章介绍《概率论》与「贝叶斯定理」以及 Bayes Rule。" for n, _, _ in mentions))

    def test_sync_build_sets_ready_and_cooccur(self):
        from backend.graph_pipe import get_graph_status, process_document_graph_sync

        sid, doc_id = self._seed_ready_doc(
            [
                "学习《线性代数》与「特征值」。",
                "继续讨论「特征值」与《线性代数》应用。",
            ]
        )
        process_document_graph_sync(doc_id)
        doc = self.db.query_one("SELECT graph_status FROM documents WHERE id=?", (doc_id,))
        self.assertEqual(doc["graph_status"], "ready")
        ents = self.db.query("SELECT name FROM entities WHERE subject_id=?", (sid,))
        self.assertTrue(any(e["name"] in ("线性代数", "特征值") for e in ents))
        rels = self.db.query(
            "SELECT * FROM relations WHERE subject_id=? AND rel_type='CO_OCCURS'", (sid,)
        )
        self.assertGreaterEqual(len(rels), 1)
        meta = get_graph_status(sid)
        self.assertEqual(meta["status"], "ready")
        self.assertGreaterEqual(meta["version"], 1)
        self.assertGreaterEqual(meta["entity_count"], 1)

    def test_delete_document_purges_mentions(self):
        from backend.graph_pipe import process_document_graph_sync, purge_document_graph

        sid, doc_id = self._seed_ready_doc(["《操作系统》中的「进程」概念。"])
        process_document_graph_sync(doc_id)
        self.assertGreater(
            self.db.query_one("SELECT COUNT(*) AS n FROM entity_mentions WHERE document_id=?", (doc_id,))["n"],
            0,
        )
        purge_document_graph(doc_id)
        self.db.execute("DELETE FROM chunks WHERE document_id=?", (doc_id,))
        self.db.execute("DELETE FROM documents WHERE id=?", (doc_id,))
        self.assertEqual(
            self.db.query_one("SELECT COUNT(*) AS n FROM entity_mentions WHERE document_id=?", (doc_id,))["n"],
            0,
        )
        # 无 mention 的实体应被清掉
        self.assertEqual(
            self.db.query_one("SELECT COUNT(*) AS n FROM entities WHERE subject_id=?", (sid,))["n"],
            0,
        )

    def test_enqueue_async_reaches_ready(self):
        from backend.graph_pipe import enqueue_document

        _sid, doc_id = self._seed_ready_doc(["阅读《编译原理》了解「词法分析」。"])
        job_id = enqueue_document(doc_id)
        self.assertIsNotNone(job_id)
        deadline = time.time() + 5
        status = None
        while time.time() < deadline:
            status = self.db.query_one("SELECT graph_status FROM documents WHERE id=?", (doc_id,))[
                "graph_status"
            ]
            if status == "ready":
                break
            time.sleep(0.05)
        self.assertEqual(status, "ready")


class GraphApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._data_dir = tempfile.TemporaryDirectory()
        os.environ["RAG_DATA_DIR"] = cls._data_dir.name

        from backend import database as db

        if db._conn is not None:
            db._conn.close()
            db._conn = None

        from fastapi.testclient import TestClient
        from backend.main import app

        cls._client_context = TestClient(app)
        cls.client = cls._client_context.__enter__()
        cls.db = db

    @classmethod
    def tearDownClass(cls):
        cls._client_context.__exit__(None, None, None)
        from backend import database as db

        if db._conn is not None:
            db._conn.close()
            db._conn = None
        os.environ.pop("RAG_DATA_DIR", None)
        cls._data_dir.cleanup()

    def test_graph_status_endpoint(self):
        created = self.client.post("/api/subjects", json={"name": "图谱科目"})
        self.assertEqual(created.status_code, 200)
        sid = created.json()["id"]
        resp = self.client.get("/api/subjects/{}/graph".format(sid))
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIn(body["status"], ("idle", "ready", "building", "degraded"))
        self.assertEqual(body["entity_count"], 0)

    def test_graph_view_and_topics_after_build(self):
        from backend.graph_pipe import process_document_graph_sync

        db = self.db
        sid = db.new_id()
        doc_id = db.new_id()
        db.execute(
            "INSERT INTO subjects(id,name,color,icon,description,system_prompt,top_k,created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (sid, "视图测", "#4F5BD5", "📚", "", "", 5, db.now()),
        )
        db.execute(
            "INSERT INTO documents(id,subject_id,filename,filetype,size,status,error,"
            "chunk_count,total_chunks,processed_chunks,file_path,created_at,graph_status,graph_error) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (doc_id, sid, "a.txt", "txt", 1, "ready", "", 1, 1, 1, "", db.now(), "none", ""),
        )
        db.execute(
            "INSERT INTO chunks(document_id,subject_id,seq,location,text,embedding,dim) "
            "VALUES(?,?,?,?,?,?,?)",
            (doc_id, sid, 0, "p1", "《数据结构》与「图论」", None, 0),
        )
        process_document_graph_sync(doc_id)
        view = self.client.get("/api/subjects/{}/graph/view".format(sid))
        self.assertEqual(view.status_code, 200)
        self.assertGreaterEqual(len(view.json()["nodes"]), 1)
        topics = self.client.get("/api/subjects/{}/topics".format(sid))
        self.assertEqual(topics.status_code, 200)
        self.assertIsInstance(topics.json(), list)


class HybridRetrievalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._data_dir = tempfile.TemporaryDirectory()
        os.environ["RAG_DATA_DIR"] = cls._data_dir.name
        from backend import database as db

        if db._conn is not None:
            db._conn.close()
            db._conn = None
        db.get_conn()
        cls.db = db

    @classmethod
    def tearDownClass(cls):
        from backend import database as db

        if db._conn is not None:
            db._conn.close()
            db._conn = None
        os.environ.pop("RAG_DATA_DIR", None)
        cls._data_dir.cleanup()

    def test_match_entities_and_boost_helpers(self):
        from backend import retrieval as R
        from backend.graph_pipe import process_document_graph_sync

        db = self.db
        for table in (
            "entity_mentions", "relations", "entities", "doc_topics", "topics",
            "graph_jobs", "graph_meta", "chunks", "documents", "subjects",
        ):
            db.execute("DELETE FROM {}".format(table))
        sid = db.new_id()
        doc_id = db.new_id()
        db.execute(
            "INSERT INTO subjects(id,name,color,icon,description,system_prompt,top_k,created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (sid, "hy", "#4F5BD5", "📚", "", "", 5, db.now()),
        )
        db.execute(
            "INSERT INTO documents(id,subject_id,filename,filetype,size,status,error,"
            "chunk_count,total_chunks,processed_chunks,file_path,created_at,graph_status,graph_error) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (doc_id, sid, "h.txt", "txt", 1, "ready", "", 1, 1, 1, "", db.now(), "none", ""),
        )
        db.execute(
            "INSERT INTO chunks(document_id,subject_id,seq,location,text,embedding,dim) "
            "VALUES(?,?,?,?,?,?,?)",
            (doc_id, sid, 0, "p1", "介绍「贝叶斯定理」与《概率论》", None, 0),
        )
        process_document_graph_sync(doc_id)
        hits = R._match_entities(sid, "请问贝叶斯定理怎么用")
        self.assertTrue(hits)
        boosted = R._graph_boost_chunk_ids(sid, hits)
        self.assertTrue(boosted)


if __name__ == "__main__":
    unittest.main()
