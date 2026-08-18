# day4_incremental_index.py

import hashlib
import json
import os
from pathlib import Path
from functools import partial
from collections import OrderedDict
import threading
import time

import faiss
import numpy as np
from PIL import Image
from sentence_transformers import SentenceTransformer

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")


# -------- CONFIG --------
BASE_DIR = Path(__file__).resolve().parent
INDEX_ROOT = BASE_DIR / "indexes"
INDEX_ROOT.mkdir(exist_ok=True)

DIM = 512
# ---- THUMBNAIL CONFIG ----
THUMB_SIZE = (400, 400)  # Max thumbnail dimensions (width, height)
THUMB_QUALITY = 78       # WebP quality (0-100); 78 is a good size/quality tradeoff
_MODEL = None

# In-memory cache for FAISS indexes + metadata
# Using OrderedDict to implement LRU cache with maximum 20 indexes
_INDEX_CACHE = OrderedDict()
_INDEX_CACHE_LOCK = threading.Lock()
_MAX_CACHE_SIZE = 20

# In-memory cache for query embeddings (text -> normalized embedding)
# LRU cache to avoid re-encoding repeated queries
_QUERY_EMBEDDING_CACHE = OrderedDict()
_QUERY_EMBEDDING_CACHE_LOCK = threading.Lock()
_MAX_QUERY_EMBEDDING_CACHE_SIZE = 1000

# In-memory query result cache (bypasses disk I/O for recent queries)
_QUERY_RESULT_CACHE = OrderedDict()
_QUERY_RESULT_CACHE_LOCK = threading.Lock()
_MAX_QUERY_RESULT_CACHE_SIZE = 500


def get_model():
    global _MODEL
    if _MODEL is None:
        _MODEL = SentenceTransformer("clip-ViT-B-32", local_files_only=True)
    return _MODEL


def _get_adaptive_batch_size() -> int:
    """
    Determine adaptive batch size based on system resources.
    """
    try:
        # Try to detect if CUDA is available
        import torch
        if torch.cuda.is_available():
            # GPU available - larger batch size
            return 32
    except ImportError:
        pass

    # CPU only - smaller batch size
    cpu_count = mp.cpu_count()
    # Adjust batch size based on CPU cores, but cap it
    batch_size = min(max(8, cpu_count * 2), 32)
    return batch_size


def _get_index_from_cache(index_dir: Path):
    """
    Get FAISS index from in-memory cache, or None if not cached.
    Moves accessed index to end of LRU cache.
    """
    with _INDEX_CACHE_LOCK:
        index_key = str(index_dir)
        if index_key in _INDEX_CACHE:
            # Move to end (most recently used)
            index = _INDEX_CACHE.pop(index_key)
            _INDEX_CACHE[index_key] = index
            return index
        return None


def _put_index_in_cache(index_dir: Path, index):
    """
    Put FAISS index in in-memory cache, evicting oldest if necessary.
    """
    with _INDEX_CACHE_LOCK:
        index_key = str(index_dir)
        # Remove if already exists
        if index_key in _INDEX_CACHE:
            _INDEX_CACHE.pop(index_key)

        # Add new index
        _INDEX_CACHE[index_key] = index

        # Evict oldest if over capacity
        if len(_INDEX_CACHE) > _MAX_CACHE_SIZE:
            _INDEX_CACHE.popitem(last=False)  # Remove first (least recently used)


def _clear_index_cache():
    """
    Clear the in-memory index cache.
    """
    with _INDEX_CACHE_LOCK:
        _INDEX_CACHE.clear()


def _get_metadata_from_cache(index_dir: Path):
    """Get metadata from in-memory cache alongside FAISS index."""
    with _INDEX_CACHE_LOCK:
        index_key = str(index_dir)
        if index_key in _INDEX_CACHE:
            # Return the cached metadata if stored as tuple (index, metadata)
            cached = _INDEX_CACHE[index_key]
            if isinstance(cached, tuple) and len(cached) == 2:
                return cached[1]
    return None


def _put_index_and_metadata_in_cache(index_dir: Path, index, metadata: list):
    """Put FAISS index AND metadata in in-memory cache together."""
    with _INDEX_CACHE_LOCK:
        index_key = str(index_dir)
        if index_key in _INDEX_CACHE:
            _INDEX_CACHE.pop(index_key)
        _INDEX_CACHE[index_key] = (index, metadata)
        if len(_INDEX_CACHE) > _MAX_CACHE_SIZE:
            _INDEX_CACHE.popitem(last=False)


def _get_cached_query_embedding(query: str):
    """Get normalized query embedding from cache, or None."""
    normalized = " ".join(query.lower().split())
    with _QUERY_EMBEDDING_CACHE_LOCK:
        if normalized in _QUERY_EMBEDDING_CACHE:
            _QUERY_EMBEDDING_CACHE.move_to_end(normalized)
            return _QUERY_EMBEDDING_CACHE[normalized]
    return None


def _put_query_embedding_in_cache(query: str, embedding: np.ndarray):
    """Store normalized query embedding in LRU cache."""
    normalized = " ".join(query.lower().split())
    with _QUERY_EMBEDDING_CACHE_LOCK:
        if normalized in _QUERY_EMBEDDING_CACHE:
            _QUERY_EMBEDDING_CACHE.pop(normalized)
        _QUERY_EMBEDDING_CACHE[normalized] = embedding
        if len(_QUERY_EMBEDDING_CACHE) > _MAX_QUERY_EMBEDDING_CACHE_SIZE:
            _QUERY_EMBEDDING_CACHE.popitem(last=False)


def _get_cached_query_result(cache_key: str):
    """Get query result from in-memory cache."""
    with _QUERY_RESULT_CACHE_LOCK:
        if cache_key in _QUERY_RESULT_CACHE:
            _QUERY_RESULT_CACHE.move_to_end(cache_key)
            return _QUERY_RESULT_CACHE[cache_key]
    return None


def _put_query_result_in_cache(cache_key: str, results: list):
    """Store query result in LRU cache."""
    with _QUERY_RESULT_CACHE_LOCK:
        if cache_key in _QUERY_RESULT_CACHE:
            _QUERY_RESULT_CACHE.pop(cache_key)
        _QUERY_RESULT_CACHE[cache_key] = results
        if len(_QUERY_RESULT_CACHE) > _MAX_QUERY_RESULT_CACHE_SIZE:
            _QUERY_RESULT_CACHE.popitem(last=False)


