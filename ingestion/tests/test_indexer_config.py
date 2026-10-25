import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from indexer import load_environment


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


if __name__ == "__main__":
    unittest.main()
