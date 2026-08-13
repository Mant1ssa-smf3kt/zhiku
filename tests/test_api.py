import os
import tempfile
import unittest


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._data_dir = tempfile.TemporaryDirectory()
        os.environ["RAG_DATA_DIR"] = cls._data_dir.name

        from fastapi.testclient import TestClient
        from backend.main import app

        cls._client_context = TestClient(app)
        cls.client = cls._client_context.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls._client_context.__exit__(None, None, None)

        from backend import database

        if database._conn is not None:
            database._conn.close()
            database._conn = None
        os.environ.pop("RAG_DATA_DIR", None)
        cls._data_dir.cleanup()

    def test_settings_are_empty_by_default(self):
        response = self.client.get("/api/settings")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["default_embed_provider_id"], "")
        self.assertEqual(body["default_embed_model"], "")
        self.assertEqual(body["default_chat_provider_id"], "")
        self.assertEqual(body["default_chat_model"], "")
        self.assertEqual(body["graph_enabled"], "1")
        self.assertEqual(body["graph_llm_extract"], "0")

    def test_provider_response_never_returns_api_key(self):
        response = self.client.post(
            "/api/providers",
            json={
                "name": "示例服务",
                "base_url": "https://api.example.com/v1",
                "api_key": "test-only-placeholder",
            },
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertNotIn("api_key", body)
        self.assertTrue(body["has_key"])
        self.assertNotEqual(body["api_key_masked"], "test-only-placeholder")

    def test_subject_can_be_created_and_listed(self):
        created = self.client.post(
            "/api/subjects",
            json={"name": "测试科目", "description": "仅用于自动化测试"},
        )

        self.assertEqual(created.status_code, 200)
        subjects = self.client.get("/api/subjects")
        self.assertEqual(subjects.status_code, 200)
        self.assertIn(created.json()["id"], [item["id"] for item in subjects.json()])


if __name__ == "__main__":
    unittest.main()
