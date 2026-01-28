import sys
import json
import hashlib
import shutil
from pathlib import Path

from folder_indexing import (
    index_images_from_folder,
    search_images_in_folder,
)

# ---------- PATHS ----------
BASE_DIR = Path(__file__).resolve().parent
INDEX_ROOT = BASE_DIR / "indexes"
ASSETS_ROOT = BASE_DIR / "src-tauri" / "assets" / "images"

INDEX_ROOT.mkdir(exist_ok=True)
ASSETS_ROOT.mkdir(parents=True, exist_ok=True)


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


def copy_images_to_assets(folder: Path, fid: str):
    """
    Copy images once into Tauri-served assets directory
    """
    dest = ASSETS_ROOT / fid
    dest.mkdir(parents=True, exist_ok=True)

    for img in folder.iterdir():
        if img.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
            target = dest / img.name
            if not target.exists():
                shutil.copy2(img, target)


def folder_already_indexed(folder: Path) -> bool:
    """
    Check if index already exists for folder
    """
    fid = folder_id(folder)
    return (INDEX_ROOT / fid / "index.faiss").exists()


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

        try:
            if not folder_already_indexed(folder):
                index_images_from_folder(folder)
                copy_images_to_assets(folder, fid)

            success({
                "folder": str(folder),
                "folder_id": fid,
                "asset_base": f"/images/{fid}",
                "indexed": len(images),
                "cached": folder_already_indexed(folder),
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

        if not folder.exists():
            error("Indexed folder not found")

        try:
            results = search_images_in_folder(folder, query)
            fid = folder_id(folder)

            # attach thumbnail path
            for r in results:
                r["thumbnail"] = f"/images/{fid}/{Path(r['path']).name}"

            success({
                "query": query,
                "results": results
            })

        except Exception as e:
            error(str(e))

    else:
        error(f"Unknown command: {command}")


if __name__ == "__main__":
    main()