def _clear_query_caches():
    """Clear all query-related caches."""
    with _QUERY_EMBEDDING_CACHE_LOCK:
        _QUERY_EMBEDDING_CACHE.clear()
    with _QUERY_RESULT_CACHE_LOCK:
        _QUERY_RESULT_CACHE.clear()

# -------- HELPERS --------
def folder_hash(folder_path: Path) -> str:
    return hashlib.sha256(str(folder_path).encode()).hexdigest()[:12]


def get_index_dir(folder_path: Path) -> Path:
    return INDEX_ROOT / folder_hash(folder_path)


def get_thumb_dir(folder_path: Path) -> Path:
    """Return the thumbnail cache directory for a folder."""
    return BASE_DIR / ".thumb_cache" / "images" / folder_hash(folder_path)


def generate_thumbnail(source_path: Path, thumb_dir: Path, key: str) -> Path:
    """
    Generate a resized WebP thumbnail for a source image and save it to thumb_dir.
    Skips generation when an up-to-date thumbnail already exists.
    Returns the Path of the (potentially newly created) thumbnail.
    Raises on failure so callers can decide whether to ignore or propagate.
    """
    thumb_path = thumb_dir / f"{key}.webp"
    if thumb_path.exists():
        try:
            if source_path.stat().st_mtime_ns <= thumb_path.stat().st_mtime_ns:
                return thumb_path  # Already up to date
        except OSError:
            pass  # Re-generate on stat failure

    with Image.open(source_path) as img:
        img = img.convert("RGB")
        img.thumbnail(THUMB_SIZE, Image.LANCZOS)
        img.save(thumb_path, "WEBP", quality=THUMB_QUALITY, optimize=True)

    return thumb_path


def get_image_files(folder: Path):
    return [
        p for p in folder.iterdir()
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    ]


def _manifest_file(index_dir: Path) -> Path:
    return index_dir / "manifest.json"


def _embeddings_dir(index_dir: Path) -> Path:
    return index_dir / "embeddings"


def _query_cache_file(index_dir: Path) -> Path:
    return index_dir / "query_cache.json"


def _temp_manifest_file(index_dir: Path) -> Path:
    return index_dir / "temp_manifest.json"


def _image_key(path: Path) -> str:
    return hashlib.sha1(str(path).encode("utf-8")).hexdigest()


def _file_sig(path: Path) -> dict:
    stat = path.stat()
    return {
        "size": int(stat.st_size),
        "mtime_ns": int(stat.st_mtime_ns),
    }


def _same_sig(a: dict, b: dict) -> bool:
    return (
        isinstance(a, dict)
        and isinstance(b, dict)
        and a.get("size") == b.get("size")
        and a.get("mtime_ns") == b.get("mtime_ns")
    )


def _load_manifest(index_dir: Path) -> dict:
    mf = _manifest_file(index_dir)
    if not mf.exists():
        return {"files": {}}

    try:
        data = json.loads(mf.read_text())
    except Exception:
        return {"files": {}}

    if not isinstance(data, dict) or not isinstance(data.get("files"), dict):
        return {"files": {}}

    return data


def _save_manifest(index_dir: Path, manifest: dict):
    _manifest_file(index_dir).write_text(json.dumps(manifest, indent=2))


def _index_signature(index_file: Path, metadata_file: Path) -> str:
    idx_stat = index_file.stat()
    meta_stat = metadata_file.stat()
    return (
        f"{idx_stat.st_size}:{idx_stat.st_mtime_ns}|"
        f"{meta_stat.st_size}:{meta_stat.st_mtime_ns}"
    )


def _load_query_cache(index_dir: Path) -> dict:
    path = _query_cache_file(index_dir)
    if not path.exists():
        return {"index_signature": "", "entries": {}}

    try:
        data = json.loads(path.read_text())
    except Exception:
        return {"index_signature": "", "entries": {}}

    if not isinstance(data, dict):
        return {"index_signature": "", "entries": {}}

    entries = data.get("entries")
    if not isinstance(entries, dict):
        entries = {}

    return {
        "index_signature": str(data.get("index_signature", "")),
        "entries": entries,
    }


def _save_query_cache(index_dir: Path, cache: dict):
    # Use compact JSON (separators without spaces) — 30–40% smaller and faster
    # than indent=2 for a 200-entry cache, and faster to parse on next load.
    _query_cache_file(index_dir).write_text(
        json.dumps(cache, separators=(",", ":"))
    )


def _load_temp_manifest(index_dir: Path) -> dict:
    temp_mf = _temp_manifest_file(index_dir)
    if not temp_mf.exists():
        return {"processed_files": {}, "stage": "start"}

    try:
        data = json.loads(temp_mf.read_text())
    except Exception:
        return {"processed_files": {}, "stage": "start"}

    if not isinstance(data, dict):
        return {"processed_files": {}, "stage": "start"}

    processed = data.get("processed_files", {})
    stage = data.get("stage", "start")

    return {
        "processed_files": processed if isinstance(processed, dict) else {},
        "stage": stage if isinstance(stage, str) else "start"
    }


def _save_temp_manifest(index_dir: Path, temp_manifest: dict):
    _temp_manifest_file(index_dir).write_text(json.dumps(temp_manifest, indent=2))


def _clear_temp_manifest(index_dir: Path):
    temp_mf = _temp_manifest_file(index_dir)
    if temp_mf.exists():
        temp_mf.unlink()


