import unittest

from backend.chunker import chunk_text
from backend.llm import _base_candidates


class ChunkTextTests(unittest.TestCase):
    def test_empty_text_produces_no_chunks(self):
        self.assertEqual(chunk_text(" \n\r\n "), [])

    def test_long_unpunctuated_text_is_bounded(self):
        chunks = chunk_text("甲" * 50, target=20, overlap=5)

        self.assertEqual("".join(chunks), "甲" * 50)
        self.assertTrue(all(len(chunk) <= 40 for chunk in chunks))


class BaseUrlTests(unittest.TestCase):
    def test_adds_v1_for_unversioned_url(self):
        self.assertEqual(
            _base_candidates("https://api.example.com/"),
            ["https://api.example.com", "https://api.example.com/v1"],
        )

    def test_keeps_versioned_url(self):
        self.assertEqual(
            _base_candidates("https://api.example.com/v1"),
            ["https://api.example.com/v1"],
        )


if __name__ == "__main__":
    unittest.main()
