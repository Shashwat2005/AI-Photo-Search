from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from pydantic import BaseModel
from fastapi.responses import FileResponse
from fastapi import HTTPException

from folder_indexing import (
    index_images_from_folder,
    search_images_in_folder,
)

app = FastAPI()

BASE_DIR = Path(__file__).resolve().parent
IMAGES_DIR = BASE_DIR / "images"


CURRENT_FOLDER: Path | None = None

class FolderRequest(BaseModel):
    path: str

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def health():
    return {"status": "ok"}

@app.post("/set-folder")
def set_folder(data: FolderRequest):
    global CURRENT_FOLDER

    folder = Path(data.path).resolve()

    if not folder.exists() or not folder.is_dir():
        return {
            "status": "error",
            "message": "Invalid folder selected"
        }

    try:
        index_images_from_folder(folder)
    except ValueError as e:
        # 👇 EMPTY FOLDER HANDLED HERE
        return {
            "status": "error",
            "message": str(e)  # "No images found in folder"
        }

    CURRENT_FOLDER = folder

    return {
        "status": "ok",
        "folder": str(folder)
    }


@app.get("/search")
def search(query: str):
    if CURRENT_FOLDER is None:
        return {"status": "error", "message": "No folder selected"}

    raw_results = search_images_in_folder(CURRENT_FOLDER, query)

    results = []
    for item in raw_results:
        image_path = Path(item["path"]).resolve()

        results.append({
            "path": str(image_path),  # for opening via Tauri
            "thumbnail": f"http://127.0.0.1:8000/image?path={image_path}",
            "score": item["score"]
        })

    return {
        "query": query,
        "results": results
    }

@app.get("/image")
def get_image(path: str):
    image_path = Path(path)

    if not image_path.exists():
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(image_path)