# -------- CORE --------
def index_images_from_folder(folder_path: Path, on_progress=None):
    """Index all images in folder_path.

    Args:
        folder_path: Directory containing images.
        on_progress: Optional callable(current, total, filename) called after
            each batch is encoded. Used by engine.py to stream progress lines.
    """
    if not folder_path.exists() or not folder_path.is_dir():
        raise ValueError("Invalid folder path")

    index_dir = get_index_dir(folder_path)
    index_dir.mkdir(parents=True, exist_ok=True)

    index_file = index_dir / "index.faiss"
    metadata_file = index_dir / "metadata.json"
    emb_dir = _embeddings_dir(index_dir)
    emb_dir.mkdir(parents=True, exist_ok=True)

    image_paths = get_image_files(folder_path)

    if not image_paths:
        raise ValueError("No images found in folder")

    manifest = _load_manifest(index_dir)
    old_files = manifest.get("files", {})

    current_files = {str(p): _file_sig(p) for p in image_paths}
    current_paths = set(current_files.keys())
    old_paths = set(old_files.keys())

    added = sorted(current_paths - old_paths)
    removed = sorted(old_paths - current_paths)
    maybe_changed = sorted(current_paths & old_paths)
    modified = [p for p in maybe_changed if not _same_sig(current_files[p], old_files[p].get("sig"))]

    has_prior_index = index_file.exists() and metadata_file.exists()
    no_changes = has_prior_index and not added and not removed and not modified
    if no_changes:
        # Clear any temporary manifest if exists
        _clear_temp_manifest(index_dir)
        return {
            "indexed": len(current_files),
            "index_dir": str(index_dir),
            "cached": True,
            "added": 0,
            "modified": 0,
            "removed": 0,
        }

    # Check for resumable indexing
    temp_manifest = _load_temp_manifest(index_dir)
    processed_files = temp_manifest.get("processed_files", {})
    stage = temp_manifest.get("stage", "start")

    # Handle removed files
    if stage == "start":
        _thumb_dir_for_removed = get_thumb_dir(folder_path)
        for p in removed:
            key = old_files.get(p, {}).get("key")
            if key:
                npy = emb_dir / f"{key}.npy"
                if npy.exists():
                    npy.unlink()
                # Also remove the WebP thumbnail so the cache stays consistent
                thumb_path = _thumb_dir_for_removed / f"{key}.webp"
                if thumb_path.exists():
                    thumb_path.unlink()
        stage = "processing"

    # Process files that need encoding
    files_to_encode = added + modified
    remaining_files_to_encode = [f for f in files_to_encode if f not in processed_files]

    if remaining_files_to_encode and stage in ["processing", "start"]:
        model = get_model()
        batch_size = _get_adaptive_batch_size()

        # Process images in batches within a single process.
        # Using mp.Pool caused each worker to load a full CLIP copy (~500 MB each),
        # resulting in a 4x model RAM spike. Single-process batching is equally
        # fast because CLIP inference is compute-bound, not GIL-bound.
        for i in range(0, len(remaining_files_to_encode), batch_size):
            batch_paths = remaining_files_to_encode[i : i + batch_size]
            batch_images = []
            valid_batch_paths = []

            for path_str in batch_paths:
                try:
                    with Image.open(Path(path_str)) as img:
                        batch_images.append(img.convert("RGB"))
                    valid_batch_paths.append(path_str)
                except Exception as e:
                    print(f"Skipping {path_str}: {e}")
                    processed_files[path_str] = "failed"

            if batch_images:
                try:
                    batch_embeddings = model.encode(
                        batch_images,
                        convert_to_numpy=True,
                        show_progress_bar=False,
                    ).astype("float32")

                    for path_str, emb in zip(valid_batch_paths, batch_embeddings):
                        key = _image_key(Path(path_str))
                        np.save(emb_dir / f"{key}.npy", emb)
                        processed_files[path_str] = "success"

                except Exception as e:
                    print(f"Batch embedding failed: {e}")
                    for path_str in valid_batch_paths:
                        processed_files[path_str] = "failed"

            # Checkpoint progress after each batch so indexing is resumable
            _save_temp_manifest(index_dir, {
                "processed_files": processed_files,
                "stage": "processing"
            })

            # Emit progress to caller (used for real-time UI updates)
            if on_progress is not None:
                done = sum(1 for v in processed_files.values() if v in ("success", "failed"))
                last_file = valid_batch_paths[-1] if valid_batch_paths else batch_paths[-1] if batch_paths else ""
                try:
                    on_progress(done, len(files_to_encode), last_file)
                except Exception:
                    pass  # Never let a broken callback abort indexing

        stage = "finalizing"

    # Finalize indexing - build final index
    if stage == "finalizing":
        new_files = {}
        metadata = []
        vectors = []

        for p in sorted(current_paths):
            path_obj = Path(p)
            key = _image_key(path_obj)
            npy = emb_dir / f"{key}.npy"

            if not npy.exists():
                continue

            try:
                emb = np.load(npy).astype("float32")
            except Exception:
                continue

            vectors.append(emb)
            metadata.append(p)
            new_files[p] = {
                "sig": current_files[p],
                "key": key,
            }

        if not vectors:
            # Clear temp manifest and raise error
            _clear_temp_manifest(index_dir)
            raise ValueError("No valid images processed")

        embeddings = np.vstack(vectors).astype("float32")
        faiss.normalize_L2(embeddings)

        index = faiss.IndexFlatIP(DIM)
        index.add(embeddings)

        faiss.write_index(index, str(index_file))
        metadata_file.write_text(json.dumps(metadata, indent=2))
        _save_manifest(index_dir, {"files": new_files})

        # Update in-memory cache with new index + metadata
        _put_index_and_metadata_in_cache(index_dir, index, metadata)

        # Clear query caches since index has changed
        _clear_query_caches()

        query_cache_file = _query_cache_file(index_dir)
        if query_cache_file.exists():
            query_cache_file.unlink()

        # Generate compact WebP thumbnails (400px) for every indexed image.
        # This replaces the old full-image copy pipeline: a 10 MB JPEG now
        # becomes a ~15 KB WebP instead of a ~13 MB base64 string over IPC.
        thumb_dir_path = get_thumb_dir(folder_path)
        thumb_dir_path.mkdir(parents=True, exist_ok=True)
        for p, info in new_files.items():
            thumb_key = info.get("key")
            if thumb_key:
                try:
                    generate_thumbnail(Path(p), thumb_dir_path, thumb_key)
                except Exception:
                    pass  # Thumbnails are optional; never abort an index build

        # Clear temporary manifest upon successful completion
        _clear_temp_manifest(index_dir)

        return {
            "indexed": len(metadata),
            "index_dir": str(index_dir),
            "cached": False,
            "added": len(added),
            "modified": len(modified),
            "removed": len(removed),
        }

    # If we somehow get here, clear temp manifest and raise error
    _clear_temp_manifest(index_dir)
    raise RuntimeError("Indexing process in unknown state")


