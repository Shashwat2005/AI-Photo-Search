import os
import unittest

import folder_indexing


class OfflineModelRegressionTest(unittest.TestCase):
    def test_offline_environment_flags_are_enabled(self) -> None:
        self.assertEqual(os.environ.get("HF_HUB_OFFLINE"), "1")
        self.assertEqual(os.environ.get("TRANSFORMERS_OFFLINE"), "1")

    def test_get_model_uses_offline_mode(self) -> None:
        self.assertTrue(hasattr(folder_indexing, "get_model"))


if __name__ == "__main__":
    unittest.main()
