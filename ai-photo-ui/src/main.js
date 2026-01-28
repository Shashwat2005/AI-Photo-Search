document.addEventListener("DOMContentLoaded", () => {
  let indexedFolder = null;
  let isIndexing = false;

  const searchBtn = document.getElementById("search-btn");
  const selectBtn = document.getElementById("select-folder-btn");
  const statusEl = document.getElementById("status");
  const resultsGrid = document.getElementById("results");

  const { dialog, opener, core } = window.__TAURI__;

  async function openFile(path) {
    try {
      await opener.openPath(path);
    } catch (err) {
      console.error("Failed to open file:", err);
    }
  }

  async function search() {
    const query = document.getElementById("query").value;

    if (!indexedFolder) {
      alert("Please select and index a folder first.");
      return;
    }

    if (!query) {
      statusEl.textContent = "Please enter a search query.";
      return;
    }

    statusEl.textContent = "Searching...";
    resultsGrid.innerHTML = "";

    try {
      const raw = await core.invoke("engine_search", {
        folder: indexedFolder,
        query,
      });

      const data = typeof raw === "string" ? JSON.parse(raw) : raw;

      if (!data.results || data.results.length === 0) {
        statusEl.textContent = "No results found.";
        return;
      }

      statusEl.textContent = `Found ${data.results.length} results`;

      for (const item of data.results) {
        const card = document.createElement("div");
        card.className = "card";
        card.onclick = () => openFile(item.path);

        const img = document.createElement("img");
       img.src = `asset://localhost${item.thumbnail}`;

        card.appendChild(img);
        resultsGrid.appendChild(card);
      }
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Search failed.";
    }
  }

  async function selectFolder() {
    const folderPath = await dialog.open({ directory: true });
    if (!folderPath) return;

    setIndexingState(true);

    try {
      const raw = await core.invoke("engine_index", {
        folder: folderPath,
      });

      const data = typeof raw === "string" ? JSON.parse(raw) : raw;

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
      alert("Something went wrong while indexing 😕");
    } finally {
      setIndexingState(false);
    }
  }

  function setIndexingState(indexing) {
    isIndexing = indexing;
    searchBtn.disabled = indexing;
    selectBtn.disabled = indexing;

    if (indexing) {
      statusEl.textContent = "Indexing images… please wait ⏳";
    }
  }

  searchBtn.addEventListener("click", search);
  selectBtn.addEventListener("click", selectFolder);
});