def _get_image_metadata(image_path: Path):
    """Extract metadata from an image file"""
    try:
        stat = image_path.stat()
        file_ext = image_path.suffix.lower()
        mtime = stat.st_mtime
        
        # Get image dimensions
        width, height = None, None
        try:
            with Image.open(image_path) as img:
                width, height = img.size
        except Exception:
            pass
        
        return {
            "file_type": file_ext,
            "mtime": mtime,
            "width": width,
            "height": height,
            "size": stat.st_size,
        }
    except Exception:
        return {
            "file_type": image_path.suffix.lower(),
            "mtime": 0,
            "width": None,
            "height": None,
            "size": 0,
        }


def _apply_filters(results, image_path_list, filters=None):
    """Apply filters to search results.

    Fast path: if only `file_types` is requested we skip the expensive
    Image.open() call entirely, since we only need the file extension.
    """
    if not filters:
        return results

    # Determine which metadata fields are actually needed
    need_resolution = "min_width" in filters or "min_height" in filters
    need_date       = "date_from" in filters or "date_to"   in filters
    need_metadata   = need_resolution or need_date

    filtered = []

    for result in results:
        path = result["path"]

        # File type filter — extension only, no I/O
        if "file_types" in filters and filters["file_types"]:
            if Path(path).suffix.lower() not in filters["file_types"]:
                continue

        # Resolution / date filters — stat + optional open only when needed
        if need_metadata:
            meta = _get_image_metadata(Path(path))

            if need_resolution:
                if "min_width"  in filters and meta["width"]  and meta["width"]  < filters["min_width"]:
                    continue
                if "min_height" in filters and meta["height"] and meta["height"] < filters["min_height"]:
                    continue

            if need_date:
                mtime = meta["mtime"]
                if "date_from" in filters and mtime and mtime < filters["date_from"]:
                    continue
                if "date_to"   in filters and mtime and mtime > filters["date_to"]:
                    continue

        filtered.append(result)

    return filtered


def _apply_sorting(results, sort_by="relevance"):
    """Apply sorting to search results.

    Uses the 'mtime' field already present in each result dict (populated
    during search / list) rather than re-calling stat() on disk, which
    would cost O(N) syscalls on every sort operation.
    """
    if sort_by == "relevance":
        return sorted(results, key=lambda x: x.get("score", 0), reverse=True)

    elif sort_by == "newest":
        return sorted(results, key=lambda x: x.get("mtime", 0), reverse=True)

    elif sort_by == "oldest":
        return sorted(results, key=lambda x: x.get("mtime", 0))

    elif sort_by == "filename":
        return sorted(results, key=lambda x: Path(x["path"]).name.lower())

    return results


def get_index_diagnostics(folder_path: Path):
    """Get diagnostics for an indexed folder"""
    index_dir = get_index_dir(folder_path)
    index_file = index_dir / "index.faiss"
    metadata_file = index_dir / "metadata.json"
    manifest_file = _manifest_file(index_dir)
    emb_dir = _embeddings_dir(index_dir)
    
    diagnostics = {
        "folder": str(folder_path),
        "index_dir": str(index_dir),
        "indexed": False,
        "total_images": 0,
        "index_size_mb": 0,
        "embeddings_size_mb": 0,
        "thumbnail_count": 0,
        "last_indexed": None,
    }
    
    if not index_file.exists() or not metadata_file.exists():
        return diagnostics
    
    diagnostics["indexed"] = True
    
    try:
        # Get total images
        metadata = json.loads(metadata_file.read_text())
        diagnostics["total_images"] = len(metadata)
        
        # Get index file size
        if index_file.exists():
            diagnostics["index_size_mb"] = index_file.stat().st_size / (1024 * 1024)
        
        # Get embeddings directory size
        if emb_dir.exists():
            total_size = sum(f.stat().st_size for f in emb_dir.glob("*.npy"))
            diagnostics["embeddings_size_mb"] = total_size / (1024 * 1024)
        
        # Get last indexed time
        if manifest_file.exists():
            diagnostics["last_indexed"] = manifest_file.stat().st_mtime
        
        # Count thumbnails
        thumb_dir = Path(__file__).parent / ".thumb_cache" / "images" / folder_hash(folder_path)
        if thumb_dir.exists():
            diagnostics["thumbnail_count"] = len(list(thumb_dir.glob("*")))
            
    except Exception as e:
        diagnostics["error"] = str(e)
    
    return diagnostics


def search_similar_images(folder_path: Path, image_path: str, top_k: int = 10):
    """Search for similar images based on visual similarity to a given image"""
    index_dir = get_index_dir(folder_path)
    index_file = index_dir / "index.faiss"
    metadata_file = index_dir / "metadata.json"
    emb_dir = _embeddings_dir(index_dir)

    if not index_file.exists() or not metadata_file.exists():
        raise RuntimeError("Folder not indexed yet")

    top_k = max(1, int(top_k))

    # Get embedding for the image
    image_key = _image_key(Path(image_path))
    npy_path = emb_dir / f"{image_key}.npy"

    if not npy_path.exists():
        raise ValueError(f"Image not found in index: {image_path}")

    try:
        image_emb = np.load(npy_path).astype("float32")
    except Exception as e:
        raise ValueError(f"Failed to load image embedding: {e}")

    # Try to get index + metadata from in-memory cache first
    cached_index_meta = _get_index_from_cache(index_dir)
    if cached_index_meta is not None and isinstance(cached_index_meta, tuple):
        index, metadata = cached_index_meta
    else:
        # Load from disk and cache both
        index = faiss.read_index(str(index_file))
        metadata = json.loads(metadata_file.read_text())
        _put_index_and_metadata_in_cache(index_dir, index, metadata)

    # Normalize embedding
    faiss.normalize_L2(image_emb.reshape(1, -1))

    # Search for similar images (get top_k + 1 to exclude the image itself)
    scores, ids = index.search(image_emb.reshape(1, -1), top_k + 1)

    results = []
    for score, idx in zip(scores[0], ids[0]):
        if idx == -1:
            continue
        result_path = metadata[idx]
        # Skip the image itself
        if result_path == image_path:
            continue
        results.append({
            "path": result_path,
            "score": float(score)
        })
    
    # Return top_k results
    return results[:top_k]


