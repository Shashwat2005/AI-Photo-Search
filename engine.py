import sys
import json
import hashlib
from pathlib import Path

from folder_indexing import (
    index_images_from_folder,
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
    _image_key,
    generate_thumbnail,
    get_thumb_dir,
    get_folder_analytics_data,
)

# ---------- PATHS ----------
BASE_DIR = Path(__file__).resolve().parent
INDEX_ROOT = BASE_DIR / "indexes"

INDEX_ROOT.mkdir(exist_ok=True)


# ---------- HELPERS ----------
def folder_id(folder: Path) -> str:
    """Stable folder hash"""
    return hashlib.sha256(str(folder).encode()).hexdigest()[:12]


def error(message: str):
    print(json.dumps({
        "status": "error",
        "message": message
    }))
    sys.exit(1)


def success(payload: dict):
    payload["status"] = "ok"
    print(json.dumps(payload))
    sys.exit(0)


def thumbnail_path_for(image_path: str, folder: Path) -> Path:
    """
    Return the WebP thumbnail path for an image.
    Generates it on demand if it doesn't yet exist — this ensures backward
    compatibility with indexes built before thumbnail generation was added.
    Falls back to the original image path if generation fails.
    """
    key = _image_key(Path(image_path))
    thumb_dir = get_thumb_dir(folder)
    thumb_path = thumb_dir / f"{key}.webp"

    if not thumb_path.exists():
        try:
            thumb_dir.mkdir(parents=True, exist_ok=True)
            generate_thumbnail(Path(image_path), thumb_dir, key)
        except Exception:
            # Fall back to original path — frontend has a CSS fallback anyway
            return Path(image_path)

    return thumb_path


