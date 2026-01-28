# day4_incremental_index.py

import hashlib
import json
from pathlib import Path

import faiss
import numpy as np
from PIL import Image
from sentence_transformers import SentenceTransformer


# -------- CONFIG --------
BASE_DIR = Path(__file__).resolve().parent
INDEX_ROOT = BASE_DIR / "indexes"
INDEX_ROOT.mkdir(exist_ok=True)

MODEL = SentenceTransformer("clip-ViT-B-32")
DIM = 512


# -------- HELPERS --------
def folder_hash(folder_path: Path) -> str:
    return hashlib.sha256(str(folder_path).encode()).hexdigest()[:12]


def get_index_dir(folder_path: Path) -> Path:
    return INDEX_ROOT / folder_hash(folder_path)


def get_image_files(folder: Path):
    return [
        p for p in folder.iterdir()
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    ]


# -------- CORE --------
def index_images_from_folder(folder_path: Path):
    if not folder_path.exists() or not folder_path.is_dir():
        raise ValueError("Invalid folder path")

    index_dir = get_index_dir(folder_path)
    index_dir.mkdir(parents=True, exist_ok=True)

    index_file = index_dir / "index.faiss"
    metadata_file = index_dir / "metadata.json"

    image_paths = get_image_files(folder_path)

    if not image_paths:
        raise ValueError("No images found in folder")

    embeddings = []
    metadata = []

    for img_path in image_paths:
        try:
            img = Image.open(img_path).convert("RGB")
            emb = MODEL.encode(img, convert_to_numpy=True)
            embeddings.append(emb)
            metadata.append(str(img_path))
        except Exception as e:
            print(f"Skipping {img_path}: {e}")

    if not embeddings:
        raise ValueError("No valid images processed")

    embeddings = np.vstack(embeddings).astype("float32")

    index = faiss.IndexFlatIP(DIM)
    faiss.normalize_L2(embeddings)
    index.add(embeddings)

    faiss.write_index(index, str(index_file))
    metadata_file.write_text(json.dumps(metadata, indent=2))

    return {
        "indexed": len(metadata),
        "index_dir": str(index_dir)
    }


def search_images_in_folder(folder_path: Path, query: str, top_k: int = 5):
    index_dir = get_index_dir(folder_path)
    index_file = index_dir / "index.faiss"
    metadata_file = index_dir / "metadata.json"

    if not index_file.exists() or not metadata_file.exists():
        raise RuntimeError("Folder not indexed yet")

    index = faiss.read_index(str(index_file))
    metadata = json.loads(metadata_file.read_text())

    query_emb = MODEL.encode(query, convert_to_numpy=True).astype("float32")
    faiss.normalize_L2(query_emb.reshape(1, -1))

    scores, ids = index.search(query_emb.reshape(1, -1), top_k)

    results = []
    for score, idx in zip(scores[0], ids[0]):
        if idx == -1:
            continue
        results.append({
            "path": metadata[idx],
            "score": float(score)
        })

    return results