def search_images_in_folder(folder_path: Path, query: str, top_k: int = 5, min_score: float | None = None,
                           filters: dict | None = None, sort_by: str = "relevance"):
    index_dir = get_index_dir(folder_path)
    index_file = index_dir / "index.faiss"
    metadata_file = index_dir / "metadata.json"

    if not index_file.exists() or not metadata_file.exists():
        raise RuntimeError("Folder not indexed yet")

    top_k = max(1, int(top_k))
    normalized_query = " ".join(query.lower().split())
    threshold = None if min_score is None else float(min_score)

    index_sig = _index_signature(index_file, metadata_file)
    cache_key = f"q={normalized_query}|k={top_k}|s={threshold}|f={json.dumps(filters or {})}|o={sort_by}"

    # 1. Check in-memory query result cache (fastest - no disk I/O)
    cached_result = _get_cached_query_result(cache_key)
    if cached_result is not None:
        return cached_result

    # 2. Check on-disk query cache (persistent across restarts)
    cache = _load_query_cache(index_dir)
    if cache.get("index_signature") == index_sig:
        cached = cache.get("entries", {}).get(cache_key)
        if isinstance(cached, list):
            _put_query_result_in_cache(cache_key, cached)
            return cached

    # 3. Get FAISS index + metadata from in-memory cache (avoids disk reads)
    cached_index_meta = _get_index_from_cache(index_dir)
    if cached_index_meta is not None and isinstance(cached_index_meta, tuple):
        index, metadata = cached_index_meta
    else:
        # Load from disk and cache both
        index = faiss.read_index(str(index_file))
        metadata = json.loads(metadata_file.read_text())
        _put_index_and_metadata_in_cache(index_dir, index, metadata)

    # 4. Get or compute query embedding (cached)
    query_emb = _get_cached_query_embedding(normalized_query)
    if query_emb is None:
        query_emb = get_model().encode(normalized_query, convert_to_numpy=True).astype("float32")
        faiss.normalize_L2(query_emb.reshape(1, -1))
        _put_query_embedding_in_cache(normalized_query, query_emb)
    else:
        # Already normalized from cache
        query_emb = query_emb.reshape(1, -1)

    # 5. FAISS search — overfetch only when filters are active so we have
    #    enough headroom after filtering; with no filters top_k is exact.
    if filters:
        search_k = min(top_k * 4, index.ntotal)
    else:
        search_k = min(top_k, index.ntotal)
    scores, ids = index.search(query_emb, search_k)

    # 6. Build results - use pre-cached mtimes from metadata if available
    results = []
    for score, idx in zip(scores[0], ids[0]):
        if idx == -1:
            continue
        if threshold is not None and float(score) < threshold:
            continue
        result_path = metadata[idx]
        # mtime is not stored in metadata.json, so we stat (could be optimized later)
        try:
            mtime = Path(result_path).stat().st_mtime
        except Exception:
            mtime = 0
        results.append({
            "path": result_path,
            "score": float(score),
            "mtime": float(mtime),
        })

    # 7. Apply filters and sorting
    results = _apply_filters(results, metadata, filters)
    results = _apply_sorting(results, sort_by)
    results = results[:top_k]

    # 8. Cache results in both memory and disk
    _put_query_result_in_cache(cache_key, results)

    entries = cache.get("entries", {}) if cache.get("index_signature") == index_sig else {}
    entries[cache_key] = results

    if len(entries) > 200:
        # Keep only the 200 most-recent entries
        entries = dict(list(entries.items())[-200:])

    _save_query_cache(index_dir, {
        "index_signature": index_sig,
        "entries": entries,
    })

    return results


def list_images_in_folder(folder_path: Path, top_k: int = 200, filters: dict | None = None, sort_by: str = "filename"):
    """List indexed images with filtering/sorting, without semantic query matching."""
    index_dir = get_index_dir(folder_path)
    metadata_file = index_dir / "metadata.json"

    if not metadata_file.exists():
        raise RuntimeError("Folder not indexed yet")

    all_paths = json.loads(metadata_file.read_text())
    results = []

    for path in all_paths:
        try:
            mtime = Path(path).stat().st_mtime
        except Exception:
            mtime = 0

        results.append({
            "path": path,
            "score": 0.0,
            "mtime": float(mtime),
        })

    results = _apply_filters(results, all_paths, filters)
    results = _apply_sorting(results, sort_by)

    top_k = max(1, int(top_k))
    return results[:top_k]


# -------- INDEX MAINTENANCE --------
def get_index_stats(folder_path: Path) -> dict:
    """Get statistics about index state including orphaned embeddings"""
    index_dir = get_index_dir(folder_path)
    metadata_file = index_dir / "metadata.json"
    emb_dir = _embeddings_dir(index_dir)
    manifest = _load_manifest(index_dir)
    
    stats = {
        "total_indexed_images": 0,
        "total_embeddings": 0,
        "orphaned_embeddings": 0,
        "orphaned_size_mb": 0.0,
        "fragmentation_percent": 0.0,
    }
    
    if not metadata_file.exists() or not emb_dir.exists():
        return stats
    
    try:
        # Count indexed images
        metadata = json.loads(metadata_file.read_text())
        stats["total_indexed_images"] = len(metadata)
        
        # Count embeddings files
        emb_files = list(emb_dir.glob("*.npy"))
        stats["total_embeddings"] = len(emb_files)
        
        # Find orphaned embeddings (embeddings not in manifest)
        old_files = manifest.get("files", {})
        indexed_keys = {old_files[p].get("key") for p in old_files if "key" in old_files[p]}
        
        orphaned_size = 0
        for emb_file in emb_files:
            file_key = emb_file.stem  # filename without .npy
            if file_key not in indexed_keys:
                stats["orphaned_embeddings"] += 1
                try:
                    orphaned_size += emb_file.stat().st_size
                except Exception:
                    pass
        
        stats["orphaned_size_mb"] = orphaned_size / (1024 * 1024)
        
        # Calculate fragmentation
        if stats["total_embeddings"] > 0:
            stats["fragmentation_percent"] = (stats["orphaned_embeddings"] / stats["total_embeddings"]) * 100
        
    except Exception as e:
        stats["error"] = str(e)
    
    return stats


