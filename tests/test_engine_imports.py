import importlib
import unittest


class EngineImportRegressionTest(unittest.TestCase):
    def test_engine_imports_successfully(self) -> None:
        module = importlib.import_module("engine")

        self.assertTrue(hasattr(module, "main"))


class FolderIndexingImportRegressionTest(unittest.TestCase):
    def test_search_similar_images_is_available(self) -> None:
        module = importlib.import_module("folder_indexing")

        self.assertTrue(hasattr(module, "search_similar_images"))


if __name__ == "__main__":
    unittest.main()
