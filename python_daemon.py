#!/usr/bin/env python3
"""
AI Photo Search — Persistent Python Daemon
==========================================
Loads the CLIP model ONCE on startup, then handles JSON commands
sent line-by-line on stdin and writes JSON responses to stdout.

This eliminates the 800ms–2s cold-start that occurs when every user action
spawns a fresh Python process. After the first ~10–30s startup (model load),
all subsequent commands complete in 100–300ms.

Protocol:
  Request:  {"command": "<name>", "args": {...}}  (one JSON line)
  Response: {"status": "ok"|"error", ...}          (one JSON line, flushed)

Commands handled here (non-indexing only):
  search, list, similar, diagnostics, stats, duplicates,
  collections, create-collection, delete-collection,
  add-to-collection, remove-from-collection, collection-images
"""

import sys
import json
import os
import hashlib
import traceback
from pathlib import Path

# ---- Offline-first flags must be set before importing sentence_transformers ----
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

BASE_DIR = Path(__file__).resolve().parent

# ---- Import all folder_indexing helpers ----
from folder_indexing import (
    search_images_in_folder,
    search_similar_images,
    get_index_diagnostics,
    list_images_in_folder,
    get_index_stats,
    cleanup_index,
    get_duplicate_clusters,
    get_collections,
    create_collection,
    delete_collection,
    add_to_collection,
    remove_from_collection,
    get_collection_images,
    remove_images_from_index,
    check_for_changes,
    get_model,
    _image_key,
    generate_thumbnail,
    get_thumb_dir,
    get_folder_analytics_data,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _folder_id(folder: Path) -> str:
    return hashlib.sha256(str(folder).encode()).hexdigest()[:12]


def _thumbnail_path_for(image_path: str, folder: Path) -> Path:
    """
    Return the WebP thumbnail path, generating it on demand if missing.
    Falls back to the original file path on error.
    """
    key = _image_key(Path(image_path))
    thumb_dir = get_thumb_dir(folder)
    thumb_path = thumb_dir / f"{key}.webp"
    if not thumb_path.exists():
        try:
            thumb_dir.mkdir(parents=True, exist_ok=True)
            generate_thumbnail(Path(image_path), thumb_dir, key)
        except Exception:
            return Path(image_path)
    return thumb_path


def _attach_thumbnails(results: list, folder: Path) -> list:
    for r in results:
        r["thumbnail"] = str(_thumbnail_path_for(r["path"], folder))
    return results


def _ok(payload: dict) -> dict:
    payload["status"] = "ok"
    return payload


def _err(message: str) -> dict:
    return {"status": "error", "message": message}


# ---------------------------------------------------------------------------
# Command dispatcher
# ---------------------------------------------------------------------------

def dispatch(command: str, args: dict) -> dict:
    folder_str = args.get("folder", "")
    folder = Path(folder_str).resolve() if folder_str else None

    # ---- search ----
    if command == "search":
        if not folder:
            return _err("Missing 'folder' argument")
        query = args.get("query", "")
        top_k = int(args.get("top_k", 5))
        min_score = args.get("min_score")
        filters = args.get("filters")
        sort_by = args.get("sort_by", "relevance")

        results = search_images_in_folder(
            folder, query,
            top_k=top_k,
            min_score=float(min_score) if min_score is not None else None,
            filters=json.loads(filters) if isinstance(filters, str) else filters,
            sort_by=sort_by,
        )
        _attach_thumbnails(results, folder)
        return _ok({"query": query, "results": results})

    # ---- list ----
    elif command == "list":
        if not folder:
            return _err("Missing 'folder' argument")
        top_k = int(args.get("top_k", 200))
        filters = args.get("filters")
        sort_by = args.get("sort_by", "filename")

        results = list_images_in_folder(
            folder,
            top_k=top_k,
            filters=json.loads(filters) if isinstance(filters, str) else filters,
            sort_by=sort_by,
        )
        _attach_thumbnails(results, folder)
        return _ok({"results": results})

    # ---- similar ----
    elif command == "similar":
        if not folder:
            return _err("Missing 'folder' argument")
        image_path = args.get("image_path", "")
        top_k = int(args.get("top_k", 10))

        results = search_similar_images(folder, image_path, top_k=top_k)
        _attach_thumbnails(results, folder)
        return _ok({"image_path": image_path, "results": results})

    # ---- diagnostics ----
    elif command == "diagnostics":
        if not folder:
            return _err("Missing 'folder' argument")
        return get_index_diagnostics(folder)

    # ---- analytics ----
    elif command == "analytics":
        if not folder:
            return _err("Missing 'folder' argument")
        data = get_folder_analytics_data(folder)
        if "error" in data:
            return _err(data["error"])
        data["status"] = "ok"
        return data

    # ---- stats ----
    elif command == "stats":
        if not folder:
            return _err("Missing 'folder' argument")
        return _ok(get_index_stats(folder))

    # ---- cleanup ----
    elif command == "cleanup":
        if not folder:
            return _err("Missing 'folder' argument")
        return _ok(cleanup_index(folder))

    # ---- duplicates ----
    elif command == "duplicates":
        if not folder:
            return _err("Missing 'folder' argument")
        threshold = float(args.get("threshold", 0.95))
        result = get_duplicate_clusters(folder, threshold)
        fid = _folder_id(folder)
        if result.get("groups"):
            for group in result["groups"]:
                for i, path in enumerate(group):
                    group[i] = {
                        "path": path,
                        "thumbnail": str(_thumbnail_path_for(path, folder)),
                    }
        result.setdefault("status", "ok")
        return result

    # ---- collections ----
    elif command == "collections":
        if not folder:
            return _err("Missing 'folder' argument")
        return _ok(get_collections(folder))

    elif command == "create-collection":
        if not folder:
            return _err("Missing 'folder' argument")
        name = args.get("name", "")
        col = create_collection(folder, name)
        return _ok({"collection": col})

    elif command == "delete-collection":
        if not folder:
            return _err("Missing 'folder' argument")
        col_id = args.get("collection_id", "")
        return _ok(delete_collection(folder, col_id))

    elif command == "add-to-collection":
        if not folder:
            return _err("Missing 'folder' argument")
        col_id = args.get("collection_id", "")
        image_path = args.get("image_path", "")
        return _ok(add_to_collection(folder, col_id, image_path))

    elif command == "remove-from-collection":
        if not folder:
            return _err("Missing 'folder' argument")
        col_id = args.get("collection_id", "")
        image_path = args.get("image_path", "")
        return _ok(remove_from_collection(folder, col_id, image_path))

    elif command == "collection-images":
        if not folder:
            return _err("Missing 'folder' argument")
        col_id = args.get("collection_id", "")
        result = get_collection_images(folder, col_id)
        for img in result.get("images", []):
            img["thumbnail"] = str(_thumbnail_path_for(img["path"], folder))
        result.setdefault("status", "ok")
        return result

    elif command == "remove-from-index":
        if not folder:
            return _err("Missing 'folder' argument")
        paths = args.get("paths", [])
        if not isinstance(paths, list):
            return _err("'paths' must be a list of file paths")
        return remove_images_from_index(folder, paths)

    elif command == "check-changes":
        if not folder:
            return _err("Missing 'folder' argument")
        return check_for_changes(folder)

    else:
        return _err(f"Unknown command: {command}")


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    # Pre-load CLIP model so first user action is fast
    get_model()

    # Signal readiness to the Rust host
    sys.stdout.write(json.dumps({"status": "ready"}) + "\n")
    sys.stdout.flush()

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            response = _err(f"Invalid JSON request: {exc}")
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
            continue

        command = req.get("command", "")
        args = req.get("args", {})

        try:
            response = dispatch(command, args)
        except Exception as exc:
            response = _err(str(exc))
            # Log the traceback to stderr for debugging without polluting stdout
            print(traceback.format_exc(), file=sys.stderr, flush=True)

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