def cleanup_orphaned_embeddings(folder_path: Path) -> dict:
    """Remove embedding files that don't correspond to indexed images"""
    index_dir = get_index_dir(folder_path)
    metadata_file = index_dir / "metadata.json"
    emb_dir = _embeddings_dir(index_dir)
    manifest = _load_manifest(index_dir)
    
    result = {
        "deleted": 0,
        "total": 0,
        "size_freed_mb": 0.0,
    }
    
    if not metadata_file.exists() or not emb_dir.exists():
        return result
    
    try:
        old_files = manifest.get("files", {})
        indexed_keys = {old_files[p].get("key") for p in old_files if "key" in old_files[p]}
        
        # Find and delete orphaned files
        for emb_file in emb_dir.glob("*.npy"):
            result["total"] += 1
            file_key = emb_file.stem
            
            if file_key not in indexed_keys:
                try:
                    size = emb_file.stat().st_size
                    emb_file.unlink()
                    result["deleted"] += 1
                    result["size_freed_mb"] += size / (1024 * 1024)
                except Exception as e:
                    print(f"Failed to delete orphaned embedding {emb_file}: {e}")
    
    except Exception as e:
        result["error"] = str(e)
    
    return result


def compact_index(folder_path: Path) -> dict:
    """Rebuild FAISS index to remove orphaned entries and optimize"""
    index_dir = get_index_dir(folder_path)
    index_file = index_dir / "index.faiss"
    metadata_file = index_dir / "metadata.json"
    emb_dir = _embeddings_dir(index_dir)
    manifest = _load_manifest(index_dir)
    
    result = {
        "compacted": False,
        "before_size_mb": 0.0,
        "after_size_mb": 0.0,
        "space_saved_mb": 0.0,
        "entries_before": 0,
        "entries_after": 0,
    }
    
    if not index_file.exists() or not metadata_file.exists():
        return result
    
    try:
        # Get before state
        result["before_size_mb"] = index_file.stat().st_size / (1024 * 1024)
        
        # Load current index and metadata
        old_index = faiss.read_index(str(index_file))
        metadata = json.loads(metadata_file.read_text())
        result["entries_before"] = old_index.ntotal
        
        # Rebuild index with only valid embeddings
        vectors = []
        valid_metadata = []
        new_files = {}
        
        manifest_files = manifest.get("files", {})
        
        for i, path in enumerate(metadata):
            # Check if this path is in the manifest
            if path not in manifest_files:
                continue
            
            file_info = manifest_files[path]
            key = file_info.get("key")
            
            if not key:
                continue
            
            npy = emb_dir / f"{key}.npy"
            
            if not npy.exists():
                continue
            
            try:
                emb = np.load(npy).astype("float32")
                vectors.append(emb)
                valid_metadata.append(path)
                new_files[path] = file_info
            except Exception as e:
                print(f"Skipping {path}: {e}")
                continue
        
        if not vectors:
            result["error"] = "No valid embeddings found after compaction"
            return result
        
        # Build new index
        embeddings = np.vstack(vectors).astype("float32")
        faiss.normalize_L2(embeddings)
        
        new_index = faiss.IndexFlatIP(DIM)
        new_index.add(embeddings)
        
        # Save new index
        faiss.write_index(new_index, str(index_file))
        metadata_file.write_text(json.dumps(valid_metadata, indent=2))
        _save_manifest(index_dir, {"files": new_files})
        
        #         # Update in-memory cache with new index + metadata
        _put_index_and_metadata_in_cache(index_dir, new_index, valid_metadata)

        # Clear query caches since index has changed
        _clear_query_caches()
        query_cache_file = _query_cache_file(index_dir)
        if query_cache_file.exists():
            query_cache_file.unlink()
        # Get after state
        result["after_size_mb"] = index_file.stat().st_size / (1024 * 1024)
        result["entries_after"] = new_index.ntotal
        result["space_saved_mb"] = result["before_size_mb"] - result["after_size_mb"]
        result["compacted"] = True
        
    except Exception as e:
        result["error"] = str(e)
    
    return result


def cleanup_index(folder_path: Path) -> dict:
    """Main cleanup function: removes orphans and compacts index"""
    cleanup_orphans = cleanup_orphaned_embeddings(folder_path)
    compact_result = compact_index(folder_path)
    stats = get_index_stats(folder_path)
    
    return {
        "orphan_cleanup": cleanup_orphans,
        "compaction": compact_result,
        "stats_after": stats,
    }


def remove_images_from_index(folder_path: Path, paths_to_remove: list) -> dict:
    """
    Remove specific images from the FAISS index WITHOUT re-running CLIP.

    Rebuilds the index purely from the cached .npy embedding files that remain
    on disk after deleting the target paths. This takes ~1–2s for any size
    library (no neural network inference), compared to 30–60s for a full
    index_images_from_folder() call.

    Args:
        folder_path: The indexed folder.
        paths_to_remove: Absolute paths of image files that were deleted from disk.

    Returns:
        dict with status, removed_count, remaining_count.
    """
    folder_path = Path(folder_path)
    index_dir = get_index_dir(folder_path)
    index_file = index_dir / "index.faiss"
    metadata_file = index_dir / "metadata.json"
    emb_dir = _embeddings_dir(index_dir)
    thumb_dir = get_thumb_dir(folder_path)

    if not index_file.exists() or not metadata_file.exists():
        raise RuntimeError("Folder not indexed yet")

    remove_set = {str(p) for p in paths_to_remove}

    # Delete .npy embeddings + .webp thumbnails for removed paths
    for path_str in remove_set:
        key = _image_key(Path(path_str))
        npy = emb_dir / f"{key}.npy"
        if npy.exists():
            npy.unlink()
        thumb = thumb_dir / f"{key}.webp"
        if thumb.exists():
            thumb.unlink()

    # Load current manifest, drop removed entries
    manifest = _load_manifest(index_dir)
    old_files = manifest.get("files", {})
    new_files = {p: info for p, info in old_files.items() if p not in remove_set}

    # Rebuild FAISS index from remaining .npy files (no CLIP inference)
    vectors: list = []
    metadata: list = []

    for path_str, info in sorted(new_files.items()):
        key = info.get("key")
        if not key:
            key = _image_key(Path(path_str))
        npy = emb_dir / f"{key}.npy"
        if not npy.exists():
            continue
        try:
            emb = np.load(npy).astype("float32")
            vectors.append(emb)
            metadata.append(path_str)
        except Exception:
            continue

    if not vectors:
        # Index is now empty — remove index files to allow a fresh start
        index_file.unlink(missing_ok=True)
        metadata_file.unlink(missing_ok=True)
        _save_manifest(index_dir, {"files": {}})
        _clear_temp_manifest(index_dir)
        return {"status": "ok", "removed_count": len(remove_set), "remaining_count": 0}

    embeddings = np.vstack(vectors).astype("float32")
    faiss.normalize_L2(embeddings)

    index = faiss.IndexFlatIP(DIM)
    index.add(embeddings)

    faiss.write_index(index, str(index_file))
    metadata_file.write_text(json.dumps(metadata, indent=2))
    _save_manifest(index_dir, {"files": new_files})

    # Update in-memory cache with new index + metadata
    _put_index_and_metadata_in_cache(index_dir, index, metadata)

    # Clear query caches since index has changed
    _clear_query_caches()
    query_cache_file = _query_cache_file(index_dir)
    if query_cache_file.exists():
        query_cache_file.unlink()

    _clear_temp_manifest(index_dir)

    return {
        "status": "ok",
        "removed_count": len(remove_set),
        "remaining_count": len(metadata),
    }


