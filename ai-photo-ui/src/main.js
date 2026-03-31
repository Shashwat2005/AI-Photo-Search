import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";

document.addEventListener("DOMContentLoaded", () => {
  let indexedFolder = null;
  let isIndexing = false;

  const searchBtn = document.getElementById("search-btn");
  const selectBtn = document.getElementById("select-folder-btn");
  const statusEl = document.getElementById("status");
  const resultsGrid = document.getElementById("results");

  /* ------------------ OPEN IMAGE ------------------ */
  async function openImage(path) {
    try {
      await openPath(path);
    } catch (err) {
      console.error("Open failed:", err);
    }
  }

  /* ------------------ SEARCH ------------------ */
  async function search() {
    const query = document.getElementById("query").value.trim();

    if (!indexedFolder) {
      alert("Please select a folder first.");
      return;
    }

    if (!query) {
      statusEl.textContent = "Enter a search query.";
      return;
    }

    statusEl.textContent = "Searching...";
    resultsGrid.innerHTML = "";

    try {
      const data = await invoke("engine_search", {
        folder: indexedFolder,
        query
      });

      console.log("Search results:", data);

      if (!data.results || data.results.length === 0) {
        statusEl.textContent = "No results found.";
        return;
      }

      statusEl.textContent = `Found ${data.results.length} results`;

      for (const item of data.results) {
        const card = document.createElement("div");
        card.className = "card";
        card.onclick = () => openImage(item.path);

        const img = document.createElement("img");

        const thumbnailPath = String(item.thumbnail || "");
        img.loading = "lazy";
        img.alt = "Search result image";
        
        // Add error handling for broken images
        img.onerror = () => {
          card.style.opacity = "0.5";
          card.title = "Image failed to load";
          console.warn("Failed to load image:", img.src);
        };

        try {
          img.src = await invoke("thumbnail_data_uri", { path: thumbnailPath });
        } catch (thumbErr) {
          console.warn("Thumbnail data URI failed, trying file URI fallback:", thumbErr);
          const normalizedPath = thumbnailPath.replace(/\\/g, "/");
          img.src = `file:///${encodeURI(normalizedPath)}`;
        }

        console.log("Loading image from:", img.src.slice(0, 64));
        card.appendChild(img);
        resultsGrid.appendChild(card);
      }
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Search failed: ${String(err)}`;
    }
  }

  /* ------------------ SELECT FOLDER ------------------ */
  async function selectFolder() {
    const folderPath = await open({ directory: true });
    if (!folderPath) return;

    setIndexingState(true);

    try {
      const data = await invoke("engine_index", {
        folder: folderPath
      });

      if (data.status !== "ok") {
        alert("Indexing failed ❌\n\n" + data.message);
        indexedFolder = null;
        statusEl.textContent = data.message;
        return;
      }

      indexedFolder = folderPath;
      statusEl.textContent = "Indexed folder: " + indexedFolder;
      resultsGrid.innerHTML = "";
    } catch (err) {
      console.error(err);
      alert("Indexing error.\n\n" + String(err));
      statusEl.textContent = "Indexing failed.";
    } finally {
      setIndexingState(false);
    }
  }

  /* ------------------ UI STATE ------------------ */
  function setIndexingState(state) {
    isIndexing = state;
    searchBtn.disabled = state;
    selectBtn.disabled = state;

    if (state) {
      statusEl.textContent = "Indexing images… please wait ⏳";
    }
  }

  /* ------------------ EVENTS ------------------ */
  searchBtn.addEventListener("click", search);
  selectBtn.addEventListener("click", selectFolder);
});