# ---------- MAIN ----------
def main():
    if len(sys.argv) < 2:
        error("No command provided")

    command = sys.argv[1]

    # =====================================================
    # INDEX
    # =====================================================
    if command == "index":
        if len(sys.argv) < 3:
            error("Folder path missing")

        folder = Path(sys.argv[2]).resolve()

        if not folder.exists() or not folder.is_dir():
            error("Invalid folder path")

        images = [
            p for p in folder.iterdir()
            if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        ]

        if not images:
            error("This folder contains no images")

        fid = folder_id(folder)

        def _emit_progress(current, total, filepath):
            """Write a progress line to stdout for Rust to forward as a Tauri event."""
            filename = Path(filepath).name if filepath else ""
            line = json.dumps({
                "type": "progress",
                "current": current,
                "total": total,
                "file": filename,
            })
            sys.stdout.write(f"PROGRESS:{line}\n")
            sys.stdout.flush()

        try:
            index_result = index_images_from_folder(folder, on_progress=_emit_progress)

            success({
                "folder": str(folder),
                "folder_id": fid,
                "asset_base": f"/images/{fid}",
                "indexed": index_result.get("indexed", len(images)),
                "cached": bool(index_result.get("cached", False)),
                "added": int(index_result.get("added", 0)),
                "modified": int(index_result.get("modified", 0)),
                "removed": int(index_result.get("removed", 0)),
            })

        except Exception as e:
            error(str(e))

    # =====================================================
    # SEARCH
    # =====================================================
    elif command == "search":
        if len(sys.argv) < 4:
            error("Missing arguments for search")

        folder = Path(sys.argv[2]).resolve()
        query = sys.argv[3]
        top_k = 5
        min_score = None
        filters = None
        sort_by = "relevance"

        if len(sys.argv) >= 5:
            try:
                top_k = max(1, int(sys.argv[4]))
            except ValueError:
                error("top_k must be a positive integer")

        if len(sys.argv) >= 6:
            try:
                min_score = float(sys.argv[5])
            except ValueError:
                error("min_score must be a number")

        if len(sys.argv) >= 7:
            try:
                filters = json.loads(sys.argv[6])
            except json.JSONDecodeError:
                error("filters must be valid JSON")

        if len(sys.argv) >= 8:
            sort_by = sys.argv[7]

        if not folder.exists():
            error("Indexed folder not found")

        try:
            results = search_images_in_folder(folder, query, top_k=top_k, min_score=min_score, 
                                             filters=filters, sort_by=sort_by)
            fid = folder_id(folder)

            # Attach WebP thumbnail path to each result
            for r in results:
                r["thumbnail"] = str(thumbnail_path_for(r['path'], folder))

            success({
                "query": query,
                "results": results
            })

        except Exception as e:
            error(str(e))

    # =====================================================
    # LIST (SORT/FILTER WITHOUT QUERY)
    # =====================================================
    elif command == "list":
        if len(sys.argv) < 3:
            error("Missing arguments for list")

        folder = Path(sys.argv[2]).resolve()
        top_k = 200
        filters = None
        sort_by = "filename"

        if len(sys.argv) >= 4:
            try:
                top_k = max(1, int(sys.argv[3]))
            except ValueError:
                error("top_k must be a positive integer")

        if len(sys.argv) >= 5:
            try:
                filters = json.loads(sys.argv[4])
            except json.JSONDecodeError:
                error("filters must be valid JSON")

        if len(sys.argv) >= 6:
            sort_by = sys.argv[5]

        if not folder.exists():
            error("Indexed folder not found")

        try:
            results = list_images_in_folder(folder, top_k=top_k, filters=filters, sort_by=sort_by)
            fid = folder_id(folder)

            for r in results:
                r["thumbnail"] = str(thumbnail_path_for(r['path'], folder))

            success({
                "results": results
            })
        except Exception as e:
            error(str(e))

    # =====================================================
    # SIMILAR SEARCH
    # =====================================================
    elif command == "similar":
        if len(sys.argv) < 4:
            error("Missing arguments for similar search")

        folder = Path(sys.argv[2]).resolve()
        image_path = sys.argv[3]
        top_k = 10

        if len(sys.argv) >= 5:
            try:
                top_k = max(1, int(sys.argv[4]))
            except ValueError:
                error("top_k must be a positive integer")

        if not folder.exists():
            error("Indexed folder not found")

        try:
            results = search_similar_images(folder, image_path, top_k=top_k)
            fid = folder_id(folder)

            # Attach WebP thumbnail path to each result
            for r in results:
                r["thumbnail"] = str(thumbnail_path_for(r['path'], folder))

            success({
                "image_path": image_path,
                "results": results
            })

        except Exception as e:
            error(str(e))

    # =====================================================
    # DIAGNOSTICS
    # =====================================================
    elif command == "diagnostics":
        if len(sys.argv) < 3:
            error("Missing arguments for diagnostics")

        folder = Path(sys.argv[2]).resolve()

        if not folder.exists():
            error("Folder path not found")

        try:
            diagnostics = get_index_diagnostics(folder)
            success(diagnostics)
        except Exception as e:
            error(str(e))

    # =====================================================
    # ANALYTICS (rich per-file stats — uses correct index path)
    # =====================================================
    elif command == "analytics":
        if len(sys.argv) < 3:
            error("Missing arguments for analytics")

        folder = Path(sys.argv[2]).resolve()

        if not folder.exists():
            error("Folder path not found")

        try:
            data = get_folder_analytics_data(folder)
            success(data)
        except Exception as e:
            error(str(e))

    # =====================================================
    # INDEX STATS (ORPHAN/COMPACTION INFO)
    # =====================================================
    elif command == "stats":
        if len(sys.argv) < 3:
            error("Missing arguments for stats")

        folder = Path(sys.argv[2]).resolve()

        if not folder.exists():
            error("Folder path not found")

        try:
            stats = get_index_stats(folder)
            success(stats)
        except Exception as e:
            error(str(e))

    # =====================================================
    # CLEANUP INDEX (REMOVE ORPHANS & COMPACT)
    # =====================================================
    elif command == "cleanup":
        if len(sys.argv) < 3:
            error("Missing arguments for cleanup")

        folder = Path(sys.argv[2]).resolve()

        if not folder.exists():
            error("Folder path not found")

        try:
            result = cleanup_index(folder)
            success(result)
        except Exception as e:
            error(str(e))

    # =====================================================
    # DETECT DUPLICATES
    # =====================================================
    elif command == "duplicates":
        if len(sys.argv) < 3:
            error("Missing arguments for duplicates")

        folder = Path(sys.argv[2]).resolve()
        similarity_threshold = 0.95

        if len(sys.argv) >= 4:
            try:
                similarity_threshold = float(sys.argv[3])
            except ValueError:
                error("similarity_threshold must be a number between 0 and 1")

        if not folder.exists():
            error("Folder path not found")

        try:
            result = get_duplicate_clusters(folder, similarity_threshold)
            fid = folder_id(folder)

            # Attach WebP thumbnail path for each duplicate image
            if result.get("groups"):
                for group in result["groups"]:
                    for i, path in enumerate(group):
                        group[i] = {
                            "path": path,
                            "thumbnail": str(thumbnail_path_for(path, folder))
                        }

            success(result)
        except Exception as e:
            error(str(e))

    # =====================================================
    # COLLECTIONS
    # =====================================================
    elif command == "collections":
        if len(sys.argv) < 3:
            error("Missing arguments for collections")

        folder = Path(sys.argv[2]).resolve()

        if not folder.exists():
            error("Folder path not found")

        try:
            result = get_collections(folder)
            success(result)
        except Exception as e:
            error(str(e))

    elif command == "create-collection":
        if len(sys.argv) < 4:
            error("Missing arguments for create-collection")

        folder = Path(sys.argv[2]).resolve()
        collection_name = sys.argv[3]

        if not folder.exists():
            error("Folder path not found")

        try:
            result = create_collection(folder, collection_name)
            success({"status": "ok", "collection": result})
        except Exception as e:
            error(str(e))

    elif command == "delete-collection":
        if len(sys.argv) < 4:
            error("Missing arguments for delete-collection")

        folder = Path(sys.argv[2]).resolve()
        collection_id = sys.argv[3]

        if not folder.exists():
            error("Folder path not found")

        try:
            result = delete_collection(folder, collection_id)
            success(result)
        except Exception as e:
            error(str(e))

    elif command == "add-to-collection":
        if len(sys.argv) < 5:
            error("Missing arguments for add-to-collection")

        folder = Path(sys.argv[2]).resolve()
        collection_id = sys.argv[3]
        image_path = sys.argv[4]

        if not folder.exists():
            error("Folder path not found")

        try:
            result = add_to_collection(folder, collection_id, image_path)
            success(result)
        except Exception as e:
            error(str(e))

    elif command == "remove-from-collection":
        if len(sys.argv) < 5:
            error("Missing arguments for remove-from-collection")

        folder = Path(sys.argv[2]).resolve()
        collection_id = sys.argv[3]
        image_path = sys.argv[4]

        if not folder.exists():
            error("Folder path not found")

        try:
            result = remove_from_collection(folder, collection_id, image_path)
            success(result)
        except Exception as e:
            error(str(e))

    elif command == "collection-images":
        if len(sys.argv) < 4:
            error("Missing arguments for collection-images")

        folder = Path(sys.argv[2]).resolve()
        collection_id = sys.argv[3]

        if not folder.exists():
            error("Folder path not found")

        try:
            result = get_collection_images(folder, collection_id)
            fid = folder_id(folder)

            # Add WebP thumbnail paths
            for img in result.get("images", []):
                img["thumbnail"] = str(thumbnail_path_for(img["path"], folder))

            success(result)
        except Exception as e:
            error(str(e))

    elif command == "remove-from-index":
        if len(sys.argv) < 4:
            error("Missing arguments: folder and paths_json required")

        folder = Path(sys.argv[2]).resolve()
        paths_json = sys.argv[3]

        try:
            paths = json.loads(paths_json)
        except json.JSONDecodeError as e:
            error(f"Invalid paths JSON: {e}")

        try:
            result = remove_images_from_index(folder, paths)
            success(result)
        except Exception as e:
            error(str(e))

    elif command == "check-changes":
        if len(sys.argv) < 3:
            error("Missing folder argument")

        folder = Path(sys.argv[2]).resolve()

        try:
            result = check_for_changes(folder)
            success(result)
        except Exception as e:
            error(str(e))

    else:
        error(f"Unknown command: {command}")


if __name__ == "__main__":
    main()