# -------- DUPLICATE DETECTION --------
def detect_duplicates(folder_path: Path, similarity_threshold: float = 0.95) -> dict:
    """
    Detect visually similar/duplicate images using FAISS ANN search.

    Algorithm: O(n × K × log n) via FAISS, then Union-Find clustering.
    The old approach computed an n×n similarity matrix in RAM which OOM'd on
    libraries with more than ~5,000 images.

    Returns: {"status": "ok", "groups": [[path1, path2, ...], ...], ...}
    """
    index_dir = get_index_dir(folder_path)
    index_file = index_dir / "index.faiss"
    metadata_file = index_dir / "metadata.json"

    if not index_file.exists() or not metadata_file.exists():
        raise RuntimeError("Folder not indexed yet")

    similarity_threshold = max(0.0, min(1.0, float(similarity_threshold)))

    metadata = json.loads(metadata_file.read_text())
    n = len(metadata)

    if n == 0:
        return {"status": "ok", "groups": [], "total_images": 0,
                "group_count": 0, "duplicate_count": 0, "threshold": similarity_threshold}

    # Use the cached FAISS index so we don't re-read from disk
    index = _get_index_from_cache(index_dir)
    if index is None:
        index = faiss.read_index(str(index_file))
        _put_index_in_cache(index_dir, index)

    # Load all embeddings into a matrix for batch querying.
    # We still need to load embeddings individually because we must map
    # FAISS positional indices back to file paths.
    emb_dir = _embeddings_dir(index_dir)
    embeddings = []
    valid_indices = []  # positional index in `metadata` for each loaded embedding

    for i, path in enumerate(metadata):
        key = _image_key(Path(path))
        npy = emb_dir / f"{key}.npy"
        if not npy.exists():
            continue
        try:
            emb = np.load(npy).astype("float32")
            embeddings.append(emb)
            valid_indices.append(i)
        except Exception:
            continue

    if not embeddings:
        return {"status": "ok", "groups": [], "total_images": n,
                "group_count": 0, "duplicate_count": 0, "threshold": similarity_threshold}

    embedding_matrix = np.vstack(embeddings).astype("float32")
    faiss.normalize_L2(embedding_matrix)

    m = len(embeddings)  # number of images with valid embeddings

    # ANN search: for each image find its K nearest neighbours.
    # K = min(10, m-1) so we don't search for more neighbours than exist.
    K = min(10, max(1, m - 1))
    scores, ids = index.search(embedding_matrix, K + 1)  # +1 because self is always returned

    # ----- Union-Find -----
    parent = list(range(m))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]  # path compression
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    # Build a positional-index → local-row mapping so we can translate
    # FAISS results (which use metadata positions) back to embedding rows.
    meta_pos_to_row = {meta_idx: row for row, meta_idx in enumerate(valid_indices)}

    for row in range(m):
        for k in range(K + 1):
            faiss_pos = int(ids[row, k])
            score = float(scores[row, k])
            if faiss_pos == -1:
                continue
            # Skip self-match (score ≈ 1.0)
            if faiss_pos == valid_indices[row]:
                continue
            if score < similarity_threshold:
                break  # Results are sorted descending; further results won't qualify
            neighbour_row = meta_pos_to_row.get(faiss_pos)
            if neighbour_row is not None:
                union(row, neighbour_row)

    # Collect groups
    from collections import defaultdict
    clusters: dict[int, list[int]] = defaultdict(list)
    for row in range(m):
        clusters[find(row)].append(row)

    groups = []
    for members in clusters.values():
        if len(members) < 2:
            continue
        # Sort by mtime descending (newest first)
        path_mtime_pairs = []
        for row in members:
            p = metadata[valid_indices[row]]
            try:
                mtime = Path(p).stat().st_mtime
            except Exception:
                mtime = 0.0
            path_mtime_pairs.append((mtime, p))
        path_mtime_pairs.sort(reverse=True)
        groups.append([p for _, p in path_mtime_pairs])

    return {
        "status": "ok",
        "total_images": n,
        "groups": groups,
        "group_count": len(groups),
        "duplicate_count": sum(len(g) for g in groups),
        "threshold": similarity_threshold,
    }


def get_duplicate_clusters(folder_path: Path, similarity_threshold: float = 0.95) -> dict:
    """Get duplicate image clusters for display in UI"""
    try:
        result = detect_duplicates(folder_path, similarity_threshold)
        return result
    except Exception as e:
        return {
            "status": "error",
            "message": str(e),
        }


# -------- FAVORITES & COLLECTIONS --------
def _get_collections_file(index_dir: Path) -> Path:
    return index_dir / "collections.json"


def get_collections(folder_path: Path) -> dict:
    """Get all image collections for a folder"""
    index_dir = get_index_dir(folder_path)
    collections_file = _get_collections_file(index_dir)
    
    if not collections_file.exists():
        return {
            "collections": [],
            "image_collections": {}  # Maps image_path -> [collection_ids]
        }
    
    try:
        data = json.loads(collections_file.read_text())
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    
    return {
        "collections": [],
        "image_collections": {}
    }


