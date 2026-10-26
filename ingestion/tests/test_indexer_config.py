import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from indexer import load_environment, prepare_retrieval_chunks


class EnvironmentLoadingTests(unittest.TestCase):
    def test_loads_env_file_without_overriding_shell_values(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env.local"
            env_file.write_text(
                "INGESTION_TEST_FROM_FILE=file-value\n"
                "INGESTION_TEST_SHELL_VALUE=file-value\n",
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {"INGESTION_TEST_SHELL_VALUE": "shell-value"},
                clear=False,
            ):
                load_environment(env_file)
                self.assertEqual(os.environ["INGESTION_TEST_FROM_FILE"], "file-value")
                self.assertEqual(os.environ["INGESTION_TEST_SHELL_VALUE"], "shell-value")


class RetrievalPreparationTests(unittest.TestCase):
    def test_context_metadata_is_extracted_and_source_content_is_unchanged(self):
        chunks = [{
            "content": "Revenue increased in Q2. Revenue remained strong.",
            "source_location": {"page": 4, "table": 2},
            "metadata": {"section": "Financial Results"},
        }]
        prepared = prepare_retrieval_chunks(
            chunks,
            filename="results.pdf",
            document_type_name="pdf",
        )

        self.assertEqual(len(prepared), 1)
        self.assertEqual(prepared[0]["content"], chunks[0]["content"])
        self.assertEqual(prepared[0]["source_location"], {"page": 4, "table": 2})
        self.assertEqual(prepared[0]["metadata"]["section"], "Financial Results")
        retrieval = prepared[0]["metadata"]["retrieval"]
        self.assertEqual(retrieval["filename"], "results.pdf")
        self.assertEqual(retrieval["document_type"], "pdf")
        self.assertEqual(retrieval["section"], "Financial Results")
        self.assertIn("revenue", [term.casefold() for term in retrieval["extracted_terms"]])
        self.assertIn("Page: 4", prepared[0]["retrieval_text"])
        self.assertIn("Financial Results", prepared[0]["retrieval_text"])

    def test_metadata_terms_are_deterministic_and_stopword_filtered(self):
        chunk = {
            "content": "Revenue revenue grew, while profit margins improved.",
            "source_location": {},
            "metadata": {},
        }
        first = prepare_retrieval_chunks([chunk], filename="a.pdf", document_type_name="pdf")
        second = prepare_retrieval_chunks([chunk], filename="a.pdf", document_type_name="pdf")

        self.assertEqual(first[0]["metadata"]["retrieval"], second[0]["metadata"]["retrieval"])
        terms = [term.casefold() for term in first[0]["metadata"]["retrieval"]["extracted_terms"]]
        self.assertIn("revenue", terms)
        self.assertNotIn("while", terms)


if __name__ == "__main__":
    unittest.main()