def _save_collections(index_dir: Path, data: dict):
    collections_file = _get_collections_file(index_dir)
    collections_file.write_text(json.dumps(data, indent=2))


def create_collection(folder_path: Path, collection_name: str) -> dict:
    """Create a new image collection"""
    index_dir = get_index_dir(folder_path)
    index_dir.mkdir(parents=True, exist_ok=True)
    
    if not collection_name or not isinstance(collection_name, str):
        raise ValueError("Invalid collection name")
    
    data = get_collections(folder_path)
    collections = data.get("collections", [])
    
    # Check for duplicate names
    if any(c.get("name") == collection_name for c in collections):
        raise ValueError(f"Collection '{collection_name}' already exists")
    
    # Create new collection
    collection_id = hashlib.sha256(f"{collection_name}-{len(collections)}".encode()).hexdigest()[:12]
    new_collection = {
        "id": collection_id,
        "name": collection_name,
        "created_at": time.time(),
        "image_count": 0,
    }
    
    collections.append(new_collection)
    data["collections"] = collections
    _save_collections(index_dir, data)
    
    return new_collection


def delete_collection(folder_path: Path, collection_id: str) -> dict:
    """Delete a collection (keeps images, just removes the grouping)"""
    index_dir = get_index_dir(folder_path)
    data = get_collections(folder_path)
    
    collections = data.get("collections", [])
    image_collections = data.get("image_collections", {})
    
    # Remove collection
    data["collections"] = [c for c in collections if c.get("id") != collection_id]
    
    # Remove from image mappings
    for images in image_collections.values():
        if isinstance(images, list) and collection_id in images:
            images.remove(collection_id)
    
    _save_collections(index_dir, data)
    
    return {"status": "ok", "message": f"Collection deleted"}


def add_to_collection(folder_path: Path, collection_id: str, image_path: str) -> dict:
    """Add an image to a collection"""
    index_dir = get_index_dir(folder_path)
    data = get_collections(folder_path)
    
    collections = data.get("collections", [])
    image_collections = data.get("image_collections", {})
    
    # Verify collection exists
    if not any(c.get("id") == collection_id for c in collections):
        raise ValueError(f"Collection not found: {collection_id}")
    
    # Add image to collection
    if image_path not in image_collections:
        image_collections[image_path] = []
    
    if collection_id not in image_collections[image_path]:
        image_collections[image_path].append(collection_id)
    
    # Update image count
    for collection in collections:
        if collection.get("id") == collection_id:
            all_images_in_collection = [
                path for path, colls in image_collections.items()
                if collection_id in colls
            ]
            collection["image_count"] = len(all_images_in_collection)
    
    data["image_collections"] = image_collections
    data["collections"] = collections
    _save_collections(index_dir, data)
    
    return {"status": "ok", "message": "Image added to collection"}


def remove_from_collection(folder_path: Path, collection_id: str, image_path: str) -> dict:
    """Remove an image from a collection"""
    index_dir = get_index_dir(folder_path)
    data = get_collections(folder_path)
    
    image_collections = data.get("image_collections", {})
    collections = data.get("collections", [])
    
    if image_path in image_collections and collection_id in image_collections[image_path]:
        image_collections[image_path].remove(collection_id)
        
        if not image_collections[image_path]:
            del image_collections[image_path]
    
    # Update image count
    for collection in collections:
        if collection.get("id") == collection_id:
            all_images_in_collection = [
                path for path, colls in image_collections.items()
                if collection_id in colls
            ]
            collection["image_count"] = len(all_images_in_collection)
    
    data["image_collections"] = image_collections
    data["collections"] = collections
    _save_collections(index_dir, data)
    
    return {"status": "ok", "message": "Image removed from collection"}


def get_collection_images(folder_path: Path, collection_id: str) -> dict:
    """Get all images in a collection"""
    index_dir = get_index_dir(folder_path)
    data = get_collections(folder_path)
    
    image_collections = data.get("image_collections", {})
    
    # Find all images in this collection
    images = [
        {"path": path, "collections": colls}
        for path, colls in image_collections.items()
        if collection_id in colls
    ]
    
    return {
        "status": "ok",
        "collection_id": collection_id,
        "images": images,
        "count": len(images),
    }


# -------- CHANGE DETECTION --------
_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def check_for_changes(folder_path: Path) -> dict:
    """
    Fast check for new or removed images since last index — no model, no FAISS.

    Compares the current folder contents against the indexed manifest.
    Returns counts of new, removed, and total files so the UI can show a
    re-index banner without running any AI inference.

    Returns:
        {
            "indexed": bool,
            "new_count": int,     # files present on disk but not in index
            "removed_count": int, # files in index but deleted from disk
            "current_count": int, # total image files currently on disk
            "indexed_count": int, # total images in the existing index
        }
    """
    folder_path = Path(folder_path)
    index_dir = get_index_dir(folder_path)

    not_indexed = {
        "indexed": False,
        "new_count": 0,
        "removed_count": 0,
        "current_count": 0,
        "indexed_count": 0,
    }

    if not index_dir.exists():
        return not_indexed

    manifest = _load_manifest(index_dir)
    indexed_files: dict = manifest.get("files", {})
    if not indexed_files:
        return not_indexed

    indexed_paths = set(indexed_files.keys())
    indexed_count = len(indexed_paths)

    # Scan the folder (non-recursive, matching get_image_files behaviour)
    try:
        current_paths = {
            str(p.resolve())
            for p in folder_path.iterdir()
            if p.is_file() and p.suffix.lower() in _IMAGE_EXTENSIONS
        }
    except OSError:
        current_paths = set()

    # Resolve indexed paths so comparison is path-separator agnostic
    resolved_indexed = {str(Path(p).resolve()) for p in indexed_paths}

    new_count = len(current_paths - resolved_indexed)
    removed_count = sum(1 for p in indexed_paths if not Path(p).exists())

    return {
        "indexed": True,
        "new_count": new_count,
        "removed_count": removed_count,
        "current_count": len(current_paths),
        "indexed_count": indexed_count,
    }
