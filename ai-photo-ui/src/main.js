import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";

/**
 * Returns a debounced version of `fn` that fires only after `delayMs`
 * milliseconds of inactivity. Used for search-as-you-type (F4).
 */
function debounce(fn, delayMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

// LRU Cache for query results
class LRUCache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    const item = this.cache.get(key);
    if (item) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, item);
      return item;
    }
    return undefined;
  }

  set(key, value) {
    // Remove if already exists
    this.cache.delete(key);

    // Add new item
    this.cache.set(key, value);

    // Evict oldest if over capacity
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  clear() {
    this.cache.clear();
  }
}

// Initialize LRU cache for search results
const searchCache = new LRUCache(100);

document.addEventListener("DOMContentLoaded", async () => {
  const appBootStartedAt = performance.now();
  const MIN_SKELETON_MS = 900;
  const SKELETON_FADE_MS = 320;
  let selectedFolders = [];
  let isIndexing = false;
  let isOnline = navigator.onLine;
  let filtersVisible = true;
  let recentSearches = [];
  let pinnedSearches = [];
  let selectedImages = new Set();  // Track selected image paths
  let sortSearchMode = "query"; // query | all
  let lastSortValue = "relevance";
  let pendingSortValue = null;
  let indexQueueRunning = false;
  let indexQueueCancelled = false;
  const indexQueueState = new Map();
  let currentDuplicateGroups = []; // Stores loaded duplicate groups for deletion
  // F2: Pagination state — full result list vs what's displayed
  let _allSearchResults = [];
  let _displayedCount = 0;
  const PAGE_SIZE = 20;         // cards revealed per "Load more" click
  const TOP_K_PER_FOLDER = 200; // max results fetched from backend per folder
  // Progressive streaming: increment on each new search to cancel in-flight streams
  let _streamSearchId = 0;
  // Relevance threshold: fraction 0-1 (UI shows 50-100%)
  let _relevanceThreshold = 0.85;

  const searchBtn = document.getElementById("search-btn");
  const selectBtn = document.getElementById("select-folder-btn");
  const cleanupBtn = document.getElementById("cleanup-btn");
  const pinSearchBtn = document.getElementById("pin-search-btn");
  const appControls = document.getElementById("app-controls");
  const statusEl = document.getElementById("status");
  const resultsGrid = document.getElementById("results");
  const toggleFiltersBtn = document.getElementById("toggle-filters-btn");
  const filtersContainer = document.getElementById("filters-container");
  const indexProgress = document.getElementById("index-progress");
  const indexProgressFill = document.getElementById("index-progress-fill");
  const indexProgressText = document.getElementById("index-progress-text");
  const queryInput = document.getElementById("query");
  const searchHistoryList = document.getElementById("search-history");
  const pinnedSearchesContainer = document.getElementById("pinned-searches-container");
  const pinnedSearchesDiv = document.getElementById("pinned-searches");
  
  // Bulk actions elements
  const bulkActionsBar = document.getElementById("bulk-actions-bar");
  const openSelectedBtn = document.getElementById("open-selected-btn");
  const copyPathsBtn = document.getElementById("copy-paths-btn");
  const deselectAllBtn = document.getElementById("deselect-all-btn");
  const selectedCountSpan = document.getElementById("selected-count");
  const toastEl = document.getElementById("toast");

  const sortConfirmModal = document.getElementById("sort-confirm-modal");
  const sortWithQueryBtn = document.getElementById("sort-with-query-btn");
  const sortOnlyBtn = document.getElementById("sort-only-btn");
  const sortCancelBtn = document.getElementById("sort-cancel-btn");

  const indexQueuePanel = document.getElementById("index-queue-panel");
  const indexQueueSummary = document.getElementById("index-queue-summary");
  const indexQueueList = document.getElementById("index-queue-list");
  const cancelIndexQueueBtn = document.getElementById("cancel-index-queue-btn");
  

    // Cleanup panel elements
    const cleanupIndexBtn = document.getElementById("cleanup-index-btn");
    const cleanupPanel = document.getElementById("cleanup-panel");
    const closeCleanupBtn = document.getElementById("close-cleanup-btn");
    const cleanupContent = document.getElementById("cleanup-content");
    const cleanupStatsDiv = document.getElementById("cleanup-stats");
    const cleanupRunBtn = document.getElementById("cleanup-run-btn");
    const cleanupResultDiv = document.getElementById("cleanup-result");
    const cleanupResultContent = document.getElementById("cleanup-result-content");

    // Duplicates panel elements
    const duplicatesBtn = document.getElementById("duplicates-btn");
    const duplicatesPanel = document.getElementById("duplicates-panel");
    const closeDuplicatesBtn = document.getElementById("close-duplicates-btn");
    const duplicatesContent = document.getElementById("duplicates-content");
    const duplicateThresholdInput = document.getElementById("duplicate-threshold");
    const thresholdValueSpan = document.getElementById("threshold-value");
    const refreshDuplicatesBtn = document.getElementById("refresh-duplicates-btn");

    // Collections panel elements
    const collectionsBtn = document.getElementById("collections-btn");
    const collectionsPanel = document.getElementById("collections-panel");
    const closeCollectionsBtn = document.getElementById("close-collections-btn");
    const collectionsContent = document.getElementById("collections-content");
    const newCollectionInput = document.getElementById("new-collection-input");
    const createCollectionBtn = document.getElementById("create-collection-btn");

    // Skeleton screen element
    const skeletonScreen = document.getElementById("skeleton-screen");

    // Filename search modal elements
    const filenameSearchModal = document.getElementById("filename-search-modal");
    const filenameSearchInput = document.getElementById("filename-search-input");
    const filenameSearchBtn = document.getElementById("filename-search-btn");
    const filenameCancelBtn = document.getElementById("filename-cancel-btn");

    // Analytics panel elements
    const analyticsBtn          = document.getElementById("analytics-btn");
    const analyticsPanel        = document.getElementById("analytics-panel");
    const closeAnalyticsBtn     = document.getElementById("close-analytics-btn");
    const analyticsPanelContent = document.getElementById("analytics-panel-content");

    // S7: Command palette
    const cmdPaletteOverlay = document.getElementById("cmd-palette-overlay");
    const cmdPaletteInput   = document.getElementById("cmd-palette-input");
    const cmdPaletteList    = document.getElementById("cmd-palette-list");
    const paletteBtn        = document.getElementById("palette-btn");

    // S7: Export metadata
    const exportMetadataBtn = document.getElementById("export-metadata-btn");

    // S8: Batch rename
    const renameSelectedBtn   = document.getElementById("rename-selected-btn");
    const renameModalOverlay  = document.getElementById("rename-modal-overlay");
    const renamePatternInput  = document.getElementById("rename-pattern-input");
    const renamePreviewList   = document.getElementById("rename-preview-list");
    const renamePreviewNote   = document.getElementById("rename-preview-note");
    const renameConfirmBtn    = document.getElementById("rename-confirm-btn");
    const renameCancelBtn     = document.getElementById("rename-cancel-btn");
    const renameModalClose    = document.getElementById("rename-modal-close");

    // S8: Keyboard shortcuts overlay
    const shortcutsOverlay    = document.getElementById("shortcuts-overlay");
    const closeShortcutsBtn   = document.getElementById("close-shortcuts-btn");
    const sbShortcutsBtn      = document.getElementById("sb-shortcuts-btn");

    // S8: Auto-scan badge
    const sbScanBadge         = document.getElementById("sb-scan-badge");

    // S9: Slideshow
    const slideshowPlayBtn    = document.getElementById("slideshow-play-btn");
    const slideshowSpeed      = document.getElementById("slideshow-speed");

    // S9: Compare modal
    const compareSelectedBtn  = document.getElementById("compare-selected-btn");
    const compareModal        = document.getElementById("compare-modal");
    const compareModalClose   = document.getElementById("compare-modal-close");
    const compareImgA         = document.getElementById("compare-img-a");
    const compareImgB         = document.getElementById("compare-img-b");
    const compareLabelA       = document.getElementById("compare-label-a");
    const compareLabelB       = document.getElementById("compare-label-b");

    // S9: Tag editor
    const lightboxTagBtn      = document.getElementById("lightbox-tag-btn");
    const tagEditorPanel      = document.getElementById("tag-editor-panel");
    const tagEditorClose      = document.getElementById("tag-editor-close");
    const tagChipsRow         = document.getElementById("tag-chips-row");
    const tagInput            = document.getElementById("tag-input");
    const tagAddBtn           = document.getElementById("tag-add-btn");
    const tagSuggestionsRow   = document.getElementById("tag-suggestions-row");

    // Lightbox elements (F1)
    const lightboxOverlay   = document.getElementById("lightbox-overlay");
    const lightboxImg       = document.getElementById("lightbox-img");
    const lightboxMeta      = document.getElementById("lightbox-meta");
    const lightboxClose     = document.getElementById("lightbox-close");
    const lightboxPrev      = document.getElementById("lightbox-prev");
    const lightboxNext      = document.getElementById("lightbox-next");
    const lightboxOpenBtn   = document.getElementById("lightbox-open-btn");
    const lightboxSimilarBtn = document.getElementById("lightbox-similar-btn");
    const lightboxCollectBtn = document.getElementById("lightbox-collection-btn");

    // Change banner (F3)
    const changeBanner = document.getElementById("change-banner");

    // S6 elements
    const dropOverlay       = document.getElementById("drop-overlay");
    const statusBar         = document.getElementById("status-bar");
    const sbPhotos          = document.getElementById("sb-photos");
    const sbFolders         = document.getElementById("sb-folders");
    const sbLastIndexed     = document.getElementById("sb-last-indexed");
    const sbDiagBtn         = document.getElementById("sb-diag-btn");
    const resultsHeader     = document.getElementById("results-header");
    const resultsCountLabel = document.getElementById("results-count-label");
    const timelineToggleBtn = document.getElementById("timeline-toggle-btn");

    // Lightbox state (F1)
    let _lbIndex = 0;       // current index in _allSearchResults
    let _timelineMode = false; // S6-F2: timeline vs flat-grid toggle

    // Store search statistics
    let searchStats = {
      totalSearches: 0,
      totalResults: 0,
      recentSearches: [],
      folderStats: {}
    };
  

    /* --------------- CLEANUP PANEL MANAGEMENT --------------- */
    async function showCleanupPanel() {
      if (selectedFolders.length === 0) {
        alert("Please select a folder first");
        return;
      }

      if (selectedFolders.length > 1) {
        alert("Cleanup is available for one folder at a time. Please select a single folder.");
        return;
      }

      const indexedFolder = selectedFolders[0];

      cleanupPanel.style.display = "flex";
      cleanupStatsDiv.innerHTML = "<p>Loading index statistics...</p>";
      cleanupResultDiv.style.display = "none";
      cleanupRunBtn.disabled = false;

      try {
        const data = await invoke("engine_stats", {
          folder: indexedFolder
        });

        console.log("Index stats:", data);

        let statsHtml = '';
        
        if (data.error) {
          statsHtml = `<p style="color: #d32f2f;">Error: ${data.error}</p>`;
        } else {
          const fragPercent = data.fragmentation_percent || 0;
          const needsCleanup = data.orphaned_embeddings > 0;
          const fragColor = fragPercent > 20 ? '#d32f2f' : '#ffc107';

          statsHtml = `
            <p><strong>Total Indexed Images:</strong> <span>${data.total_indexed_images}</span></p>
            <p><strong>Total Embeddings Files:</strong> <span>${data.total_embeddings}</span></p>
            <p><strong>Orphaned Embeddings:</strong> <span style="color: ${needsCleanup ? '#d32f2f' : '#28a745'}">${data.orphaned_embeddings}</span></p>
            <p><strong>Orphaned Size:</strong> <span>${data.orphaned_size_mb.toFixed(2)} MB</span></p>
            <p><strong>Fragmentation:</strong> <span style="color: ${fragColor}">${fragPercent.toFixed(1)}%</span></p>
            ${needsCleanup ? '<p style="color: #d32f2f; font-weight: bold;">⚠️ Cleanup recommended!</p>' : '<p style="color: #28a745;">✓ Index is healthy!</p>'}
          `;
        }

        cleanupStatsDiv.innerHTML = statsHtml;
      } catch (err) {
        console.error("Failed to load stats:", err);
        cleanupStatsDiv.innerHTML = `<p style="color: #d32f2f;">Failed to load stats: ${String(err)}</p>`;
      }
    }

    function closeCleanupPanel() {
      cleanupPanel.style.display = "none";
    }

    async function runCleanup() {
      if (selectedFolders.length === 0) {
        alert("Please select a folder first");
        return;
      }

      if (selectedFolders.length > 1) {
        alert("Cleanup is available for one folder at a time. Please select a single folder.");
        return;
      }

      const indexedFolder = selectedFolders[0];

      cleanupRunBtn.disabled = true;
      cleanupRunBtn.textContent = "⏳ Running Cleanup...";
      cleanupResultDiv.style.display = "none";

      try {
        const result = await invoke("engine_cleanup", {
          folder: indexedFolder
        });

        console.log("Cleanup result:", result);

        // Prepare result display
        const orphanResult = result.orphan_cleanup || {};
        const compactResult = result.compaction || {};
        const statsAfter = result.stats_after || {};

        let resultHtml = `
<strong>Orphan Cleanup:</strong>
  Deleted: ${orphanResult.deleted}/${orphanResult.total} files
  Freed: ${(orphanResult.size_freed_mb || 0).toFixed(2)} MB

<strong>Index Compaction:</strong>
  Status: ${compactResult.compacted ? '✓ Success' : '✗ Failed'}
  Entries: ${compactResult.entries_before} → ${compactResult.entries_after}
  Size: ${(compactResult.before_size_mb || 0).toFixed(2)} → ${(compactResult.after_size_mb || 0).toFixed(2)} MB
  Saved: ${(compactResult.space_saved_mb || 0).toFixed(2)} MB

<strong>Statistics After Cleanup:</strong>
  Fragmentation: ${(statsAfter.fragmentation_percent || 0).toFixed(1)}%
  Orphaned: ${statsAfter.orphaned_embeddings}/${statsAfter.total_embeddings}
        `;

        cleanupResultContent.textContent = resultHtml;
        cleanupResultDiv.style.display = "block";

        // Re-load stats
        await showCleanupPanel();
      } catch (err) {
        console.error("Cleanup failed:", err);
        cleanupResultContent.textContent = `Error: ${String(err)}`;
        cleanupResultDiv.style.display = "block";
      } finally {
        cleanupRunBtn.disabled = false;
        cleanupRunBtn.textContent = "🚀 Run Cleanup & Compaction";
      }
    }

    /* --------------- DUPLICATES PANEL MANAGEMENT --------------- */
    async function showDuplicatesPanel() {
      if (selectedFolders.length === 0) {
        alert("Please select a folder first");
        return;
      }
      await loadDuplicates();
    }

    async function loadDuplicates() {
      const threshold = parseFloat(duplicateThresholdInput.value);

      duplicatesPanel.style.display = "flex";
      const folderLabel = selectedFolders.length === 1
        ? selectedFolders[0].split(/[\\/]/).pop()
        : `${selectedFolders.length} folders`;
      duplicatesContent.innerHTML = `<p>Analyzing ${escapeHtml(folderLabel)} for duplicates…</p>`;

      try {
        // Run duplicate detection on all selected folders in parallel
        const perFolderResults = await Promise.all(
          selectedFolders.map(async (folder) => {
            try {
              const data = await invoke("engine_duplicates", { folder, threshold });
              if (data.error) return { folder, groups: [], error: data.error };
              // Tag every item in every group with its source folder
              const groups = (data.groups || []).map(group =>
                group.map(item => ({ ...item, _folder: folder }))
              );
              return {
                folder,
                groups,
                total_images: data.total_images || 0,
                group_count: data.group_count || 0,
                duplicate_count: data.duplicate_count || 0,
              };
            } catch (err) {
              return { folder, groups: [], error: String(err) };
            }
          })
        );

        // Merge all groups from all folders
        const allGroups = perFolderResults.flatMap(r => r.groups);
        const totalImages = perFolderResults.reduce((s, r) => s + (r.total_images || 0), 0);
        const totalGroupCount = allGroups.length;
        const totalDuplicates = allGroups.reduce((s, g) => s + Math.max(0, g.length - 1), 0);
        const errors = perFolderResults.filter(r => r.error).map(r =>
          `${r.folder.split(/[\\/]/).pop()}: ${r.error}`);

        currentDuplicateGroups = allGroups;

        if (allGroups.length === 0) {
          const errNote = errors.length > 0
            ? `<p style="color:#f87171;font-size:12px;">Errors: ${errors.map(escapeHtml).join(', ')}</p>` : '';
          duplicatesContent.innerHTML = `
            <div class="duplicates-summary">
              <p>✅ No duplicate images found across ${selectedFolders.length} folder(s)!</p>
              <p>Analyzed ${totalImages} images at ${(threshold * 100).toFixed(0)}% similarity.</p>
              ${errNote}
            </div>`;
          return;
        }

        let html = `
          <div class="duplicates-summary">
            <p><strong>${totalGroupCount}</strong> duplicate group(s) across ${selectedFolders.length} folder(s)</p>
            <p><strong>${totalDuplicates}</strong> redundant image(s) from ${totalImages} total</p>
            <p>Threshold: ${(threshold * 100).toFixed(0)}% similarity</p>
            ${errors.length > 0 ? `<p style="color:#f87171;font-size:12px;">Skipped: ${errors.map(escapeHtml).join(', ')}</p>` : ''}
          </div>`;

        for (let groupIdx = 0; groupIdx < allGroups.length; groupIdx++) {
          const group = allGroups[groupIdx];
          // Group folder label (all items in a group share the same _folder)
          const groupFolder = group[0]?._folder?.split(/[\\/]/).pop() || '';
          html += `
            <div class="duplicate-group">
              <div class="duplicate-group-header">
                <span>Group ${groupIdx + 1} — ${group.length} images${selectedFolders.length > 1 ? ` · ${escapeHtml(groupFolder)}` : ''}</span>
                <div class="duplicate-group-actions">
                  <button class="delete-duplicate-group-btn" data-group-idx="${groupIdx}">Delete Others</button>
                </div>
              </div>
              <div class="duplicate-group-images">`;

          for (let i = 0; i < group.length; i++) {
            const item = group[i];
            const isNewest = i === 0;
            const className = isNewest ? 'duplicate-item newest' : 'duplicate-item';
            const label = escapeHtml(`${basename(item.path || '')}${isNewest ? ' (Newest)' : ''}`);
            const safePath = escapeHtml(item.path || '');
            const thumbSrc = escapeHtml(toAssetUrl(item.thumbnail || item.path || ''));
            html += `
              <div class="${className}" title="${safePath}">
                <img src="${thumbSrc}" alt="duplicate" loading="lazy"/>
                <div class="duplicate-item-label">${i + 1}. ${label}</div>
              </div>`;
          }

          html += `</div></div>`;
        }

        duplicatesContent.innerHTML = html;
      } catch (err) {
        console.error("Failed to load duplicates:", err);
        duplicatesContent.innerHTML = `<p style="color: #d32f2f;">Failed to load duplicates: ${String(err)}</p>`;
      }
    }

    function closeDuplicatesPanel() {
      duplicatesPanel.style.display = "none";
    }

    async function deleteDuplicateGroup(groupIdx) {
      const group = currentDuplicateGroups[groupIdx];
      if (!group || group.length < 2) {
        showToast("Group not found or has fewer than 2 images");
        return;
      }

      const keepItem = group[0];
      const deleteItems = group.slice(1);
      const keepName = basename(keepItem.path || keepItem);
      const deleteNames = deleteItems.map(item => basename(item.path || item)).join('\n  • ');

      const confirmed = confirm(
        `Keep newest and delete ${deleteItems.length} duplicate(s)?\n\nKeep:\n  ${keepName}\n\nDelete:\n  • ${deleteNames}\n\nThis cannot be undone.`
      );
      if (!confirmed) return;

      // Each item carries _folder from loadDuplicates — use it for the re-index call
      const folderForGroup = group[0]._folder || selectedFolders[0];
      let deletedCount = 0;
      const errors = [];

      for (const item of deleteItems) {
        const filePath = item.path || item;
        try {
          await invoke("delete_file", { path: filePath });
          deletedCount++;
        } catch (err) {
          errors.push(`${basename(filePath)}: ${String(err)}`);
        }
      }

      try {
        statusEl.textContent = "Updating index…";
        const deletedPaths = deleteItems
          .filter((_, i) => !errors.some(e => e.startsWith(basename(deleteItems[i]?.path || deleteItems[i]))))
          .map(item => item.path || item);
        if (deletedPaths.length > 0) {
          await invoke("engine_remove_from_index", {
            folder: folderForGroup,
            paths: deletedPaths,
          });
        }
        searchCache.clear();
      } catch (err) {
        console.warn("Fast re-index after deletion failed:", err);
      }

      if (errors.length > 0) {
        alert(`Deleted ${deletedCount} file(s).\nErrors:\n${errors.join('\n')}`);
      } else {
        showToast(`✓ Deleted ${deletedCount} duplicate(s)`);
      }

      statusEl.textContent = "";
      await loadDuplicates();
    }

    /* --------------- COLLECTIONS PANEL MANAGEMENT --------------- */
    // Collections are stored globally — they work across any number of selected folders.
    // The `folder` argument passed to Rust commands is just a routing token; the
    // actual storage is BASE_DIR/collections.json which is folder-independent.
    function _collectionsFolder() {
      // Use first selected folder as the routing token. Collections are global so
      // it doesn't matter which folder we pick — the data is the same.
      return selectedFolders[0] || "";
    }

    async function showCollectionsPanel() {
      if (selectedFolders.length === 0) {
        alert("Please select at least one folder first");
        return;
      }
      await loadCollections();
    }

    async function loadCollections() {
      collectionsPanel.style.display = "flex";
      collectionsContent.innerHTML = "<p>Loading collections…</p>";

      try {
        const data = await invoke("engine_collections", {
          folder: _collectionsFolder()
        });

        const collections = Array.isArray(data?.collections) ? data.collections : [];

        if (collections.length === 0) {
          collectionsContent.innerHTML = `
            <div class="empty-collections">
              <p>📚 No collections yet</p>
              <p>Create a collection above to organise your photos across all folders</p>
            </div>`;
          return;
        }

        let html = '';
        for (const collection of collections) {
          const cid = escapeHtml(collection.id);
          const cname = escapeHtml(collection.name);
          html += `
            <div class="collection-item">
              <div class="collection-item-header">
                <div class="collection-item-name">${cname}</div>
                <div class="collection-item-count">${collection.image_count} image${collection.image_count !== 1 ? 's' : ''}</div>
                <div class="collection-item-actions">
                  <button data-action="view-collection"   data-collection-id="${cid}">View</button>
                  <button data-action="add-images-to-collection" data-collection-id="${cid}" data-collection-name="${cname}">📸 Add</button>
                  <button data-action="export-collection" data-collection-id="${cid}" data-collection-name="${cname}">&#x1F4E4; Export</button>
                  <button class="delete-btn" data-action="delete-collection" data-collection-id="${cid}">Delete</button>
                </div>
              </div>
            </div>`;
        }
        collectionsContent.innerHTML = html;
      } catch (err) {
        console.error("Failed to load collections:", err);
        collectionsContent.innerHTML = `<p style="color:#d32f2f;">Failed to load collections: ${escapeHtml(String(err))}</p>`;
      }
    }

    async function createNewCollection() {
      const name = newCollectionInput.value.trim();
      if (!name) {
        alert("Please enter a collection name");
        return;
      }
      if (selectedFolders.length === 0) {
        alert("Please select at least one folder first");
        return;
      }

      try {
        const result = await invoke("engine_create_collection", {
          folder: _collectionsFolder(),
          name
        });
        newCollectionInput.value = "";
        // Daemon returns: { status: "ok", collection: { id, name, ... } }
        // Subprocess fallback returns the collection dict directly
        const col = result?.collection || result;
        const collectionId = col?.id || "";
        console.log("Created collection:", col, "id:", collectionId);
        showToast(`✓ Collection "${name}" created! Now pick images to add.`);
        if (collectionId) {
          await openAddImagesFlow(collectionId, name);
        } else {
          await loadCollections();
        }
      } catch (err) {
        console.error("Failed to create collection:", err);
        alert(`Failed to create collection: ${String(err)}`);
      }
    }

    /* ── ADD IMAGES TO COLLECTION FLOW ── */
    // State for the add-images panel
    const _aic = {
      collectionId: null,
      collectionName: null,
      selected: new Set(),  // selected image paths
      results: [],          // current search result items
    };

    async function openAddImagesFlow(collectionId, collectionName) {
      _aic.collectionId   = collectionId;
      _aic.collectionName = collectionName;
      _aic.selected       = new Set();
      _aic.results        = [];

      collectionsPanel.style.display = "flex";
      collectionsContent.innerHTML = `
        <div class="aic-panel" id="aic-panel">
          <div class="aic-header">
            <div class="aic-title">
              <span class="aic-icon">📸</span>
              <div>
                <div class="aic-heading">Add images to &ldquo;${escapeHtml(collectionName)}&rdquo;</div>
                <div class="aic-sub">Images are searched across all selected folders</div>
              </div>
            </div>
          </div>
          <div class="aic-search-row">
            <input id="aic-query-input" class="aic-query-input"
                   type="text" placeholder="Refine search query…"
                   value="${escapeHtml(collectionName)}" />
            <button id="aic-search-btn" class="aic-search-btn">Search</button>
          </div>
          <div id="aic-results" class="aic-results">
            <div class="aic-loading">Searching for images matching &ldquo;${escapeHtml(collectionName)}&rdquo;&hellip;</div>
          </div>
          <div class="aic-footer">
            <button id="aic-add-btn" class="aic-add-btn" disabled>Add 0 images</button>
            <button id="aic-select-all-btn" class="aic-select-all-btn">Select All</button>
            <button id="aic-skip-btn" class="aic-skip-btn">Done &rarr; View Collections</button>
          </div>
        </div>`;

      // Wire up controls
      document.getElementById("aic-search-btn").addEventListener("click", () => _aicRunSearch());
      document.getElementById("aic-query-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") _aicRunSearch();
      });
      document.getElementById("aic-add-btn").addEventListener("click", _aicAddSelected);
      document.getElementById("aic-select-all-btn").addEventListener("click", _aicToggleSelectAll);
      document.getElementById("aic-skip-btn").addEventListener("click", loadCollections);

      // Kick off initial search with the collection name
      await _aicRunSearch();
    }

    async function _aicRunSearch() {
      if (selectedFolders.length === 0) return;
      const queryEl   = document.getElementById("aic-query-input");
      const resultsEl = document.getElementById("aic-results");
      if (!queryEl || !resultsEl) return;

      const query = queryEl.value.trim() || _aic.collectionName;
      resultsEl.innerHTML = `<div class="aic-loading">Searching for &ldquo;${escapeHtml(query)}&rdquo;&hellip;</div>`;

      // Already-added image paths for this collection
      let alreadyAdded = new Set();
      try {
        const existing = await invoke("engine_collection_images", {
          folder: _collectionsFolder(),
          collectionId: _aic.collectionId
        });
        (existing?.images || []).forEach(img => alreadyAdded.add(img.path));
      } catch (e) {
        console.warn("Could not load existing collection images:", e);
      }

      // Semantic search across all selected folders in parallel
      const perFolder = await Promise.all(
        selectedFolders.map(async (folder) => {
          try {
            const data = await invoke("engine_search", {
              folder,
              query,
              filters: null,
              sortBy: "relevance",
              topK: 30
            });
            const results = Array.isArray(data?.results) ? data.results : [];
            return results.map(r => ({ ...r, _folder: folder }));
          } catch (err) {
            console.error(`AIC search failed for folder "${folder}":`, err);
            return [];
          }
        })
      );

      // Merge & deduplicate by path
      const seen = new Set();
      const items = perFolder.flat().filter(r => {
        if (!r.path || seen.has(r.path)) return false;
        seen.add(r.path);
        return true;
      });

      _aic.results = items;
      // Keep selections valid
      for (const p of [..._aic.selected]) {
        if (!seen.has(p)) _aic.selected.delete(p);
      }

      if (items.length === 0 && perFolder.every(a => a.length === 0)) {
        resultsEl.innerHTML = `<div class="aic-empty">No images found for &ldquo;${escapeHtml(query)}&rdquo;. Try a different query or make sure folders are indexed.</div>`;
        _aicUpdateFooter();
        return;
      }

      _aicRenderGrid(alreadyAdded);
    }

    function _aicRenderGrid(alreadyAdded = new Set()) {
      const resultsEl = document.getElementById("aic-results");
      if (!resultsEl) return;

      if (_aic.results.length === 0) {
        resultsEl.innerHTML = `<div class="aic-empty">No images found. Try a different search query.</div>`;
        _aicUpdateFooter();
        return;
      }

      let html = `<div class="aic-grid">`;
      for (const item of _aic.results) {
        const p    = item.path || "";
        const safe = escapeHtml(p);
        const thumb = escapeHtml(toAssetUrl(item.thumbnail || p));
        const name  = escapeHtml(p.split(/[/\\]/).pop());
        const score = item.score != null ? Math.round(item.score * 100) : null;
        const isAdded    = alreadyAdded.has(p);
        const isSelected = _aic.selected.has(p);

        html += `
          <div class="aic-card${isSelected ? " selected" : ""}${isAdded ? " already-added" : ""}"
               data-path="${safe}" title="${name}">
            <img src="${thumb}" alt="${name}" loading="lazy" />
            ${isAdded
              ? `<div class="aic-badge added">✓ Added</div>`
              : `<div class="aic-checkbox${isSelected ? " checked" : ""}">${isSelected ? "✓" : ""}</div>`
            }
            ${score !== null ? `<div class="aic-score">${score}%</div>` : ""}
            <div class="aic-name">${name}</div>
          </div>`;
      }
      html += `</div>`;
      resultsEl.innerHTML = html;

      // Click to toggle selection
      resultsEl.querySelectorAll(".aic-card:not(.already-added)").forEach(card => {
        card.addEventListener("click", () => {
          const path = card.dataset.path;
          if (_aic.selected.has(path)) {
            _aic.selected.delete(path);
            card.classList.remove("selected");
            const cb = card.querySelector(".aic-checkbox");
            if (cb) { cb.classList.remove("checked"); cb.textContent = ""; }
          } else {
            _aic.selected.add(path);
            card.classList.add("selected");
            const cb = card.querySelector(".aic-checkbox");
            if (cb) { cb.classList.add("checked"); cb.textContent = "✓"; }
          }
          _aicUpdateFooter();
        });
      });

      _aicUpdateFooter();
    }

    function _aicUpdateFooter() {
      const addBtn = document.getElementById("aic-add-btn");
      const selAllBtn = document.getElementById("aic-select-all-btn");
      if (!addBtn) return;
      const n = _aic.selected.size;
      addBtn.textContent = n === 0 ? "Add 0 images" : `Add ${n} image${n !== 1 ? "s" : ""} →`;
      addBtn.disabled = n === 0;
      // Toggle Select All label
      if (selAllBtn) {
        const selectable = _aic.results.filter(r => r.path).length;
        selAllBtn.textContent = _aic.selected.size >= selectable ? "Deselect All" : "Select All";
      }
    }

    function _aicToggleSelectAll() {
      const selectable = _aic.results.filter(r => r.path);
      const allSelected = _aic.selected.size >= selectable.length;
      if (allSelected) {
        _aic.selected.clear();
      } else {
        selectable.forEach(r => _aic.selected.add(r.path));
      }
      // Re-render to reflect state
      _aicRenderGrid(); // alreadyAdded not needed here, just re-render
      // Re-render preserving already-added info (best-effort; avoid extra await)
      const resultsEl = document.getElementById("aic-results");
      if (resultsEl) {
        resultsEl.querySelectorAll(".aic-card:not(.already-added)").forEach(card => {
          const path = card.dataset.path;
          const cb = card.querySelector(".aic-checkbox");
          if (_aic.selected.has(path)) {
            card.classList.add("selected");
            if (cb) { cb.classList.add("checked"); cb.textContent = "✓"; }
          } else {
            card.classList.remove("selected");
            if (cb) { cb.classList.remove("checked"); cb.textContent = ""; }
          }
          card.addEventListener("click", () => {
            if (_aic.selected.has(path)) {
              _aic.selected.delete(path);
              card.classList.remove("selected");
              if (cb) { cb.classList.remove("checked"); cb.textContent = ""; }
            } else {
              _aic.selected.add(path);
              card.classList.add("selected");
              if (cb) { cb.classList.add("checked"); cb.textContent = "✓"; }
            }
            _aicUpdateFooter();
          });
        });
      }
      _aicUpdateFooter();
    }

    async function _aicAddSelected() {
      if (_aic.selected.size === 0 || !_aic.collectionId) return;
      const addBtn = document.getElementById("aic-add-btn");
      if (addBtn) { addBtn.disabled = true; addBtn.textContent = "Adding…"; }

      const paths = [..._aic.selected];
      let added = 0, errors = [];

      for (const imagePath of paths) {
        try {
          await invoke("engine_add_to_collection", {
            folder: _collectionsFolder(),
            collectionId: _aic.collectionId,
            imagePath
          });
          added++;
        } catch (err) {
          errors.push(imagePath.split(/[/\\]/).pop());
        }
      }

      _aic.selected.clear();

      if (errors.length > 0) {
        showToast(`Added ${added}. Failed: ${errors.join(", ")}`);
      } else {
        showToast(`✓ Added ${added} image${added !== 1 ? "s" : ""} to "${_aic.collectionName}"`);
      }

      // Re-run search to refresh already-added badges
      await _aicRunSearch();
    }


    async function viewCollection(collectionId) {
      if (selectedFolders.length === 0) {
        alert("Please select at least one folder first");
        return;
      }

      try {
        const result = await invoke("engine_collection_images", {
          folder: _collectionsFolder(),
          collectionId
        });

        const images = Array.isArray(result?.images) ? result.images : [];
        if (images.length === 0) {
          statusEl.textContent = "This collection has no images yet.";
          return;
        }

        // Images may come from any folder — build thumbnails via toAssetUrl
        await displayResults(images.map(img => ({
          path: img.path,
          thumbnail: img.thumbnail || toAssetUrl(img.path),
          score: 1.0
        })));
        statusEl.textContent = `Showing ${images.length} image(s) from collection.`;
        closeCollectionsPanel();
      } catch (err) {
        console.error("Failed to load collection images:", err);
        alert(`Failed to load collection images: ${String(err)}`);
      }
    }

    async function deleteCollection(collectionId) {
      if (!confirm("Delete this collection? (Images will not be deleted)")) return;
      if (selectedFolders.length === 0) {
        alert("Please select at least one folder first");
        return;
      }

      try {
        await invoke("engine_delete_collection", {
          folder: _collectionsFolder(),
          collectionId
        });
        await loadCollections();
        showToast("Collection deleted.");
      } catch (err) {
        console.error("Failed to delete collection:", err);
        alert(`Failed to delete collection: ${String(err)}`);
      }
    }

    // In-panel picker for "Add to Collection" — replaces the blocking prompt()
    let _addToCollPickerImage = null;

    async function addImageToCollection(imagePath) {
      if (selectedFolders.length === 0) {
        alert("Please select at least one folder first");
        return;
      }

      _addToCollPickerImage = imagePath;

      try {
        const data = await invoke("engine_collections", { folder: _collectionsFolder() });
        const collections = Array.isArray(data?.collections) ? data.collections : [];

        if (collections.length === 0) {
          // Open panel and let user create a collection first
          collectionsPanel.style.display = "flex";
          await loadCollections();
          showToast("Create a collection first, then add the image to it.");
          return;
        }

        // Build a quick inline picker overlay inside the collections panel
        collectionsPanel.style.display = "flex";
        const fname = escapeHtml(imagePath.split(/[/\\]/).pop());
        const opts = collections.map((c, i) => `
          <button class="coll-pick-btn" data-coll-id="${escapeHtml(c.id)}" data-coll-name="${escapeHtml(c.name)}">
            <span class="coll-pick-name">${escapeHtml(c.name)}</span>
            <span class="coll-pick-count">${c.image_count} imgs</span>
          </button>`).join("");

        collectionsContent.innerHTML = `
          <div class="coll-picker">
            <p class="coll-picker-title">Add <strong>${fname}</strong> to collection:</p>
            <div class="coll-picker-list">${opts}</div>
            <button class="coll-picker-cancel">Cancel</button>
          </div>`;

        // Handle pick
        collectionsContent.addEventListener("click", async function _pick(e) {
          const btn = e.target.closest(".coll-pick-btn");
          const cancel = e.target.closest(".coll-picker-cancel");
          if (!btn && !cancel) return;

          collectionsContent.removeEventListener("click", _pick);

          if (cancel) {
            await loadCollections();
            return;
          }

          const collId   = btn.dataset.collId;
          const collName = btn.dataset.collName;

          try {
            await invoke("engine_add_to_collection", {
              folder: _collectionsFolder(),
              collectionId: collId,
              imagePath: _addToCollPickerImage
            });
            showToast(`✓ Added to "${collName}"`);
          } catch (err) {
            alert(`Failed to add: ${String(err)}`);
          }
          _addToCollPickerImage = null;
          await loadCollections();
        }, { once: false }); // once:false because we remove it manually

      } catch (err) {
        console.error("Failed to add image to collection:", err);
        alert(`Failed to add image to collection: ${String(err)}`);
      }
    }

    function closeCollectionsPanel() {
      collectionsPanel.style.display = "none";
    }

    /* ------------------ SKELETON SCREEN MANAGEMENT ------------------ */
    async function hideSkeleton() {
      const elapsed = performance.now() - appBootStartedAt;
      const remaining = Math.max(0, MIN_SKELETON_MS - elapsed);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }

      if (skeletonScreen) {
        if (skeletonScreen.classList.contains("is-hiding") || skeletonScreen.style.display === "none") {
          return;
        }

        skeletonScreen.classList.add("is-hiding");
        await new Promise((resolve) => setTimeout(resolve, SKELETON_FADE_MS));
        skeletonScreen.style.display = "none";
        skeletonScreen.classList.remove("is-hiding");
      }
    }

    function showSkeleton() {
      if (skeletonScreen) {
        skeletonScreen.classList.remove("is-hiding");
        skeletonScreen.style.display = "flex";
      }
    }

    /* ------------------ ANALYTICS PANEL MANAGEMENT ------------------ */
    async function showAnalytics() {
      if (selectedFolders.length === 0) {
        alert("Please select a folder first");
        return;
      }
      analyticsPanel.style.display = "flex";
      analyticsPanelContent.innerHTML = `<p style="color:rgba(255,255,255,0.4)">Loading analytics…</p>`;

      try {
        // Fetch both deep analytics + index diagnostics for every folder in parallel
        const perFolder = await Promise.all(
          selectedFolders.map(async (folder) => {
            const [analytics, diag] = await Promise.all([
              invoke("get_folder_analytics", { folder }).catch(() => ({})),
              invoke("engine_diagnostics",  { folder }).catch(() => ({})),
            ]);
            return { folder, analytics, diag };
          })
        );

        // ---- Aggregate totals ----
        let grandTotal = 0, grandSizeBytes = 0, grandIndexMb = 0, grandEmbMb = 0;
        const extMap = {};   // ext -> total count across all folders
        const yearMap = {};  // year -> total count across all folders
        let globalLargest = null, globalSmallest = null;

        for (const { analytics: a } of perFolder) {
          grandTotal     += Number(a.total_images   || 0);
          grandSizeBytes += Number(a.total_size_bytes || 0);
        }
        for (const { diag: d } of perFolder) {
          grandIndexMb += Number(d.index_size_mb    || 0);
          grandEmbMb   += Number(d.embeddings_size_mb || 0);
        }
        for (const { analytics: a } of perFolder) {
          for (const { ext, count } of (a.by_extension || [])) {
            extMap[ext] = (extMap[ext] || 0) + count;
          }
          for (const { year, count } of (a.by_year || [])) {
            yearMap[year] = (yearMap[year] || 0) + count;
          }
          if (a.largest_file && (!globalLargest || a.largest_size_bytes > globalLargest.size)) {
            globalLargest = { file: a.largest_file.split(/[\\/]/).pop(), size: a.largest_size_bytes };
          }
          if (a.smallest_file && a.smallest_size_bytes > 0 &&
              (!globalSmallest || a.smallest_size_bytes < globalSmallest.size)) {
            globalSmallest = { file: a.smallest_file.split(/[\\/]/).pop(), size: a.smallest_size_bytes };
          }
        }

        const extArr = Object.entries(extMap).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const yearArr = Object.entries(yearMap).sort((a, b) => a[0].localeCompare(b[0]));
        const maxExt  = extArr.length  ? Math.max(...extArr.map(e => e[1]))  : 1;
        const maxYear = yearArr.length ? Math.max(...yearArr.map(y => y[1])) : 1;

        const extBars = extArr.map(([ext, count]) => `
          <div class="analytics-bar-row">
            <span class="analytics-bar-label">.${escapeHtml(ext)}</span>
            <div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:${Math.round(count/maxExt*100)}%"></div></div>
            <span class="analytics-bar-count">${count}</span>
          </div>`).join("");

        const yearBars = yearArr.map(([year, count]) => `
          <div class="analytics-bar-row">
            <span class="analytics-bar-label">${escapeHtml(String(year))}</span>
            <div class="analytics-bar-track"><div class="analytics-bar-fill year-bar" style="width:${Math.round(count/maxYear*100)}%"></div></div>
            <span class="analytics-bar-count">${count}</span>
          </div>`).join("");

        // ---- Per-folder breakdown table ----
        const folderRows = perFolder.map(({ folder, analytics: a, diag: d }) => {
          const name      = folder.split(/[\\/]/).pop() || folder;
          const imgs      = Number(a.total_images    || 0);
          const sizeBytes = Number(a.total_size_bytes || 0);
          const avgBytes  = Number(a.avg_size_bytes  || 0);
          const indexMb   = Number(d.index_size_mb   || 0);
          const embMb     = Number(d.embeddings_size_mb || 0);
          const thumbs    = Number(d.thumbnail_count  || 0);
          const lastIdx   = d.last_indexed
            ? new Date(d.last_indexed * 1000).toLocaleDateString()
            : 'Not indexed';
          const topExt    = (a.by_extension || [])[0]?.ext || '—';
          const largestF  = (a.largest_file  || '').split(/[\\/]/).pop() || '—';
          const largestSz = _fmtBytes(a.largest_size_bytes || 0);

          return `
            <div class="analytics-folder-card">
              <div class="analytics-folder-card-name" title="${escapeHtml(folder)}">📁 ${escapeHtml(name)}</div>
              <div class="analytics-folder-card-grid">
                <div class="afc-cell"><span class="afc-label">Photos</span><span class="afc-value">${imgs.toLocaleString()}</span></div>
                <div class="afc-cell"><span class="afc-label">Total Size</span><span class="afc-value">${_fmtBytes(sizeBytes)}</span></div>
                <div class="afc-cell"><span class="afc-label">Avg Size</span><span class="afc-value">${_fmtBytes(avgBytes)}</span></div>
                <div class="afc-cell"><span class="afc-label">Most Common</span><span class="afc-value">.${escapeHtml(topExt)}</span></div>
                <div class="afc-cell"><span class="afc-label">Thumbnails</span><span class="afc-value">${thumbs}</span></div>
                <div class="afc-cell"><span class="afc-label">Index Size</span><span class="afc-value">${indexMb.toFixed(2)} MB</span></div>
                <div class="afc-cell"><span class="afc-label">Embeddings</span><span class="afc-value">${embMb.toFixed(2)} MB</span></div>
                <div class="afc-cell"><span class="afc-label">Last Indexed</span><span class="afc-value">${escapeHtml(lastIdx)}</span></div>
                <div class="afc-cell afc-wide"><span class="afc-label">Largest File</span><span class="afc-value" title="${escapeHtml(a.largest_file||'')}">${escapeHtml(largestF)} (${largestSz})</span></div>
              </div>
            </div>`;
        }).join("");

        // ---- Render ----
        analyticsPanelContent.innerHTML = `
          <!-- Hero stats -->
          <div class="analytics-stats-grid">
            <div class="analytics-stat-card">
              <div class="analytics-stat-value">${grandTotal.toLocaleString()}</div>
              <div class="analytics-stat-label">Total Photos</div>
            </div>
            <div class="analytics-stat-card">
              <div class="analytics-stat-value">${selectedFolders.length}</div>
              <div class="analytics-stat-label">Folders</div>
            </div>
            <div class="analytics-stat-card">
              <div class="analytics-stat-value">${_fmtBytes(grandSizeBytes)}</div>
              <div class="analytics-stat-label">Total Size</div>
            </div>
            <div class="analytics-stat-card">
              <div class="analytics-stat-value">${grandTotal > 0 ? _fmtBytes(Math.round(grandSizeBytes / grandTotal)) : '—'}</div>
              <div class="analytics-stat-label">Avg Photo Size</div>
            </div>
            <div class="analytics-stat-card">
              <div class="analytics-stat-value">${(grandIndexMb + grandEmbMb).toFixed(1)} MB</div>
              <div class="analytics-stat-label">Index Overhead</div>
            </div>
            <div class="analytics-stat-card">
              <div class="analytics-stat-value">${extArr.length}</div>
              <div class="analytics-stat-label">File Types</div>
            </div>
          </div>

          ${globalLargest ? `
          <p class="analytics-section-title">Notable Files</p>
          <div class="analytics-notable">
            <div class="analytics-notable-label">Largest</div>
            <div class="analytics-notable-file">${escapeHtml(globalLargest.file)}</div>
            <div class="analytics-notable-size">${_fmtBytes(globalLargest.size)}</div>
          </div>
          ${globalSmallest ? `<div class="analytics-notable">
            <div class="analytics-notable-label">Smallest</div>
            <div class="analytics-notable-file">${escapeHtml(globalSmallest.file)}</div>
            <div class="analytics-notable-size">${_fmtBytes(globalSmallest.size)}</div>
          </div>` : ''}` : ''}

          ${extBars ? `<p class="analytics-section-title">File Types</p><div class="analytics-chart">${extBars}</div>` : ''}
          ${yearBars ? `<p class="analytics-section-title">Photos by Year</p><div class="analytics-chart">${yearBars}</div>` : ''}

          <p class="analytics-section-title">Per-Folder Details</p>
          <div class="analytics-folder-cards">${folderRows}</div>

          ${recentSearches.length > 0 ? `
          <p class="analytics-section-title">Recent Searches</p>
          <div class="analytics-chart">${recentSearches.slice(0, 10).map(s =>
            `<div style="padding:3px 0;color:rgba(255,255,255,0.55);font-size:12px">• ${escapeHtml(s)}</div>`
          ).join('')}</div>` : ''}
        `;
      } catch (err) {
        console.error("Failed to load analytics:", err);
        analyticsPanelContent.innerHTML = `<p style="color:#f87171">Failed to load analytics: ${escapeHtml(String(err))}</p>`;
      }
    }

    function closeAnalytics() {
      analyticsPanel.style.display = "none";
    }

    /* ------------------ FILENAME SEARCH FEATURE ------------------ */
    function showFilenameSearchModal() {
      filenameSearchModal.style.display = "flex";
      filenameSearchInput.value = "";
      filenameSearchInput.focus();
    }

    function closeFilenameSearchModal() {
      filenameSearchModal.style.display = "none";
    }

    async function searchByFilename() {
      const filename = filenameSearchInput.value.trim().toLowerCase();
      
      if (!filename) {
        alert("Please enter a filename to search");
        return;
      }

      if (selectedFolders.length === 0) {
        alert("Please select a folder first");
        return;
      }

      closeFilenameSearchModal();
      statusEl.textContent = "Searching for files...";
      resultsGrid.innerHTML = "";

      try {
        const perFolderResults = await Promise.all(
          selectedFolders.map(async (folder) => {
            try {
              // Use list command to get all images
              const data = await invoke("engine_list", {
                folder,
                topK: 500,
                filters: null,
                sortBy: "filename"
              });

              const results = Array.isArray(data?.results) ? data.results : [];
              
              // Filter by filename match
              return results
                .filter(item => {
                  const itemName = item.path.split("\\").pop().toLowerCase() || item.path.split("/").pop().toLowerCase();
                  return itemName.includes(filename);
                })
                .map((item) => ({ ...item, _folder: folder }));
            } catch (err) {
              console.warn(`Search failed for folder: ${folder}`, err);
              return [];
            }
          })
        );

        const combined = perFolderResults.flat();
        const deduped = [];
        const seenPaths = new Set();
        
        for (const item of combined) {
          if (seenPaths.has(item.path)) continue;
          seenPaths.add(item.path);
          deduped.push(item);
        }

        if (deduped.length === 0) {
          statusEl.textContent = `No files matching '${filename}' found.`;
          return;
        }

        await displayResults(deduped.slice(0, 50));
        statusEl.textContent = `Found ${deduped.length} file(s) matching '${filename}'`;
        addToSearchHistory(`filename: ${filename}`);
        updatePinButton();
      } catch (err) {
        console.error("Filename search failed:", err);
        statusEl.textContent = `Filename search failed: ${String(err)}`;
      }
    }

  // Filter elements
  const sortSelect = document.getElementById("sort-select");
  const fileTypeSelect = document.getElementById("file-type-select");
  const minWidthInput = document.getElementById("min-width");
  const minHeightInput = document.getElementById("min-height");

  // Load search history and pinned searches from localStorage
  function loadSearchHistory() {
    const stored = localStorage.getItem("searchHistory");
    recentSearches = stored ? JSON.parse(stored) : [];
    updateSearchHistoryUI();
  }

  function loadPinnedSearches() {
    const stored = localStorage.getItem("pinnedSearches");
    pinnedSearches = stored ? JSON.parse(stored) : [];
    updatePinnedSearchesUI();
  }

  function saveSearchHistory() {
    localStorage.setItem("searchHistory", JSON.stringify(recentSearches.slice(0, 20)));
  }

  function savePinnedSearches() {
    localStorage.setItem("pinnedSearches", JSON.stringify(pinnedSearches));
  }

  function saveSelectedFolders() {
    localStorage.setItem("selectedFolders", JSON.stringify(selectedFolders));
  }

  function loadSavedFolders() {
    try {
      const stored = localStorage.getItem("selectedFolders");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  }

  function addToSearchHistory(query) {
    if (!query) return;
    // Remove if already exists
    recentSearches = recentSearches.filter(q => q !== query);
    // Add to beginning
    recentSearches.unshift(query);
    // Keep only last 20
    recentSearches = recentSearches.slice(0, 20);
    saveSearchHistory();
    updateSearchHistoryUI();
  }

  function updateSearchHistoryUI() {
    searchHistoryList.innerHTML = "";
    recentSearches.forEach(query => {
      const option = document.createElement("option");
      option.value = query;
      searchHistoryList.appendChild(option);
    });
  }

  function updatePinnedSearchesUI() {
    pinnedSearchesDiv.innerHTML = "";
    
    if (pinnedSearches.length === 0) {
      pinnedSearchesContainer.style.display = "none";
      pinSearchBtn.classList.remove("pinned");
      return;
    }
    
    pinnedSearchesContainer.style.display = "block";
    
    pinnedSearches.forEach(query => {
      const tag = document.createElement("div");
      tag.className = "pinned-search-tag";
      tag.innerHTML = `${query} <span class="remove-pin">×</span>`;
      tag.onclick = (e) => {
        if (e.target.classList.contains("remove-pin")) {
          pinnedSearches = pinnedSearches.filter(q => q !== query);
          savePinnedSearches();
          updatePinnedSearchesUI();
          updatePinButton();
        } else {
          queryInput.value = query;
          sortSearchMode = "query";
          search({ useQuery: true });
        }
      };
      pinnedSearchesDiv.appendChild(tag);
    });
  }

  function updatePinButton() {
    const currentQuery = queryInput.value.trim();
    if (pinnedSearches.includes(currentQuery)) {
      pinSearchBtn.classList.add("pinned");
    } else {
      pinSearchBtn.classList.remove("pinned");
    }
  }

  function showToast(message, timeoutMs = 2200) {
    toastEl.textContent = message;
    toastEl.style.display = "block";
    setTimeout(() => {
      toastEl.style.display = "none";
    }, timeoutMs);
  }

  function basename(filePath) {
    if (!filePath) return "";
    const normalized = String(filePath).replace(/\\/g, "/");
    const parts = normalized.split("/");
    return parts[parts.length - 1] || "";
  }

  /** Escape HTML special characters to prevent XSS in innerHTML strings. */
  function escapeHtml(str) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(str || '').replace(/[&<>"']/g, m => map[m]);
  }

  /**
   * Convert a local filesystem path to a Tauri asset:// URL for display.
   * This avoids all IPC overhead — the browser loads images directly.
   */
  function toAssetUrl(filePath) {
    if (!filePath) return '';
    const normalized = String(filePath).replace(/\\/g, '/');
    return convertFileSrc(normalized);
  }

  function setSortModalVisible(visible) {
    sortConfirmModal.style.display = visible ? "flex" : "none";
  }

  function queueStateLabel(status) {
    if (status === "processing") return "processing";
    if (status === "indexed") return "indexed";
    if (status === "skipped") return "skipped";
    if (status === "error") return "error";
    if (status === "cancelled") return "cancelled";
    return "queued";
  }

  function renderIndexQueue() {
    if (indexQueueState.size === 0) {
      indexQueuePanel.style.display = "none";
      return;
    }

    indexQueuePanel.style.display = "block";
    const rows = [];
    let completed = 0;

    indexQueueState.forEach((value, key) => {
      const label = queueStateLabel(value.status);
      if (["indexed", "skipped", "error", "cancelled"].includes(value.status)) {
        completed += 1;
      }
      rows.push(`<div class="queue-row"><span class="path">${escapeHtml(key)}</span><span class="state ${label}">${escapeHtml(label)}</span></div>`);
    });

    indexQueueSummary.textContent = `${completed}/${indexQueueState.size} folders processed`;
    indexQueueList.innerHTML = rows.join("");

    const total = indexQueueState.size;
    const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;
    setIndexProgress(Math.max(progressPercent, 8), `Indexing folders... ${completed}/${total}`);
  }

  function setPostIndexUIVisible(visible) {
    appControls.style.display = visible ? "flex" : "none";
    toggleFiltersBtn.style.display = visible ? "inline-flex" : "none";

    if (!visible) {
      filtersVisible = false;
      filtersContainer.style.display = "none";
      toggleFiltersBtn.textContent = "Show Filters";
      return;
    }

    filtersVisible = true;
    filtersContainer.style.display = "grid";
    toggleFiltersBtn.textContent = "Hide Filters";
  }

  function setIndexProgress(percent, label) {
    const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
    indexProgress.style.display = "block";
    indexProgressFill.style.width = `${normalized}%`;
    indexProgressText.textContent = label;
  }

  function hideIndexProgress() {
    indexProgress.style.display = "none";
    indexProgressFill.style.width = "0%";
    indexProgressText.textContent = "Preparing indexing...";
  }

  async function runIndexQueue(folders) {
    indexQueueRunning = true;
    indexQueueCancelled = false;
    indexQueueState.clear();
    for (const folder of folders) {
      indexQueueState.set(folder, { status: "queued" });
    }
    renderIndexQueue();

    // F1: Subscribe to per-file progress events from the Rust streaming indexer
    let _unlistenProgress = null;
    try {
      _unlistenProgress = await listen("index-progress", (event) => {
        const { current, total, file } = event.payload || {};
        if (total > 0) {
          const pct = Math.round((current / total) * 80) + 8; // 8%–88% range during encode
          const label = `Encoding image ${current} of ${total}${file ? `: ${file}` : ""}`;
          setIndexProgress(pct, label);
        }
      });
    } catch (_) { /* listen not available — graceful degradation */ }

    // Seed readyFolders with folders that are already indexed but NOT in the
    // current indexing queue — this preserves previously-selected folders when
    // the user indexes an additional folder without re-indexing everything.
    const foldersInQueue = new Set(folders);
    const readyFolders = selectedFolders.filter(f => !foldersInQueue.has(f));

    let skipped = 0;
    let indexedNow = 0;
    let totalAdded = 0;
    let totalModified = 0;
    let totalRemoved = 0;

    for (const folder of folders) {
      if (indexQueueCancelled) {
        indexQueueState.forEach((entry, key) => {
          if (entry.status === "queued") {
            indexQueueState.set(key, { status: "cancelled" });
          }
        });
        renderIndexQueue();
        break;
      }

      indexQueueState.set(folder, { status: "processing" });
      renderIndexQueue();

      try {
        const probe = await invoke("engine_is_indexed", { folder });
        if (probe?.indexed) {
          skipped += 1;
          readyFolders.push(folder);
          indexQueueState.set(folder, { status: "skipped" });
          renderIndexQueue();
          continue;
        }

        const data = await invoke("engine_index", { folder });
        if (data.status !== "ok") {
          indexQueueState.set(folder, { status: "error" });
          renderIndexQueue();
          continue;
        }

        indexedNow += 1;
        readyFolders.push(folder);
        totalAdded += Number(data.added || 0);
        totalModified += Number(data.modified || 0);
        totalRemoved += Number(data.removed || 0);
        indexQueueState.set(folder, { status: "indexed" });
        renderIndexQueue();
      } catch (err) {
        console.error("Queue indexing failed for folder:", folder, err);
        indexQueueState.set(folder, { status: "error" });
        renderIndexQueue();
      }
    }

    selectedFolders = Array.from(new Set(readyFolders));
    saveSelectedFolders();
    searchCache.clear();

    // F1: Stop listening for progress events
    if (_unlistenProgress) try { _unlistenProgress(); } catch (_) {}

    if (indexQueueCancelled) {
      statusEl.textContent = `Index queue cancelled. Ready ${selectedFolders.length} folder(s).`;
      showToast("Index queue cancelled");
      setIndexProgress(100, "Indexing cancelled");
    } else if (selectedFolders.length === 0) {
      statusEl.textContent = "No folder is ready for search.";
      setIndexProgress(100, "No folders ready");
    } else {
      statusEl.textContent = `Ready ${selectedFolders.length} folder(s): skipped ${skipped}, indexed ${indexedNow}, changes +${totalAdded} ~${totalModified} -${totalRemoved}`;
      setIndexProgress(100, "Indexing complete");
    }

    setPostIndexUIVisible(selectedFolders.length > 0);

    indexQueueRunning = false;
    setIndexingState(false);

    // S6-F3: Refresh the persistent status bar after every index run
    refreshStatusBar();

    // S8-F3: Ensure auto-scan is running after indexing
    startAutoScan();
  }

  // Create offline indicator element
  const offlineIndicator = document.createElement("div");
  offlineIndicator.id = "offline-indicator";
  offlineIndicator.className = "offline-indicator";
  offlineIndicator.textContent = isOnline ? "" : "Offline: Active";
  offlineIndicator.style.display = isOnline ? "none" : "block";
  document.body.insertBefore(offlineIndicator, document.body.firstChild);

  // Update offline status when connection changes
  window.addEventListener("online", () => {
    isOnline = true;
    offlineIndicator.textContent = "";
    offlineIndicator.style.display = "none";
  });

  window.addEventListener("offline", () => {
    isOnline = false;
    offlineIndicator.textContent = "Offline: Active";
    offlineIndicator.style.display = "block";
  });

  // Run startup self-check
  try {
    const result = await invoke("startup_self_check");
    console.log("Startup self-check result:", result);
    if (result.status === "ok") {
      console.log("Self-check passed:", result.message);
    }
    // Hide skeleton screen after startup complete
    await hideSkeleton();
  } catch (err) {
    console.error("Startup self-check failed:", err);
    statusEl.textContent = `Self-check failed: ${String(err)}`;
    await hideSkeleton();
  }

  // Load search history and pinned searches
  loadSearchHistory();
  loadPinnedSearches();
  setPostIndexUIVisible(false);
  hideIndexProgress();

  // Poll for daemon readiness — show a subtle status until the AI engine is warmed up.
  // The daemon loads CLIP once on startup (~10–30s); after that all searches are fast.
  (async function pollDaemonWarmup() {
    try {
      const initial = await invoke("daemon_status");
      if (initial?.ready) return; // Already warm (very fast machine or hot cache)
      if (initial?.failed) return; // Daemon failed; subprocess fallback will handle it silently

      statusEl.textContent = "⚡ Warming up AI engine — first search may be slower…";

      const interval = setInterval(async () => {
        try {
          const s = await invoke("daemon_status");
          if (s?.ready) {
            clearInterval(interval);
            if (statusEl.textContent.startsWith("⚡")) {
              statusEl.textContent = "";
              showToast("✓ AI engine ready — full speed search enabled");
            }
          } else if (s?.failed) {
            clearInterval(interval);
            if (statusEl.textContent.startsWith("⚡")) {
              statusEl.textContent = "";
            }
          }
        } catch (_) { clearInterval(interval); }
      }, 1500);
    } catch (_) { /* daemon_status not yet registered — ignore */ }
  })();

  // Restore previously selected folders from last session
  {
    const savedFolders = loadSavedFolders();
    if (savedFolders.length > 0) {
      statusEl.textContent = "Restoring previous session...";
      const restoredFolders = [];
      for (const folder of savedFolders) {
        try {
          const probe = await invoke("engine_is_indexed", { folder });
          if (probe?.indexed) {
            restoredFolders.push(folder);
          }
        } catch (err) {
          console.warn("Could not restore folder:", folder, err);
        }
      }
      if (restoredFolders.length > 0) {
        selectedFolders = restoredFolders;
        searchCache.clear(); // always start a fresh session with a clean cache
        setPostIndexUIVisible(true);
        statusEl.textContent = `✓ Restored ${restoredFolders.length} folder(s) from last session. Ready to search.`;

        // F3: Check each restored folder for new/removed images
        // Runs in background — doesn't block startup
        setTimeout(async () => {
          let totalNew = 0;
          let totalRemoved = 0;
          const affectedFolders = [];
          for (const folder of restoredFolders) {
            try {
              const changes = await invoke("engine_check_changes", { folder });
              if ((changes?.new_count || 0) + (changes?.removed_count || 0) > 0) {
                totalNew += changes.new_count || 0;
                totalRemoved += changes.removed_count || 0;
                affectedFolders.push(folder);
              }
            } catch (_) { /* non-fatal */ }
          }
          if (totalNew > 0 || totalRemoved > 0) {
            _showChangeBanner(totalNew, totalRemoved, affectedFolders);
          }
        }, 2500); // Wait 2.5s so daemon has time to warm up
      } else {
        statusEl.textContent = "";
      }
    }

    // S6-F3: Show status bar on startup if any folders are already indexed
    refreshStatusBar();
  }

  /* ------------------ OPEN IMAGE ------------------ */
  async function openImage(path) {
    try {
      await openPath(path);
    } catch (err) {
      console.error("Open failed:", err);
    }
  }

  /* =================== S6-F3 — STATUS BAR =================== */

  async function refreshStatusBar() {
    if (selectedFolders.length === 0) {
      statusBar.style.display = "none";
      return;
    }
    statusBar.style.display = "flex";

    let totalPhotos = 0;
    let latestMtime = 0;

    for (const folder of selectedFolders) {
      try {
        const d = await invoke("engine_diagnostics", { folder });
        totalPhotos += (d?.total_images || 0);
        const t = d?.last_indexed || 0;
        if (t > latestMtime) latestMtime = t;
      } catch (_) {}
    }

    sbPhotos.textContent = `📸 ${totalPhotos.toLocaleString()} photo${totalPhotos !== 1 ? "s" : ""}`;
    sbFolders.textContent = `${selectedFolders.length} folder${selectedFolders.length !== 1 ? "s" : ""}`;

    if (latestMtime > 0) {
      const diff = Math.floor((Date.now() / 1000) - latestMtime);
      let ago;
      if (diff < 60) ago = "just now";
      else if (diff < 3600) ago = `${Math.floor(diff / 60)}m ago`;
      else if (diff < 86400) ago = `${Math.floor(diff / 3600)}h ago`;
      else ago = `${Math.floor(diff / 86400)}d ago`;
      sbLastIndexed.textContent = `Last indexed: ${ago}`;
    } else {
      sbLastIndexed.textContent = "Not indexed";
    }
  }

  /* =================== S6-F2 — TIMELINE VIEW =================== */

  const IMAGE_EXTENSIONS = new Set([".jpg",".jpeg",".png",".webp",".gif",".bmp",".tiff",".tif",".heic",".heif"]);

  function _bucketLabel(unixSecs) {
    if (!unixSecs) return "Unknown Date";
    const d = new Date(unixSecs * 1000);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const itemDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.floor((today - itemDay) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return "This Week";
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleString("default", { month: "long", year: "numeric" });
    }
    return String(d.getFullYear());
  }

  async function _renderTimeline(results) {
    // Fetch modification times in one batch Rust call
    const paths = results.map(r => r.path).filter(Boolean);
    let mtimeMap = {};
    try {
      mtimeMap = await invoke("get_files_mtime", { paths });
    } catch (_) {}

    // Group results by bucket label
    const groups = new Map();
    for (const item of results) {
      const mtime = mtimeMap[item.path] || 0;
      const label = _bucketLabel(mtime);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(item);
    }

    _gridObserver.disconnect();
    resultsGrid.innerHTML = "";
    selectedImages.clear();
    updateBulkActionsBar();

    for (const [label, items] of groups) {
      const section = document.createElement("div");
      section.className = "timeline-section";

      const header = document.createElement("div");
      header.className = "timeline-header";
      header.innerHTML =
        `<span class="timeline-label">${escapeHtml(label)}</span>` +
        `<span class="timeline-count">${items.length}</span>` +
        `<span class="timeline-chevron">▾</span>`;
      header.addEventListener("click", () => section.classList.toggle("collapsed"));

      const grid = document.createElement("div");
      grid.className = "timeline-grid";

      for (const item of items) {
        const card = document.createElement("div");
        card.className = "card";
        card.dataset.imagePath = item.path;
        const thumbnailPath = String(item.thumbnail || "");
        const img = _createLazyImg(thumbnailPath, item.path, () => {
          if (!img.dataset.fallbackTried && item.path) {
            img.dataset.fallbackTried = "1";
            img.dataset.lazySrc = toAssetUrl(item.path);
            img.src = toAssetUrl(item.path);
          } else { card.style.opacity = "0.5"; }
        });
        card.appendChild(img);
        // Click → lightbox
        card.addEventListener("click", (e) => {
          if (e.target === img || e.target === card) {
            e.stopPropagation();
            const idx = _allSearchResults.findIndex(r => r.path === item.path);
            openLightbox(idx >= 0 ? idx : 0);
          }
        });
        grid.appendChild(card);
      }

      section.appendChild(header);
      section.appendChild(grid);
      resultsGrid.appendChild(section);
    }
  }

  /* =================== S6-F1 — DRAG & DROP =================== */

  (async function setupFileDrop() {
    try {
      const appWindow = getCurrentWebviewWindow();
      await appWindow.onFileDropEvent(async (event) => {
        const type = event.payload?.type;

        if (type === "over" || type === "hover") {
          dropOverlay.style.display = "flex";
          return;
        }

        dropOverlay.style.display = "none";

        if (type !== "drop") return;

        const paths = event.payload?.paths || [];
        if (paths.length === 0) return;

        // Separate folders from image files
        const folders = [];
        const imageFiles = [];
        for (const p of paths) {
          const ext = p.split(".").pop()?.toLowerCase() || "";
          if (IMAGE_EXTENSIONS.has("." + ext)) {
            imageFiles.push(p);
          } else {
            // Assume it's a folder if no image extension
            folders.push(p);
          }
        }

        if (folders.length > 0) {
          // Index all dropped folders
          showToast(`📂 Indexing ${folders.length} dropped folder${folders.length > 1 ? "s" : ""}…`);
          selectedFolders = Array.from(new Set([...selectedFolders, ...folders]));
          saveSelectedFolders();
          searchCache.clear(); // folder set changed — stale cached results must not be served
          setIndexingState(true);
          runIndexQueue(folders);
        } else if (imageFiles.length > 0) {
          // Search visually similar to the first dropped image
          showToast(`🔍 Searching similar to ${imageFiles[0].split(/[\\/]/).pop()}…`);
          await searchSimilarImages(imageFiles[0]);
        }
      });
    } catch (err) {
      console.warn("File drop setup failed:", err);
    }
  })();

  /* ------------------ BULK ACTIONS ------------------ */
  async function openAllSelected() {
    for (const imagePath of selectedImages) {
      await openImage(imagePath);
    }
  }

  async function copySelectedPaths() {
    const paths = Array.from(selectedImages).join("\n");
    try {
      await navigator.clipboard.writeText(paths);
      statusEl.textContent = `Copied ${selectedImages.size} path(s) to clipboard`;
    } catch (err) {
      console.error("Failed to copy paths:", err);
      statusEl.textContent = "Failed to copy paths";
    }
  }

  function deselectAll() {
    selectedImages.clear();
    document.querySelectorAll(".card.selected").forEach(card => {
      card.classList.remove("selected");
    });
    updateBulkActionsBar();
  }

  /* ------------------ SIMILAR IMAGE SEARCH ------------------ */
  async function searchSimilarImages(imagePath) {
    const targetFolder = selectedFolders.find(folder => imagePath.startsWith(folder + "\\") || imagePath.startsWith(folder + "/"));

    if (!targetFolder) {
      alert("No folder indexed");
      return;
    }

    statusEl.textContent = "Searching for similar images...";
    resultsGrid.innerHTML = "";

    try {
      const data = await invoke("engine_search_similar", {
        folder: targetFolder,
        imagePath: imagePath,
        topK: 10
      });

      console.log("Similar search results:", data);

      if (!data.results || data.results.length === 0) {
        statusEl.textContent = "No similar images found.";
        return;
      }

      await displayResults(data.results);
      statusEl.textContent = `Found ${data.results.length} similar images`;
    } catch (err) {
      console.error("Similar search failed:", err);
      statusEl.textContent = `Similar search failed: ${String(err)}`;
    }
  }

  /* ------------------ GET FILTERS ------------------ */
  function getFilters() {
    const filters = {};
    
    // Get selected file types
    const selectedOptions = Array.from(fileTypeSelect.selectedOptions);
    if (selectedOptions.length > 0 && selectedOptions.length < 4) {
      filters.file_types = selectedOptions.map(opt => opt.value);
    }
    
    // Get min width/height
    const minWidth = parseInt(minWidthInput.value) || 0;
    const minHeight = parseInt(minHeightInput.value) || 0;
    
    if (minWidth > 0) {
      filters.min_width = minWidth;
    }
    if (minHeight > 0) {
      filters.min_height = minHeight;
    }
    
    return Object.keys(filters).length > 0 ? filters : null;
  }

  /* ------------------ SEARCH ------------------ */
  async function search(options = {}) {
    const useQuery = options.useQuery ?? (sortSearchMode === "query");
    const query = queryInput.value.trim();
    const sortBy = options.sortOverride || sortSelect.value;

    if (selectedFolders.length === 0) {
      alert("Please select a folder first.");
      return;
    }

    if (useQuery && !query) {
      statusEl.textContent = "Enter a search query.";
      return;
    }

    // Add to search history
    if (useQuery) {
      addToSearchHistory(query);
      updatePinButton();
    }

    const filters = getFilters();
    const normalizedFolders = [...selectedFolders].sort();
    const mode = useQuery ? "query" : "all";
    // Include threshold in cache key so changing it invalidates cache
    const cacheKey = `${normalizedFolders.join("||")}::${mode}::${query}::${sortBy}::${JSON.stringify(filters || {})}::t${_relevanceThreshold}`;

    // Try cache for non-query searches (listing) only —
    // query results are streamed progressively, cache only after full load
    if (!useQuery) {
      const cachedResult = searchCache.get(cacheKey);
      if (cachedResult) {
        _allSearchResults = cachedResult;
        _displayedCount = 0;
        await displayResults(_allSearchResults.slice(0, PAGE_SIZE));
        _displayedCount = Math.min(PAGE_SIZE, _allSearchResults.length);
        _renderLoadMoreButton();
        statusEl.textContent = `Found ${cachedResult.length} images (cached)`;
        return;
      }
    }

    // Cancel any in-flight stream from a previous search
    const thisSearchId = ++_streamSearchId;

    statusEl.textContent = useQuery ? "Searching…" : "Loading images…";
    resultsGrid.innerHTML = "";
    const staleBtn = document.getElementById("load-more-btn");
    if (staleBtn) staleBtn.remove();
    _allSearchResults = [];
    _displayedCount = 0;

    try {
      console.log(`[SEARCH] Folders: ${selectedFolders.length}`, selectedFolders);
      console.log(`[SEARCH] query="${query}", threshold=${_relevanceThreshold}, topK=${TOP_K_PER_FOLDER}`);

      const perFolderResults = await Promise.all(
        selectedFolders.map(async (folder) => {
          try {
            const data = useQuery
              ? await invoke("engine_search", {
                  folder,
                  query,
                  filters: filters ? JSON.stringify(filters) : null,
                  sortBy,
                  topK: TOP_K_PER_FOLDER,
                  minScore: _relevanceThreshold  // ← pass threshold to Python
                })
              : await invoke("engine_list", {
                  folder,
                  filters: filters ? JSON.stringify(filters) : null,
                  sortBy,
                  topK: TOP_K_PER_FOLDER
                });
            const results = Array.isArray(data?.results) ? data.results : [];
            return results.map((item) => ({ ...item, _folder: folder }));
          } catch (err) {
            console.warn(`Search failed for folder: ${folder}`, err);
            return [];
          }
        })
      );

      // Bail if a newer search was started while we were awaiting
      if (_streamSearchId !== thisSearchId) return;

      // ── DIAGNOSTIC: log per-folder result counts
      perFolderResults.forEach((res, i) => {
        console.log(`[SEARCH] Folder[${i}] "${selectedFolders[i]}" → ${res.length} results`);
      });

      const combined = perFolderResults.flat();
      console.log(`[SEARCH] Combined: ${combined.length} total`);

      const seenPaths = new Set();
      const deduped = [];
      for (const item of combined) {
        if (seenPaths.has(item.path)) continue;
        seenPaths.add(item.path);
        deduped.push(item);
      }
      console.log(`[SEARCH] Deduped: ${deduped.length}`);

      // ── Calibrate scores to absolute CLIP range for display ───────────────────
      // Python already filtered by absolute CLIP minimum per-folder.
      // Here we only calibrate scores to a meaningful 0–100% display range.
      //
      // CLIP cosine similarity calibration:
      //   0.17 = noise/random baseline → 0%
      //   0.35 = excellent match → 100%
      // This means irrelevant images that barely pass the threshold show ~5%,
      // while strong matches show 80–100% — giving the user accurate signal.
      const CLIP_DISPLAY_LO = 0.17;
      const CLIP_DISPLAY_HI = 0.35;
      let finalDeduped = deduped;
      if (useQuery && deduped.length > 0) {
        finalDeduped = deduped.map(r => {
          const raw = r.score || 0;
          const displayScore = Math.max(0, Math.min(1,
            (raw - CLIP_DISPLAY_LO) / (CLIP_DISPLAY_HI - CLIP_DISPLAY_LO)
          ));
          return { ...r, _rawScore: raw, score: displayScore };
        });
        console.log(`[SEARCH] Score calibrated: ${finalDeduped.length} results across ${selectedFolders.length} folder(s)`);
      }

      // Sort: for query searches always sort by relevance (score desc) first
      const sorted = sortResultsForDisplay(finalDeduped, useQuery ? "relevance" : sortBy);

      if (sorted.length === 0) {
        statusEl.textContent = useQuery
          ? `No images matched "${query}" above ${Math.round(_relevanceThreshold * 100)}% relevance. Try lowering the threshold in Filters.`
          : "No images found.";
        _allSearchResults = [];
        _displayedCount = 0;
        _renderLoadMoreButton();
        return;
      }

      _allSearchResults = sorted;
      _displayedCount = 0;

      if (!useQuery) {
        // Non-query browse: batch display, cache result
        searchCache.set(cacheKey, sorted);
        await displayResults(sorted.slice(0, PAGE_SIZE));
        _displayedCount = Math.min(PAGE_SIZE, sorted.length);
        _renderLoadMoreButton();
        statusEl.textContent = `${sorted.length} images from ${selectedFolders.length} folder(s)`;
        return;
      }

      // ── PROGRESSIVE STREAMING (query searches only) ──────────────────────
      // Show the first 6 results immediately for instant feedback
      const FIRST_BATCH  = 6;
      const STREAM_BATCH = 4;   // cards per wave after the first
      const STREAM_DELAY = 80;  // ms between waves — keeps UI responsive

      const firstBatch = sorted.slice(0, FIRST_BATCH);
      await _appendResultsStreaming(firstBatch, true);
      _displayedCount = firstBatch.length;
      statusEl.textContent = `Showing ${_displayedCount} of ${sorted.length} results…`;

      // Stream the remaining cards in waves
      let shown = FIRST_BATCH;
      while (shown < sorted.length) {
        // Check cancellation — user started a new search
        if (_streamSearchId !== thisSearchId) return;
        await new Promise(r => setTimeout(r, STREAM_DELAY));
        if (_streamSearchId !== thisSearchId) return;

        const wave = sorted.slice(shown, shown + STREAM_BATCH);
        await _appendResultsStreaming(wave, false);
        shown += wave.length;
        _displayedCount = shown;

        const total = sorted.length;
        statusEl.textContent = shown < total
          ? `Streaming… ${shown} of ${total} results`
          : `Found ${total} result${total !== 1 ? "s" : ""} from ${selectedFolders.length} folder(s)`;
      }

      // Final status
      const total = sorted.length;
      statusEl.textContent = `Found ${total} result${total !== 1 ? "s" : ""} from ${selectedFolders.length} folder(s)`;

    } catch (err) {
      console.error(err);
      statusEl.textContent = `Search failed: ${String(err)}`;
    }
  }

  /** Renders (or removes) the "Load more" button below the results grid. */
  function _renderLoadMoreButton() {
    const existing = document.getElementById("load-more-btn");
    if (existing) existing.remove();

    const remaining = _allSearchResults.length - _displayedCount;
    if (remaining <= 0) return;

    const btn = document.createElement("button");
    btn.id = "load-more-btn";
    btn.className = "load-more-btn";
    btn.textContent = `Load ${Math.min(PAGE_SIZE, remaining)} more  (${remaining} remaining)`;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Loading…";
      const next = _allSearchResults.slice(_displayedCount, _displayedCount + PAGE_SIZE);
      // Append cards without clearing the grid
      await _appendResults(next);
      _displayedCount += next.length;
      _renderLoadMoreButton(); // re-render with updated count
      const sortBy = sortSelect.value;
      const shownLabel = _displayedCount < _allSearchResults.length
        ? `Showing ${_displayedCount} of ${_allSearchResults.length}`
        : `Found ${_allSearchResults.length}`;
      statusEl.textContent = `${shownLabel} results`;
    };
    resultsGrid.after(btn);
  }

  function sortResultsForDisplay(results, sortBy) {
    const next = [...results];

    if (sortBy === "relevance") {
      return next.sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    if (sortBy === "filename") {
      return next.sort((a, b) => {
        const nameA = (a.path || "").split(/[\\/]/).pop()?.toLowerCase() || "";
        const nameB = (b.path || "").split(/[\\/]/).pop()?.toLowerCase() || "";
        return nameA.localeCompare(nameB);
      });
    }

    const withTime = next.map((item) => {
      const ts = item.mtime || 0;
      return { ...item, _mtime: Number(ts) || 0 };
    });

    if (sortBy === "newest") {
      return withTime.sort((a, b) => b._mtime - a._mtime);
    }

    if (sortBy === "oldest") {
      return withTime.sort((a, b) => a._mtime - b._mtime);
    }

    return next;
  }

  // F3: IntersectionObserver for virtual grid rendering.
  // Only cards within 2 viewports of the viewport have their img.src set.
  // Off-screen cards hold the path in data-src and show a transparent 1px placeholder.
  // This keeps GPU memory usage constant regardless of total card count.
  const _gridObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const img = entry.target;
        if (entry.isIntersecting) {
          // Entering view — load the image
          const src = img.dataset.lazySrc;
          if (src && img.src !== src) {
            img.src = src;
          }
        } else {
          // Leaving view — check if far enough away to unload
          const rect = entry.boundingClientRect;
          const vh = window.innerHeight;
          const distancePx = Math.min(Math.abs(rect.top), Math.abs(rect.bottom));
          if (distancePx > vh * 2.5) {
            // More than 2.5 viewports away — free the GPU texture
            if (img.src && !img.src.endsWith("data:,")) {
              img.src = "data:,"; // tiny no-op src that releases the texture
            }
          }
        }
      }
    },
    { rootMargin: "200px" }
  );

  /** Helper: create a lazy-observed card image element. */
  function _createLazyImg(thumbnailPath, fullPath, onerrorCb) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "Search result image";
    img.dataset.lazySrc = toAssetUrl(thumbnailPath || fullPath);
    img.src = "data:,"; // placeholder until observer fires
    img.onerror = onerrorCb;
    _gridObserver.observe(img);
    return img;
  }

  async function displayResults(results) {
    // S6-F2: Route to timeline view if active
    if (_timelineMode) {
      resultsHeader.style.display = "flex";
      resultsCountLabel.textContent = `${results.length} result${results.length !== 1 ? "s" : ""}`;
      await _renderTimeline(results);
      return;
    }

    // Show results header
    resultsHeader.style.display = results.length > 0 ? "flex" : "none";
    if (results.length > 0) {
      resultsCountLabel.textContent = `${results.length} result${results.length !== 1 ? "s" : ""}`;
    }

    // Disconnect old observations before clearing the grid
    _gridObserver.disconnect();
    resultsGrid.innerHTML = "";
    selectedImages.clear();
    updateBulkActionsBar();

    for (const item of results) {
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.imagePath = item.path;

      const thumbnailPath = String(item.thumbnail || "");

      // F3: Use observer-based lazy loading instead of direct img.src
      const img = _createLazyImg(thumbnailPath, item.path, () => {
        if (!img.dataset.fallbackTried && item.path) {
          img.dataset.fallbackTried = "1";
          img.dataset.lazySrc = toAssetUrl(item.path);
          img.src = toAssetUrl(item.path);
        } else {
          card.style.opacity = "0.5";
          card.title = "Image failed to load";
        }
      });
      card.appendChild(img);

      // Create overlay with buttons
      const overlay = document.createElement("div");
      overlay.className = "card-overlay";

      const openBtn = document.createElement("button");
      openBtn.textContent = "Open";
      openBtn.onclick = (e) => {
        e.stopPropagation();
        openImage(item.path);
      };

      const similarBtn = document.createElement("button");
      similarBtn.className = "similar-btn";
      similarBtn.textContent = "Similar";
      similarBtn.onclick = (e) => {
        e.stopPropagation();
        searchSimilarImages(item.path);
      };

      const collectionBtn = document.createElement("button");
      collectionBtn.className = "collection-btn";
      collectionBtn.textContent = "Add to Collection";
      collectionBtn.onclick = (e) => {
        e.stopPropagation();
        addImageToCollection(item.path);
      };

      overlay.appendChild(openBtn);
      overlay.appendChild(similarBtn);
      overlay.appendChild(collectionBtn);
      card.appendChild(overlay);

      // Card image click opens lightbox (F1); overlay button clicks handled separately
      card.addEventListener("click", (e) => {
        if (e.target === img || e.target === card) {
          e.stopPropagation();
          // Find the index of this item in the full results list
          const idx = _allSearchResults.findIndex(r => r.path === item.path);
          openLightbox(idx >= 0 ? idx : 0);
        }
      });

      resultsGrid.appendChild(card);
    }
  }

  /**
   * Appends result cards to the grid WITHOUT clearing it.
   * Used by the "Load more" button (F2 pagination).
   */
  async function _appendResults(results) {
    for (const item of results) {
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.imagePath = item.path;

      const thumbnailPath = String(item.thumbnail || "");

      // F3: Same observer-based lazy loading for appended cards
      const img = _createLazyImg(thumbnailPath, item.path, () => {
        if (!img.dataset.fallbackTried && item.path) {
          img.dataset.fallbackTried = "1";
          img.dataset.lazySrc = toAssetUrl(item.path);
          img.src = toAssetUrl(item.path);
        } else {
          card.style.opacity = "0.5";
        }
      });
      card.appendChild(img);

      const overlay = document.createElement("div");
      overlay.className = "card-overlay";

      const openBtn = document.createElement("button");
      openBtn.textContent = "Open";
      openBtn.onclick = (e) => { e.stopPropagation(); openImage(item.path); };

      const similarBtn = document.createElement("button");
      similarBtn.className = "similar-btn";
      similarBtn.textContent = "Similar";
      similarBtn.onclick = (e) => { e.stopPropagation(); searchSimilarImages(item.path); };

      const collectionBtn = document.createElement("button");
      collectionBtn.className = "collection-btn";
      collectionBtn.textContent = "Add to Collection";
      collectionBtn.onclick = (e) => { e.stopPropagation(); addImageToCollection(item.path); };

      overlay.appendChild(openBtn);
      overlay.appendChild(similarBtn);
      overlay.appendChild(collectionBtn);
      card.appendChild(overlay);

      // Card image click opens lightbox (F1)
      card.addEventListener("click", (e) => {
        if (e.target === img || e.target === card) {
          e.stopPropagation();
          const idx = _allSearchResults.findIndex(r => r.path === item.path);
          openLightbox(idx >= 0 ? idx : 0);
        }
      });

      resultsGrid.appendChild(card);
    }
  }

  /**
   * Like _appendResults but:
   *  - Adds the .card--stream-in animation for a "flowing in" feel
   *  - Overlays a score badge (e.g. "97% match") on each card
   *  - isFirst=true → clears the grid before appending (first wave)
   *  - isFirst=false → appends to existing grid (subsequent waves)
   */
  async function _appendResultsStreaming(results, isFirst = false) {
    if (isFirst) {
      _gridObserver.disconnect();
      resultsGrid.innerHTML = "";
      selectedImages.clear();
      updateBulkActionsBar();
      resultsHeader.style.display = results.length > 0 ? "flex" : "none";
    }

    for (const item of results) {
      const card = document.createElement("div");
      card.className = "card card--stream-in";
      card.dataset.imagePath = item.path;

      const thumbnailPath = String(item.thumbnail || "");
      const img = _createLazyImg(thumbnailPath, item.path, () => {
        if (!img.dataset.fallbackTried && item.path) {
          img.dataset.fallbackTried = "1";
          img.dataset.lazySrc = toAssetUrl(item.path);
          img.src = toAssetUrl(item.path);
        } else {
          card.style.opacity = "0.5";
        }
      });
      card.appendChild(img);

      // Score badge — calibrated to absolute CLIP range [0.17=0%, 0.35=100%]
      // item.score is the calibrated display score (0–1) set in the search pipeline.
      // Defensive guard: if score > 0.65 it's an old normalized format — re-calibrate.
      if (item.score != null) {
        let displayScore = item.score;
        if (displayScore > 0.65) {
          // Old format: score was normalized to folder-best (0.9–1.0 range).
          // Use _rawScore if present, otherwise clamp the display score.
          const raw = item._rawScore != null ? item._rawScore : null;
          if (raw != null) {
            displayScore = Math.max(0, Math.min(1, (raw - 0.17) / (0.35 - 0.17)));
          } else {
            displayScore = 0;  // unknown raw → don't show misleading 100%
          }
        }
        const pct = Math.round(displayScore * 100);
        if (pct > 0) {  // skip badge for 0% (no useful info to show)
          const badge = document.createElement("div");
          badge.className = "score-badge" + (pct >= 90 ? " score-badge--top" : pct >= 60 ? " score-badge--good" : "");
          badge.textContent = `${pct}%`;
          badge.title = `CLIP match quality: ${pct}% (0%=noise, 100%=excellent)`;
          card.appendChild(badge);
        }
      }

      const overlay = document.createElement("div");
      overlay.className = "card-overlay";

      const openBtn = document.createElement("button");
      openBtn.textContent = "Open";
      openBtn.onclick = (e) => { e.stopPropagation(); openImage(item.path); };

      const similarBtn = document.createElement("button");
      similarBtn.className = "similar-btn";
      similarBtn.textContent = "Similar";
      similarBtn.onclick = (e) => { e.stopPropagation(); searchSimilarImages(item.path); };

      const collectionBtn = document.createElement("button");
      collectionBtn.className = "collection-btn";
      collectionBtn.textContent = "Add to Collection";
      collectionBtn.onclick = (e) => { e.stopPropagation(); addImageToCollection(item.path); };

      overlay.appendChild(openBtn);
      overlay.appendChild(similarBtn);
      overlay.appendChild(collectionBtn);
      card.appendChild(overlay);

      card.addEventListener("click", (e) => {
        if (e.target === img || e.target === card) {
          e.stopPropagation();
          const idx = _allSearchResults.findIndex(r => r.path === item.path);
          openLightbox(idx >= 0 ? idx : 0);
        }
      });

      resultsGrid.appendChild(card);
    }

    // Update results header count
    if (resultsHeader) {
      const total = _allSearchResults.length;
      resultsCountLabel.textContent = `${total} result${total !== 1 ? "s" : ""}`;
      resultsHeader.style.display = total > 0 ? "flex" : "none";
    }
  }

  /* =================== F1 — LIGHTBOX =================== */

  function openLightbox(index) {
    if (!_allSearchResults.length) return;
    _lbIndex = Math.max(0, Math.min(index, _allSearchResults.length - 1));
    _renderLightboxFrame();
    lightboxOverlay.style.display = "flex";
    document.body.style.overflow = "hidden";
  }

  function closeLightbox() {
    lightboxOverlay.style.display = "none";
    document.body.style.overflow = "";
    lightboxImg.src = "";
  }

  function navigateLightbox(delta) {
    const next = _lbIndex + delta;
    if (next < 0 || next >= _allSearchResults.length) return;
    _lbIndex = next;
    _renderLightboxFrame();
  }

  function _renderLightboxFrame() {
    const item = _allSearchResults[_lbIndex];
    if (!item) return;
    lightboxImg.style.opacity = "0";
    setTimeout(() => {
      lightboxImg.src = toAssetUrl(item.path);
      lightboxImg.onload = () => { lightboxImg.style.opacity = "1"; };
    }, 80);
    const filename = (item.path || "").split(/[\\/]/).pop();
    const score = item.score != null ? ` · ${(item.score * 100).toFixed(0)}% match` : "";
    lightboxMeta.innerHTML =
      `<strong>${escapeHtml(filename)}</strong>${score}<br>` +
      `<span title="${escapeHtml(item.path || "")}">${escapeHtml(item.path || "")}</span>`;
    lightboxPrev.disabled = _lbIndex === 0;
    lightboxNext.disabled = _lbIndex === _allSearchResults.length - 1;
    lightboxClose.title = `Close (Esc) — ${_lbIndex + 1} / ${_allSearchResults.length}`;

    // F2: Load EXIF metadata asynchronously (non-blocking)
    _loadLightboxMetadata(item.path);
  }

  async function _loadLightboxMetadata(imagePath) {
    try {
      const m = await invoke("get_image_metadata", { path: imagePath });
      const filename = (imagePath || "").split(/[\\/]/).pop();
      const score = _allSearchResults[_lbIndex]?.score != null
        ? ` · ${(_allSearchResults[_lbIndex].score * 100).toFixed(0)}% match` : "";

      const dims = (m.exif_width && m.exif_height)
        ? `${m.exif_width} × ${m.exif_height}px` : "";
      const camera = [m.camera_make, m.camera_model].filter(Boolean).join(" ").trim();
      const date = m.exif_date ? m.exif_date.replace(/["\\]/g, "") : "";

      let gpsHtml = "";
      if (m.gps_lat != null && m.gps_lon != null) {
        const lat = m.gps_lat.toFixed(5);
        const lon = m.gps_lon.toFixed(5);
        gpsHtml = `<br><a class="lb-gps" href="https://maps.google.com/?q=${lat},${lon}" target="_blank" rel="noopener">📍 ${lat}, ${lon}</a>`;
      }

      const metaParts = [
        dims && `<span class="lb-tag">${dims}</span>`,
        camera && `<span class="lb-tag">📷 ${escapeHtml(camera)}</span>`,
        date && `<span class="lb-tag">🗓 ${escapeHtml(date)}</span>`,
        m.file_size && `<span class="lb-tag">${m.file_size}</span>`,
      ].filter(Boolean).join(" ");

      lightboxMeta.innerHTML =
        `<strong>${escapeHtml(filename)}</strong>${score}<br>` +
        `<span class="lb-path" title="${escapeHtml(imagePath)}">${escapeHtml(imagePath)}</span>` +
        (metaParts ? `<br><div class="lb-tags">${metaParts}</div>` : "") +
        gpsHtml;
    } catch (_) {
      // EXIF load failed — keep basic meta already shown
    }
  }

  lightboxClose.addEventListener("click", closeLightbox);
  lightboxPrev.addEventListener("click", () => navigateLightbox(-1));
  lightboxNext.addEventListener("click", () => navigateLightbox(1));
  lightboxOpenBtn.addEventListener("click", () => {
    const item = _allSearchResults[_lbIndex];
    if (item) openImage(item.path);
  });
  lightboxSimilarBtn.addEventListener("click", () => {
    const item = _allSearchResults[_lbIndex];
    if (item) { closeLightbox(); searchSimilarImages(item.path); }
  });
  lightboxCollectBtn.addEventListener("click", () => {
    const item = _allSearchResults[_lbIndex];
    if (item) addImageToCollection(item.path);
  });
  lightboxOverlay.addEventListener("click", (e) => {
    if (e.target === lightboxOverlay) closeLightbox();
  });

  /* =================== F3 — CHANGE BANNER =================== */

  function _showChangeBanner(newCount, removedCount, folders) {
    const parts = [];
    if (newCount > 0) parts.push(`${newCount} new image${newCount !== 1 ? "s" : ""}`);
    if (removedCount > 0) parts.push(`${removedCount} removed`);
    const folderName = folders.length === 1
      ? (folders[0].split(/[\\/]/).pop() || folders[0])
      : `${folders.length} folders`;
    changeBanner.innerHTML =
      `<span class="banner-msg">📷 ${parts.join(" & ")} detected in <strong>${escapeHtml(folderName)}</strong></span>` +
      `<button class="banner-reindex-btn">Re-index now</button>` +
      `<button class="banner-dismiss-btn">Dismiss</button>`;
    changeBanner.style.display = "flex";
    changeBanner.querySelector(".banner-reindex-btn").addEventListener("click", () => {
      changeBanner.style.display = "none";
      if (!indexQueueRunning) { setIndexingState(true); runIndexQueue(folders); }
    });
    changeBanner.querySelector(".banner-dismiss-btn").addEventListener("click", () => {
      changeBanner.style.display = "none";
    });
  }

  /* =================== F2 — EXPORT COLLECTION =================== */

  async function exportCollection(collectionId, collectionName) {
    const destFolder = await open({ directory: true, title: "Choose export destination" });
    if (!destFolder) return;
    const folder = selectedFolders[0];
    showToast(`Exporting “${collectionName}”…`, 60000);
    try {
      const result = await invoke("export_collection_images", {
        folder,
        collectionId,
        collectionName,
        destFolder: String(destFolder),
      });
      showToast(`✓ Exported ${result.copied} image(s) to ${result.dest}`);
    } catch (err) {
      showToast(`Export failed: ${String(err)}`);
    }
  }

  function toggleImageSelection(imagePath, cardElement) {
    if (selectedImages.has(imagePath)) {
      selectedImages.delete(imagePath);
      cardElement.classList.remove("selected");
    } else {
      selectedImages.add(imagePath);
      cardElement.classList.add("selected");
    }
    updateBulkActionsBar();
  }

  function updateBulkActionsBar() {
    selectedCountSpan.textContent = selectedImages.size;
    
    if (selectedImages.size > 0) {
      bulkActionsBar.classList.add("show");
    } else {
      bulkActionsBar.classList.remove("show");
    }
  }

  /* ------------------ SELECT FOLDER ------------------ */
  async function selectFolder() {
    const folderSelection = await open({ directory: true, multiple: true });
    if (!folderSelection) return;

    const folders = Array.isArray(folderSelection)
      ? folderSelection.filter(Boolean)
      : [folderSelection];

    if (folders.length === 0) return;

    if (indexQueueRunning) {
      showToast("Index queue is already running");
      return;
    }

    setIndexingState(true);
    resultsGrid.innerHTML = "";
    runIndexQueue(folders);
  }

  /* ------------------ UI STATE ------------------ */
  function setIndexingState(state) {
    isIndexing = state;
    searchBtn.disabled = state;
    selectBtn.disabled = state;
    cancelIndexQueueBtn.disabled = !state;

    if (state) {
      statusEl.textContent = "";
      setIndexProgress(8, "Diagnosing folders...");
      return;
    }

    setTimeout(() => {
      hideIndexProgress();
    }, 450);
  }

  /* ------------------ TOGGLE FILTERS ------------------ */
  function toggleFilters() {
    filtersVisible = !filtersVisible;
    filtersContainer.style.display = filtersVisible ? "grid" : "none";
    toggleFiltersBtn.textContent = filtersVisible ? "Hide Filters" : "Show Filters";
  }

  /* ------------------ CLEANUP DATA ------------------ */
  async function cleanupData() {
    if (selectedFolders.length === 0) {
      alert("Please select a folder first.");
      return;
    }

    const confirmed = confirm("Are you sure you want to clean up local data? This will remove cached indexes and thumbnails.");
    if (!confirmed) return;

    statusEl.textContent = "Cleaning up data...";

    try {
      // For now, we'll clean up all data. In the future, we could add options
      // to clean up specific folder data or all data
      const result = await invoke("cleanup_local_data", {});
      console.log("Cleanup result:", result);

      if (result.status === "ok") {
        statusEl.textContent = result.message;
        // Clear the current results since they may reference cleaned up data
        resultsGrid.innerHTML = "";
        selectedFolders = [];
        // Clear search cache as well
        searchCache.clear();
        setPostIndexUIVisible(false);
      } else {
        statusEl.textContent = `Cleanup failed: ${result.message || "Unknown error"}`;
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
      statusEl.textContent = `Cleanup failed: ${String(err)}`;
    }
  }

  /* ------------------ EVENTS ------------------ */
  searchBtn.addEventListener("click", async () => {
    sortSearchMode = "query";
    await search({ useQuery: true });
  });

  // Search on Enter key inside the query input (when suggestions dropdown is closed)
  // The S10 suggestions keydown handler takes priority when the dropdown is open.
  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // Only run search if the suggestions dropdown isn't handling this Enter
      // (suggestions keydown fires first and calls e.preventDefault() when active)
      sortSearchMode = "query";
      search({ useQuery: true });
    }
  });

  selectBtn.addEventListener("click", selectFolder);
    cancelIndexQueueBtn.addEventListener("click", () => {
      if (!indexQueueRunning) return;
      indexQueueCancelled = true;
      showToast("Cancelling index queue...");
    });

  cleanupBtn.addEventListener("click", cleanupData);
  toggleFiltersBtn.addEventListener("click", toggleFilters);
  
  // Bulk actions
  openSelectedBtn.addEventListener("click", openAllSelected);
  copyPathsBtn.addEventListener("click", copySelectedPaths);
  deselectAllBtn.addEventListener("click", deselectAll);

  // Diagnostics button removed — sb-diag-btn now opens Analytics

  // Cleanup Panel
  cleanupIndexBtn.addEventListener("click", showCleanupPanel);
  closeCleanupBtn.addEventListener("click", closeCleanupPanel);
  cleanupRunBtn.addEventListener("click", runCleanup);

  // Duplicates Panel
  duplicatesBtn.addEventListener("click", showDuplicatesPanel);
  closeDuplicatesBtn.addEventListener("click", closeDuplicatesPanel);
  refreshDuplicatesBtn.addEventListener("click", loadDuplicates);
  duplicatesContent.addEventListener("click", (e) => {
    const deleteBtn = e.target.closest(".delete-duplicate-group-btn");
    if (!deleteBtn) return;
    const groupIdx = Number(deleteBtn.dataset.groupIdx);
    deleteDuplicateGroup(groupIdx);
  });
  duplicateThresholdInput.addEventListener("input", (e) => {
    thresholdValueSpan.textContent = parseFloat(e.target.value).toFixed(2);
  });

  // Collections Panel
  collectionsBtn.addEventListener("click", showCollectionsPanel);
  closeCollectionsBtn.addEventListener("click", closeCollectionsPanel);
  createCollectionBtn.addEventListener("click", createNewCollection);
  collectionsContent.addEventListener("click", (e) => {
    const viewBtn = e.target.closest("[data-action='view-collection']");
    if (viewBtn) {
      const collectionId = viewBtn.dataset.collectionId;
      if (collectionId) {
        viewCollection(collectionId);
      }
      return;
    }

    const deleteBtn = e.target.closest("[data-action='delete-collection']");
    if (deleteBtn) {
      const collectionId = deleteBtn.dataset.collectionId;
      if (collectionId) deleteCollection(collectionId);
      return;
    }

    // Add images to collection
    const addImgBtn = e.target.closest("[data-action='add-images-to-collection']");
    if (addImgBtn) {
      const collectionId   = addImgBtn.dataset.collectionId;
      const collectionName = addImgBtn.dataset.collectionName || collectionId;
      if (collectionId) openAddImagesFlow(collectionId, collectionName);
      return;
    }

    // F2: Export collection
    const exportBtn = e.target.closest("[data-action='export-collection']");
    if (exportBtn) {
      const collectionId = exportBtn.dataset.collectionId;
      const collectionName = exportBtn.dataset.collectionName || collectionId;
      if (collectionId && selectedFolders.length > 0) exportCollection(collectionId, collectionName);
    }
  });
  newCollectionInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      createNewCollection();
    }
  });

  // Analytics (S7: upgraded)
  analyticsBtn.addEventListener("click", showAnalytics);
  closeAnalyticsBtn.addEventListener("click", () => { analyticsPanel.style.display = "none"; });

  // S7-F1: Command Palette button
  if (paletteBtn) paletteBtn.addEventListener("click", openCommandPalette);

  // S7-F2: Export metadata CSV
  if (exportMetadataBtn) exportMetadataBtn.addEventListener("click", exportMetadataCSV);

  // S6-F2: Timeline toggle
  timelineToggleBtn.addEventListener("click", async () => {
    _timelineMode = !_timelineMode;
    timelineToggleBtn.classList.toggle("active", _timelineMode);
    timelineToggleBtn.textContent = _timelineMode ? "🔳 Grid" : "📅 Timeline";
    if (_allSearchResults.length > 0) {
      const toShow = _allSearchResults.slice(0, _displayedCount || _allSearchResults.length);
      await displayResults(toShow);
    }
  });

  // S6-F3: Status bar diagnostics button
  sbDiagBtn.addEventListener("click", showAnalytics);

  // Filename search modal
  filenameSearchBtn.addEventListener("click", searchByFilename);
  filenameCancelBtn.addEventListener("click", closeFilenameSearchModal);
  filenameSearchInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      searchByFilename();
    }
  });
  filenameSearchModal.addEventListener("click", (e) => {
    if (e.target === filenameSearchModal) {
      closeFilenameSearchModal();
    }
  });

  
  pinSearchBtn.addEventListener("click", () => {
    const currentQuery = queryInput.value.trim();
    if (!currentQuery) {
      alert("Enter a search query first");
      return;
    }
    
    if (pinnedSearches.includes(currentQuery)) {
      pinnedSearches = pinnedSearches.filter(q => q !== currentQuery);
    } else {
      if (pinnedSearches.length >= 10) {
        alert("Maximum 10 pinned searches allowed");
        return;
      }
      pinnedSearches.push(currentQuery);
    }
    savePinnedSearches();
    updatePinnedSearchesUI();
    updatePinButton();
  });

  queryInput.addEventListener("change", updatePinButton);

  // Relevance threshold slider
  const thresholdSlider = document.getElementById("relevance-threshold");
  const thresholdLabel  = document.getElementById("threshold-pct-label");
  const thresholdDesc   = document.getElementById("threshold-desc");
  if (thresholdSlider) {
    thresholdSlider.addEventListener("input", () => {
      const pct = parseInt(thresholdSlider.value, 10);
      _relevanceThreshold = pct / 100;
      // Compute the actual absolute CLIP minimum (mirrors Python logic)
      const t = _relevanceThreshold;
      const clipMin = (0.17 + Math.max(0, (t - 0.5)) / 0.5 * (0.30 - 0.17)).toFixed(2);
      if (thresholdLabel) thresholdLabel.textContent = `${pct}%`;
      if (thresholdDesc) {
        if (pct >= 95) {
          thresholdDesc.textContent = `Very strict — only excellent matches (CLIP ≥ ${clipMin}). Folders without relevant images return 0 results.`;
        } else if (pct >= 80) {
          thresholdDesc.textContent = `Moderate — filters random screenshots, shows good matches (CLIP ≥ ${clipMin})`;
        } else if (pct >= 65) {
          thresholdDesc.textContent = `Relaxed — shows a broader range of related images (CLIP ≥ ${clipMin})`;
        } else {
          thresholdDesc.textContent = `Loose — shows most images above noise level (CLIP ≥ ${clipMin}). May include less relevant results.`;
        }
      }
    });
  }

  // Trigger search when filter/sort changes (if there is enough context)
  sortSelect.addEventListener("change", () => {
    if (selectedFolders.length === 0) {
      lastSortValue = sortSelect.value;
      return;
    }

    // Handle filename sort specially - show filename search modal
    if (sortSelect.value === "filename") {
      lastSortValue = sortSelect.value;
      showFilenameSearchModal();
      return;
    }

    pendingSortValue = sortSelect.value;
    setSortModalVisible(true);
  });

  sortWithQueryBtn.addEventListener("click", async () => {
    sortSearchMode = "query";
    lastSortValue = pendingSortValue || sortSelect.value;
    setSortModalVisible(false);
    await search({ useQuery: true, sortOverride: sortSelect.value });
  });

  sortOnlyBtn.addEventListener("click", async () => {
    sortSearchMode = "all";
    lastSortValue = pendingSortValue || sortSelect.value;
    setSortModalVisible(false);
    await search({ useQuery: false, sortOverride: sortSelect.value });
  });

  sortCancelBtn.addEventListener("click", () => {
    sortSelect.value = lastSortValue;
    pendingSortValue = null;
    setSortModalVisible(false);
  });

  fileTypeSelect.addEventListener("change", () => {
    if (selectedFolders.length === 0) return;
    if (sortSearchMode === "query" && !queryInput.value.trim()) return;
    search({ useQuery: sortSearchMode === "query" });
  });

  minWidthInput.addEventListener("change", () => {
    if (selectedFolders.length === 0) return;
    if (sortSearchMode === "query" && !queryInput.value.trim()) return;
    search({ useQuery: sortSearchMode === "query" });
  });

  minHeightInput.addEventListener("change", () => {
    if (selectedFolders.length === 0) return;
    if (sortSearchMode === "query" && !queryInput.value.trim()) return;
    search({ useQuery: sortSearchMode === "query" });
  });

  sortConfirmModal.addEventListener("click", (e) => {
    if (e.target === sortConfirmModal) {
      sortSelect.value = lastSortValue;
      pendingSortValue = null;
      setSortModalVisible(false);
    }
  });

  /* =================== F4 — KEYBOARD SHORTCUTS =================== */
  document.addEventListener("keydown", (e) => {
    const inInput = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT";
    const lbOpen = lightboxOverlay.style.display !== "none";

    // Lightbox-specific keys (always active when lightbox is open)
    if (lbOpen) {
      if (e.key === "ArrowLeft")  { e.preventDefault(); navigateLightbox(-1); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); navigateLightbox(1);  return; }
      if (e.key === "Escape")     { e.preventDefault(); closeLightbox();       return; }
      if (e.key === "o" || e.key === "O") {
        const item = _allSearchResults[_lbIndex];
        if (item) openImage(item.path);
        return;
      }
      return; // Swallow all other keys while lightbox is open
    }

    // Skip shortcuts when user is typing in a field
    if (inInput) return;

    // / — focus search
    if (e.key === "/") {
      e.preventDefault();
      queryInput.focus();
      queryInput.select();
      return;
    }

    // Escape — close topmost open panel (palette first)
    if (e.key === "Escape") {
      if (cmdPaletteOverlay && cmdPaletteOverlay.style.display !== "none") { closeCommandPalette(); return; }
      const panels = [
        [analyticsPanel,    () => analyticsPanel.style.display    = "none"],
        [collectionsPanel,  () => collectionsPanel.style.display  = "none"],
        [duplicatesPanel,   () => duplicatesPanel.style.display   = "none"],
        [cleanupPanel,      () => cleanupPanel.style.display      = "none"],
      ];
      for (const [el, close] of panels) {
        if (el && el.style.display !== "none") { close(); return; }
      }
      // Deselect all images
      if (selectedImages.size > 0) { deselectAll(); }
      return;
    }

    // Ctrl+A — select all visible cards
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      e.preventDefault();
      document.querySelectorAll(".card").forEach(card => {
        const path = card.dataset.imagePath;
        if (path && !selectedImages.has(path)) {
          selectedImages.add(path);
          card.classList.add("selected");
        }
      });
      updateBulkActionsBar();
      return;
    }

    // S7-F1: Ctrl+K / Cmd+K — open command palette
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      openCommandPalette();
      return;
    }

    // S8-F2: ? — open keyboard shortcuts cheatsheet
    if (e.key === "?") {
      e.preventDefault();
      openShortcutsOverlay();
      return;
    }
  });

  /* =================== S7-F3 — ANALYTICS (RICH) =================== */

  function _fmtBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }


  /* =================== S7-F2 — EXPORT METADATA CSV =================== */

  async function exportMetadataCSV() {
    if (_allSearchResults.length === 0 && selectedImages.size === 0) {
      showToast("No images to export — run a search first");
      return;
    }

    // Prefer selected images, fall back to all visible results
    const paths = selectedImages.size > 0
      ? Array.from(selectedImages)
      : _allSearchResults.slice(0, _displayedCount || _allSearchResults.length).map(r => r.path).filter(Boolean);

    if (paths.length === 0) { showToast("Nothing to export"); return; }

    // Pick save destination
    const { save } = await import("@tauri-apps/plugin-dialog");
    const outputPath = await save({
      title: "Export Metadata CSV",
      defaultPath: `photo_metadata_${new Date().toISOString().slice(0,10)}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });

    if (!outputPath) return; // User cancelled

    showToast(`📄 Exporting ${paths.length} entries…`);
    try {
      const result = await invoke("export_metadata_csv", { paths, outputPath });
      showToast(`✓ Exported ${result.exported} rows to ${outputPath.split(/[\\/]/).pop()}`);
    } catch (err) {
      showToast(`Export failed: ${String(err)}`);
    }
  }

  /* =================== S7-F1 — COMMAND PALETTE =================== */

  // Registry of all commands
  const COMMANDS = [
    { icon: "🔍", title: "Search Photos",           desc: "Run an AI semantic search",             shortcut: "Enter",    action: () => { queryInput.focus(); } },
    { icon: "📁", title: "Add Folder",              desc: "Select a folder to index",              shortcut: "Ctrl+O",  action: () => selectBtn.click() },
    { icon: "📅", title: "Toggle Timeline View",    desc: "Switch between grid and date groups",   shortcut: "",         action: () => timelineToggleBtn.click() },
    { icon: "📈", title: "Show Analytics",          desc: "Photo stats, file types, year chart",   shortcut: "",         action: () => showAnalytics() },
    { icon: "🔀", title: "Find Duplicates",         desc: "Scan for duplicate images",             shortcut: "",         action: () => duplicatesBtn?.click() },
    { icon: "🧹", title: "Cleanup Index",           desc: "Remove orphaned embeddings, compact",   shortcut: "",         action: () => cleanupIndexBtn?.click() },
    { icon: "📚", title: "Open Collections",        desc: "Manage photo collections",              shortcut: "",         action: () => collectionsBtn?.click() },
    { icon: "📤", title: "Export Collection",       desc: "Export a collection to a folder",       shortcut: "",         action: () => collectionsBtn?.click() },
    { icon: "📄", title: "Export Metadata CSV",     desc: "Save EXIF data for selected photos",    shortcut: "",         action: () => exportMetadataCSV() },
    { icon: "🖌", title: "Find by Filename",        desc: "Search by file name substring",         shortcut: "",         action: () => { if (typeof showFilenameSearchModal === "function") showFilenameSearchModal(); } },
    { icon: "☑️", title: "Select All Images",       desc: "Select all visible result cards",       shortcut: "Ctrl+A",   action: () => {
        document.querySelectorAll(".card").forEach(c => { const p = c.dataset.imagePath; if (p) { selectedImages.add(p); c.classList.add("selected"); } });
        updateBulkActionsBar();
      }
    },
    { icon: "❌", title: "Deselect All",             desc: "Clear image selection",                 shortcut: "Esc",      action: () => deselectAll() },
    { icon: "📎", title: "Copy Image Paths",        desc: "Copy paths of selected images",         shortcut: "",         action: () => copyPathsBtn?.click() },
    { icon: "⌨️", title: "Focus Search Box",        desc: "Jump to the search input",              shortcut: "/",        action: () => { queryInput.focus(); queryInput.select(); } },
    { icon: "✏️", title: "Batch Rename",             desc: "Rename selected photos with a pattern", shortcut: "",         action: () => openRenameModal() },
    { icon: "?",  title: "Keyboard Shortcuts",       desc: "Show all keyboard shortcuts",           shortcut: "?",        action: () => openShortcutsOverlay() },
  ];

  let _paletteActiveIdx = 0;
  let _paletteFiltered = [...COMMANDS];

  function _fuzzyMatch(query, text) {
    if (!query) return { matched: true, html: escapeHtml(text), score: 0 };
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    let qi = 0, score = 0;
    let html = "";
    for (let i = 0; i < text.length; i++) {
      if (qi < q.length && t[i] === q[qi]) {
        html += `<span class="cmd-match">${escapeHtml(text[i])}</span>`;
        score += (qi === i ? 2 : 1); // bonus for consecutive start
        qi++;
      } else {
        html += escapeHtml(text[i]);
      }
    }
    return { matched: qi === q.length, html, score };
  }

  function _renderPaletteList() {
    const query = cmdPaletteInput.value;
    _paletteFiltered = COMMANDS
      .map(cmd => {
        const m = _fuzzyMatch(query, cmd.title);
        return { ...cmd, _html: m.html, _score: m.score, _matched: m.matched };
      })
      .filter(cmd => cmd._matched)
      .sort((a, b) => b._score - a._score);

    if (_paletteActiveIdx >= _paletteFiltered.length) _paletteActiveIdx = 0;

    if (_paletteFiltered.length === 0) {
      cmdPaletteList.innerHTML = `<li class="cmd-palette-empty">No commands match “${escapeHtml(query)}”</li>`;
      return;
    }

    cmdPaletteList.innerHTML = _paletteFiltered.map((cmd, i) => `
      <li class="cmd-palette-item${i === _paletteActiveIdx ? " active" : ""}" data-idx="${i}" role="option">
        <span class="cmd-palette-item-icon">${cmd.icon}</span>
        <span class="cmd-palette-item-body">
          <div class="cmd-palette-item-title">${cmd._html}</div>
          <div class="cmd-palette-item-desc">${escapeHtml(cmd.desc)}</div>
        </span>
        ${cmd.shortcut ? `<span class="cmd-palette-item-shortcut"><kbd>${escapeHtml(cmd.shortcut)}</kbd></span>` : ""}
      </li>`).join("");

    // Scroll active item into view
    const activeEl = cmdPaletteList.querySelector(".active");
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }

  function openCommandPalette() {
    cmdPaletteInput.value = "";
    _paletteActiveIdx = 0;
    _renderPaletteList();
    cmdPaletteOverlay.style.display = "flex";
    setTimeout(() => cmdPaletteInput.focus(), 30);
  }

  function closeCommandPalette() {
    cmdPaletteOverlay.style.display = "none";
  }

  function _runPaletteAction() {
    const cmd = _paletteFiltered[_paletteActiveIdx];
    if (!cmd) return;
    closeCommandPalette();
    setTimeout(() => cmd.action(), 60); // slight delay so overlay closes first
  }

  // Palette events
  cmdPaletteInput.addEventListener("input", () => { _paletteActiveIdx = 0; _renderPaletteList(); });

  cmdPaletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); _paletteActiveIdx = Math.min(_paletteActiveIdx + 1, _paletteFiltered.length - 1); _renderPaletteList(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); _paletteActiveIdx = Math.max(_paletteActiveIdx - 1, 0); _renderPaletteList(); }
    else if (e.key === "Enter") { e.preventDefault(); _runPaletteAction(); }
    else if (e.key === "Escape") { e.preventDefault(); closeCommandPalette(); }
  });

  cmdPaletteList.addEventListener("click", (e) => {
    const li = e.target.closest(".cmd-palette-item");
    if (!li) return;
    _paletteActiveIdx = parseInt(li.dataset.idx, 10);
    _runPaletteAction();
  });

  cmdPaletteOverlay.addEventListener("click", (e) => {
    if (e.target === cmdPaletteOverlay) closeCommandPalette();
  });

  /* =================== S8-F2 — KEYBOARD SHORTCUTS OVERLAY =================== */

  function openShortcutsOverlay() {
    shortcutsOverlay.style.display = "flex";
  }

  function closeShortcutsOverlay() {
    shortcutsOverlay.style.display = "none";
  }

  if (closeShortcutsBtn) closeShortcutsBtn.addEventListener("click", closeShortcutsOverlay);
  if (sbShortcutsBtn)    sbShortcutsBtn.addEventListener("click", openShortcutsOverlay);
  shortcutsOverlay.addEventListener("click", (e) => { if (e.target === shortcutsOverlay) closeShortcutsOverlay(); });

  // Add shortcuts overlay to the Escape-close chain (highest priority, after palette)
  const _origKeydown = document.onkeydown;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && shortcutsOverlay && shortcutsOverlay.style.display !== "none") {
      closeShortcutsOverlay();
    }
  }, true); // capture phase so it fires before other keydown handlers

  /* =================== S8-F1 — BATCH RENAME =================== */

  // Current pending renames: array of {from, to, fromName, toName}
  let _pendingRenames = [];

  function _applyPattern(pattern, originalName, ext, index, mtime) {
    const d = mtime ? new Date(mtime * 1000) : new Date();
    const year  = String(d.getFullYear());
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day   = String(d.getDate()).padStart(2, "0");
    const date  = `${year}${month}${day}`;

    // Remove extension from original name for {original}
    const baseName = originalName.replace(/\.[^.]+$/, "");

    // Handle {index:N} token — zero-padded index
    let result = pattern.replace(/\{index:(\d+)\}/g, (_, width) =>
      String(index).padStart(parseInt(width, 10), "0")
    );

    result = result
      .replace(/\{original\}/g, baseName)
      .replace(/\{date\}/g, date)
      .replace(/\{year\}/g, year)
      .replace(/\{month\}/g, month)
      .replace(/\{day\}/g, day)
      .replace(/\{ext\}/g, ext);

    // Append extension automatically if {ext} not used
    if (!pattern.includes("{ext}") && ext) {
      result = result + "." + ext;
    }

    return result;
  }

  async function _updateRenamePreview() {
    const pattern = renamePatternInput.value.trim() || "{original}";
    const paths = Array.from(selectedImages);
    if (paths.length === 0) return;

    // Batch-fetch mtimes for date tokens
    let mtimeMap = {};
    try {
      mtimeMap = await invoke("get_files_mtime", { paths });
    } catch (_) {}

    _pendingRenames = paths.map((from, i) => {
      const fileName  = from.split(/[\\/]/).pop();
      const ext       = (fileName.split(".").pop() || "").toLowerCase();
      const mtime     = mtimeMap[from] || 0;
      const dir       = from.substring(0, from.length - fileName.length);
      const toName    = _applyPattern(pattern, fileName, ext, i + 1, mtime);
      const to        = dir + toName;
      return { from, to, fromName: fileName, toName };
    });

    // Render preview (first 10)
    const preview = _pendingRenames.slice(0, 10);
    renamePreviewList.innerHTML = preview.map(({ fromName, toName }) =>
      `<li>
        <span class="rename-preview-from">${escapeHtml(fromName)}</span>
        <span class="rename-preview-arrow">→</span>
        <span class="rename-preview-to">${escapeHtml(toName)}</span>
      </li>`
    ).join("");

    const extra = _pendingRenames.length - preview.length;
    renamePreviewNote.textContent = extra > 0
      ? `(showing 10 of ${_pendingRenames.length})`
      : `(${_pendingRenames.length} file${_pendingRenames.length !== 1 ? "s" : ""})`;
  }

  function openRenameModal() {
    if (selectedImages.size === 0) {
      showToast("Select images first to rename them");
      return;
    }
    renamePatternInput.value = "{original}";
    renameModalOverlay.style.display = "flex";
    _updateRenamePreview();
    renamePatternInput.focus();
  }

  function closeRenameModal() {
    renameModalOverlay.style.display = "none";
    _pendingRenames = [];
  }

  // Token chip click → insert at cursor position
  document.querySelectorAll(".rename-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const token = chip.dataset.token;
      const pos = renamePatternInput.selectionStart ?? renamePatternInput.value.length;
      const before = renamePatternInput.value.slice(0, pos);
      const after  = renamePatternInput.value.slice(pos);
      renamePatternInput.value = before + token + after;
      renamePatternInput.focus();
      renamePatternInput.selectionStart = renamePatternInput.selectionEnd = pos + token.length;
      _updateRenamePreview();
    });
  });

  renamePatternInput.addEventListener("input", _updateRenamePreview);

  if (renameSelectedBtn) renameSelectedBtn.addEventListener("click", openRenameModal);
  if (renameCancelBtn)   renameCancelBtn.addEventListener("click", closeRenameModal);
  if (renameModalClose)  renameModalClose.addEventListener("click", closeRenameModal);
  renameModalOverlay.addEventListener("click", (e) => { if (e.target === renameModalOverlay) closeRenameModal(); });

  renameConfirmBtn.addEventListener("click", async () => {
    if (_pendingRenames.length === 0) return;

    renameConfirmBtn.disabled = true;
    renameConfirmBtn.textContent = "Renaming…";
    try {
      const renames = _pendingRenames.map(({ from, to }) => ({ from, to }));
      const result = await invoke("batch_rename_files", { renames });
      closeRenameModal();

      let msg = `✓ Renamed ${result.ok} file${result.ok !== 1 ? "s" : ""}`;
      if (result.failed > 0) msg += ` · ${result.failed} failed`;
      showToast(msg);

      // Clear selection since files no longer exist at old paths
      deselectAll();
    } catch (err) {
      showToast(`Rename failed: ${String(err)}`);
    } finally {
      renameConfirmBtn.disabled = false;
      renameConfirmBtn.textContent = "Rename Files";
    }
  });

  /* =================== S8-F3 — AUTO-SCAN =================== */

  const AUTO_SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  let _autoScanTotalNew     = 0;
  let _autoScanTotalRemoved = 0;
  let _autoScanIntervalId   = null;

  async function runAutoScan() {
    if (selectedFolders.length === 0) return;

    let newCount = 0;
    let removedCount = 0;
    const affected = [];

    for (const folder of selectedFolders) {
      try {
        const changes = await invoke("engine_check_changes", { folder });
        const n = changes?.new_count     || 0;
        const r = changes?.removed_count || 0;
        if (n + r > 0) {
          newCount     += n;
          removedCount += r;
          affected.push(folder);
        }
      } catch (_) { /* non-fatal */ }
    }

    _autoScanTotalNew     = newCount;
    _autoScanTotalRemoved = removedCount;

    if ((newCount + removedCount) > 0) {
      // Show pulsing badge
      const parts = [];
      if (newCount     > 0) parts.push(`+${newCount}`);
      if (removedCount > 0) parts.push(`-${removedCount}`);
      sbScanBadge.textContent = `🔔 ${parts.join(" ")} new`;
      sbScanBadge.style.display = "inline-flex";
      sbScanBadge.title = `${newCount} new, ${removedCount} removed — click to review`;

      // Wire badge click → show change banner + offer re-index
      sbScanBadge._handler && sbScanBadge.removeEventListener("click", sbScanBadge._handler);
      sbScanBadge._handler = () => {
        if (affected.length > 0) _showChangeBanner(newCount, removedCount, affected);
        sbScanBadge.style.display = "none";
      };
      sbScanBadge.addEventListener("click", sbScanBadge._handler);
    } else {
      // No changes — hide badge
      sbScanBadge.style.display = "none";
    }
  }

  function startAutoScan() {
    if (_autoScanIntervalId) return; // already running
    // First scan after 5 minutes (not immediately on startup — daemon needs to warm up)
    _autoScanIntervalId = setInterval(runAutoScan, AUTO_SCAN_INTERVAL_MS);
  }

  // Start auto-scan once folders are loaded
  if (selectedFolders.length > 0) startAutoScan();

  // Also start after index queue finishes (new folders may have been added)
  // This is handled inline in runIndexQueue: startAutoScan() called after setIndexingState(false)

  /* =================== S9-F2 — COMPARE MODAL =================== */

  // Show/hide the compare button based on selection count
  const _origUpdateBulkBar = updateBulkActionsBar;
  function updateBulkActionsBarExtended() {
    _origUpdateBulkBar();
    if (compareSelectedBtn) {
      compareSelectedBtn.style.display = selectedImages.size === 2 ? "inline-flex" : "none";
    }
  }
  // Monkey-patch: replace all future calls by redefining the function in scope
  // We call updateBulkActionsBarExtended from S9 event handlers explicitly instead.

  function openCompareModal() {
    const paths = Array.from(selectedImages);
    if (paths.length !== 2) return;
    const [pathA, pathB] = paths;
    const nameA = pathA.split(/[\\/]/).pop();
    const nameB = pathB.split(/[\\/]/).pop();
    compareImgA.src = convertFileSrc(pathA);
    compareImgB.src = convertFileSrc(pathB);
    compareLabelA.textContent = nameA;
    compareLabelB.textContent = nameB;
    compareModal.style.display = "flex";
    _initCompareZoom();
  }

  function closeCompareModal() {
    compareModal.style.display = "none";
    _cleanupCompareZoom();
  }

  if (compareSelectedBtn) compareSelectedBtn.addEventListener("click", openCompareModal);
  if (compareModalClose)  compareModalClose.addEventListener("click", closeCompareModal);
  compareModal.addEventListener("click", (e) => { if (e.target === compareModal) closeCompareModal(); });

  // Per-panel zoom + pan state
  const _compareState = {
    a: { scale: 1, tx: 0, ty: 0, dragging: false, startX: 0, startY: 0, startTx: 0, startTy: 0 },
    b: { scale: 1, tx: 0, ty: 0, dragging: false, startX: 0, startY: 0, startTx: 0, startTy: 0 },
  };

  function _applyCompareTransform(img, state) {
    img.style.transform = `scale(${state.scale}) translate(${state.tx}px, ${state.ty}px)`;
  }

  function _initCompareZoom() {
    const panels = [
      { wrap: compareImgA.parentElement, img: compareImgA, key: "a" },
      { wrap: compareImgB.parentElement, img: compareImgB, key: "b" },
    ];
    for (const { wrap, img, key } of panels) {
      const st = _compareState[key];
      st.scale = 1; st.tx = 0; st.ty = 0;
      _applyCompareTransform(img, st);

      wrap._onWheel = (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        st.scale = Math.max(0.5, Math.min(8, st.scale + delta));
        _applyCompareTransform(img, st);
      };
      wrap._onMousedown = (e) => {
        st.dragging = true;
        st.startX = e.clientX; st.startY = e.clientY;
        st.startTx = st.tx;    st.startTy = st.ty;
      };
      wrap._onMousemove = (e) => {
        if (!st.dragging) return;
        st.tx = st.startTx + (e.clientX - st.startX) / st.scale;
        st.ty = st.startTy + (e.clientY - st.startY) / st.scale;
        _applyCompareTransform(img, st);
      };
      wrap._onMouseup = () => { st.dragging = false; };

      wrap.addEventListener("wheel", wrap._onWheel, { passive: false });
      wrap.addEventListener("mousedown", wrap._onMousedown);
      window.addEventListener("mousemove", wrap._onMousemove);
      window.addEventListener("mouseup",  wrap._onMouseup);
    }
  }

  function _cleanupCompareZoom() {
    const panels = [
      { wrap: compareImgA.parentElement },
      { wrap: compareImgB.parentElement },
    ];
    for (const { wrap } of panels) {
      if (wrap._onWheel)     wrap.removeEventListener("wheel",     wrap._onWheel);
      if (wrap._onMousedown) wrap.removeEventListener("mousedown", wrap._onMousedown);
      if (wrap._onMousemove) window.removeEventListener("mousemove", wrap._onMousemove);
      if (wrap._onMouseup)   window.removeEventListener("mouseup",   wrap._onMouseup);
    }
  }

  // Esc closes compare modal too
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && compareModal && compareModal.style.display !== "none") {
      closeCompareModal();
    }
  }, true);

  // Wire compare btn into selection changes
  const _checkCompareBtn = () => {
    if (compareSelectedBtn)
      compareSelectedBtn.style.display = selectedImages.size === 2 ? "inline-flex" : "none";
  };

  // Patch deselectAll to also update compare btn
  const _origDeselectAll = deselectAll;
  function deselectAllExtended() {
    _origDeselectAll();
    _checkCompareBtn();
  }
  // Hook into card selection via event delegation on resultsGrid
  resultsGrid.addEventListener("click", () => setTimeout(_checkCompareBtn, 0));
  if (deselectAllBtn) deselectAllBtn.addEventListener("click", () => setTimeout(_checkCompareBtn, 30));

  /* =================== S9-F1 — SLIDESHOW =================== */

  let _slideshowTimer = null;

  function startSlideshow() {
    if (_slideshowTimer) return;
    const interval = parseInt(slideshowSpeed.value, 10) || 4000;
    _slideshowTimer = setInterval(_slideshowTick, interval);
    slideshowPlayBtn.textContent = "⏸";
    slideshowPlayBtn.classList.add("playing");
    slideshowPlayBtn.title = "Pause slideshow";
  }

  function stopSlideshow() {
    if (_slideshowTimer) { clearInterval(_slideshowTimer); _slideshowTimer = null; }
    slideshowPlayBtn.textContent = "▶";
    slideshowPlayBtn.classList.remove("playing");
    slideshowPlayBtn.title = "Start slideshow";
  }

  function _slideshowTick() {
    if (_allSearchResults.length < 2) { stopSlideshow(); return; }
    // Fade out
    lightboxImg.classList.add("fade-out");
    setTimeout(() => {
      navigateLightbox(1);
      lightboxImg.classList.remove("fade-out");
      lightboxImg.classList.add("fade-in");
      setTimeout(() => lightboxImg.classList.remove("fade-in"), 320);
    }, 300);
  }

  if (slideshowPlayBtn) {
    slideshowPlayBtn.addEventListener("click", () => {
      if (_slideshowTimer) stopSlideshow(); else startSlideshow();
    });
  }

  // Restart with new interval if speed changes while playing
  if (slideshowSpeed) {
    slideshowSpeed.addEventListener("change", () => {
      if (_slideshowTimer) { stopSlideshow(); startSlideshow(); }
    });
  }

  // Stop slideshow on manual navigation or lightbox close
  if (lightboxPrev) lightboxPrev.addEventListener("click", stopSlideshow);
  if (lightboxNext) lightboxNext.addEventListener("click", stopSlideshow);
  if (lightboxClose) {
    const _origLbClose = lightboxClose.onclick;
    lightboxClose.addEventListener("click", stopSlideshow);
  }

  /* =================== S9-F3 — IMAGE TAGGING =================== */

  let _tagCurrentPath   = null;
  let _tagCurrentFolder = null;
  let _tagCurrentTags   = [];     // live tag array for the current image
  let _allFolderTags    = [];     // all tags in the current folder (for suggestions)

  function _renderTagChips() {
    tagChipsRow.innerHTML = _tagCurrentTags.map(tag =>
      `<span class="tag-chip" data-tag="${escapeHtml(tag)}">
        ${escapeHtml(tag)}
        <button class="tag-chip-remove" data-tag="${escapeHtml(tag)}" title="Remove tag">×</button>
      </span>`
    ).join("");
  }

  function _renderTagSuggestions(filter) {
    const q = (filter || "").toLowerCase();
    const existing = new Set(_tagCurrentTags);
    const suggestions = _allFolderTags
      .filter(t => !existing.has(t) && (!q || t.includes(q)))
      .slice(0, 12);
    tagSuggestionsRow.innerHTML = suggestions.map(t =>
      `<span class="tag-suggestion-chip" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`
    ).join("");
  }

  async function _addTag(raw) {
    const tag = raw.trim().toLowerCase();
    if (!tag || _tagCurrentTags.includes(tag)) return;
    _tagCurrentTags = [..._tagCurrentTags, tag].sort();
    _renderTagChips();
    _renderTagSuggestions(tagInput.value);
    await _saveCurrentTags();
    _refreshCardTags(_tagCurrentPath, _tagCurrentTags);
  }

  async function _removeTag(tag) {
    _tagCurrentTags = _tagCurrentTags.filter(t => t !== tag);
    _renderTagChips();
    _renderTagSuggestions(tagInput.value);
    await _saveCurrentTags();
    _refreshCardTags(_tagCurrentPath, _tagCurrentTags);
  }

  async function _saveCurrentTags() {
    if (!_tagCurrentPath || !_tagCurrentFolder) return;
    try {
      await invoke("set_image_tags", {
        folder: _tagCurrentFolder,
        path:   _tagCurrentPath,
        tags:   _tagCurrentTags,
      });
      // Refresh suggestion pool
      _allFolderTags = await invoke("get_all_tags", { folder: _tagCurrentFolder });
    } catch (err) {
      showToast(`Tag save failed: ${String(err)}`);
    }
  }

  async function openTagEditor(imagePath) {
    _tagCurrentPath = imagePath;
    _tagCurrentFolder = selectedFolders[0] || null;
    if (!_tagCurrentFolder) { showToast("No folder selected"); return; }

    lightboxTagBtn.classList.add("active");
    tagEditorPanel.style.display = "block";
    tagInput.value = "";

    try {
      _tagCurrentTags = await invoke("get_image_tags", {
        folder: _tagCurrentFolder,
        path:   _tagCurrentPath,
      });
      _allFolderTags = await invoke("get_all_tags", { folder: _tagCurrentFolder });
    } catch (_) {
      _tagCurrentTags = [];
      _allFolderTags  = [];
    }
    _renderTagChips();
    _renderTagSuggestions("");
    tagInput.focus();
  }

  function closeTagEditor() {
    tagEditorPanel.style.display = "none";
    if (lightboxTagBtn) lightboxTagBtn.classList.remove("active");
    _tagCurrentPath = null;
  }

  // Overlay tag pills on a grid card
  function _refreshCardTags(path, tags) {
    const card = document.querySelector(`.card[data-image-path="${CSS.escape(path)}"]`);
    if (!card) return;
    let tagsDiv = card.querySelector(".card-tags");
    if (!tagsDiv) {
      tagsDiv = document.createElement("div");
      tagsDiv.className = "card-tags";
      card.appendChild(tagsDiv);
    }
    if (!tags || tags.length === 0) { tagsDiv.innerHTML = ""; return; }
    tagsDiv.innerHTML = tags.slice(0, 3).map(t =>
      `<span class="card-tag-pill">${escapeHtml(t)}</span>`
    ).join("");
  }

  // Load and render tag pills for all visible cards (called after search)
  async function loadCardTagsForFolder(folder) {
    if (!folder) return;
    try {
      // Read the full tags map from Rust (get_all_tags only gives us tag names).
      // We re-use get_images_by_tag per-tag strategy is expensive; instead read raw via
      // get_folder_analytics-like approach — but we don't have a "get_all_tag_assignments" command.
      // Strategy: for each visible card path, call get_image_tags in a micro-batch.
      const cards = document.querySelectorAll(".card[data-image-path]");
      const batchSize = 20;
      for (let i = 0; i < cards.length; i += batchSize) {
        const batch = Array.from(cards).slice(i, i + batchSize);
        await Promise.all(batch.map(async card => {
          const p = card.dataset.imagePath;
          if (!p) return;
          try {
            const tags = await invoke("get_image_tags", { folder, path: p });
            if (tags && tags.length > 0) _refreshCardTags(p, tags);
          } catch (_) {}
        }));
      }
    } catch (_) {}
  }

  // Event wiring — tag editor
  if (lightboxTagBtn) {
    lightboxTagBtn.addEventListener("click", () => {
      const item = _allSearchResults[_lbIndex];
      if (!item) return;
      if (tagEditorPanel.style.display !== "none") { closeTagEditor(); }
      else { openTagEditor(item.path); }
    });
  }

  if (tagEditorClose) tagEditorClose.addEventListener("click", closeTagEditor);

  // Tag chip remove
  tagChipsRow.addEventListener("click", (e) => {
    const btn = e.target.closest(".tag-chip-remove");
    if (btn) _removeTag(btn.dataset.tag);
  });

  // Tag suggestion chip click → add tag
  tagSuggestionsRow.addEventListener("click", (e) => {
    const chip = e.target.closest(".tag-suggestion-chip");
    if (chip) { _addTag(chip.dataset.tag); tagInput.value = ""; }
  });

  // Suggestion filter as you type
  tagInput.addEventListener("input", () => _renderTagSuggestions(tagInput.value));

  // Enter or + button → add tag
  const _doAddTag = () => {
    if (tagInput.value.trim()) {
      _addTag(tagInput.value);
      tagInput.value = "";
      _renderTagSuggestions("");
    }
  };
  tagInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); _doAddTag(); } });
  if (tagAddBtn) tagAddBtn.addEventListener("click", _doAddTag);

  // Close tag editor when lightbox closes
  lightboxClose.addEventListener("click", closeTagEditor);

  // Load card tags after every search (lazy, non-blocking)
  const _origDisplayResults = displayResults;
  // We hook via a MutationObserver on the results grid instead to avoid modifying displayResults
  const _tagObserver = new MutationObserver(() => {
    if (selectedFolders.length > 0) {
      // Debounce: wait 400ms after last DOM change before loading tags
      clearTimeout(_tagObserver._timer);
      _tagObserver._timer = setTimeout(() => loadCardTagsForFolder(selectedFolders[0]), 400);
    }
  });
  _tagObserver.observe(resultsGrid, { childList: true });

  // Also add Ctrl+K palette entry for tags
  // (COMMANDS array is already defined; we push a new entry)
  COMMANDS.push(
    { icon: "🏷",  title: "Tag Current Image",  desc: "Open the tag editor in lightbox",  shortcut: "", action: () => {
      const item = _allSearchResults[_lbIndex];
      if (item && lightboxOverlay.style.display !== "none") openTagEditor(item.path);
      else showToast("Open an image in lightbox first");
    }}
  );

  /* =================== S10-F1 — SMART SEARCH SUGGESTIONS =================== */

  const searchSuggestions  = document.getElementById("search-suggestions");
  // queryInput already declared at line 95 — reuse existing const

  // Built-in photo concept terms (always shown when no query)
  const BUILTIN_TERMS = [
    "sunset", "beach", "mountains", "forest", "city", "portrait", "food",
    "architecture", "flowers", "animals", "night", "travel", "family",
    "abstract", "black and white", "snow", "rain", "sky",
  ];

  let _suggActiveIdx = -1;
  let _suggItems     = [];

  function _buildSuggestions(q) {
    const items = [];
    const ql = q.toLowerCase();

    // 1. Recent queries from localStorage
    try {
      const recent = JSON.parse(localStorage.getItem("recentQueries") || "[]");
      const matches = recent.filter(r => !ql || r.toLowerCase().includes(ql)).slice(0, 4);
      if (matches.length) {
        items.push({ type: "label", text: "Recent" });
        matches.forEach(r => items.push({ type: "item", icon: "🕐", text: r, badge: "recent" }));
      }
    } catch (_) {}

    // 2. Folder tags (already loaded in _allFolderTags from tag editor)
    const matchingTags = _allFolderTags
      .filter(t => !ql || t.includes(ql))
      .slice(0, 5);
    if (matchingTags.length) {
      items.push({ type: "label", text: "Tags" });
      matchingTags.forEach(t => items.push({ type: "item", icon: "🏷", text: t, badge: "tag" }));
    }

    // 3. Built-in terms
    const matchingBuiltin = BUILTIN_TERMS
      .filter(t => !ql || t.includes(ql))
      .slice(0, 5);
    if (matchingBuiltin.length) {
      items.push({ type: "label", text: "Photo themes" });
      matchingBuiltin.forEach(t => items.push({ type: "item", icon: "🔍", text: t, badge: "" }));
    }

    return items;
  }

  function _renderSuggestions(items) {
    _suggItems = items.filter(i => i.type === "item");
    if (!_suggItems.length) { hideSuggestions(); return; }

    searchSuggestions.innerHTML = items.map((item, idx) => {
      if (item.type === "label") {
        return `<li class="search-suggestion-group-label" role="presentation">${escapeHtml(item.text)}</li>`;
      }
      const dataIdx = _suggItems.indexOf(item);
      return `<li class="search-suggestion-item" data-idx="${dataIdx}" role="option">
        <span class="search-suggestion-icon">${item.icon}</span>
        <span class="search-suggestion-text">${escapeHtml(item.text)}</span>
        ${item.badge ? `<span class="search-suggestion-badge">${item.badge}</span>` : ""}
      </li>`;
    }).join("");

    searchSuggestions.style.display = "block";
    _suggActiveIdx = -1;
  }

  function _highlightSugg(idx) {
    const all = searchSuggestions.querySelectorAll(".search-suggestion-item");
    all.forEach((el, i) => el.classList.toggle("active", i === idx));
    _suggActiveIdx = idx;
  }

  function hideSuggestions() {
    searchSuggestions.style.display = "none";
    _suggActiveIdx = -1;
  }

  function _applySuggestion(text) {
    queryInput.value = text;
    hideSuggestions();
    queryInput.focus();

    // Save to recent
    try {
      let recent = JSON.parse(localStorage.getItem("recentQueries") || "[]");
      recent = [text, ...recent.filter(r => r !== text)].slice(0, 20);
      localStorage.setItem("recentQueries", JSON.stringify(recent));
    } catch (_) {}

    // Trigger a real search immediately on suggestion select
    if (selectedFolders.length > 0 && text.trim().length >= 1) {
      sortSearchMode = "query";
      search({ useQuery: true });
    }
  }

  if (queryInput) {
    queryInput.addEventListener("input", () => {
      // Only update the suggestions dropdown — no backend search
      const q = queryInput.value.trim();
      const items = _buildSuggestions(q);
      _renderSuggestions(items);
    });

    queryInput.addEventListener("focus", () => {
      const q = queryInput.value.trim();
      const items = _buildSuggestions(q);
      _renderSuggestions(items);
    });

    queryInput.addEventListener("keydown", (e) => {
      if (searchSuggestions.style.display === "none") return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        _highlightSugg(Math.min(_suggActiveIdx + 1, _suggItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        _highlightSugg(Math.max(_suggActiveIdx - 1, -1));
      } else if (e.key === "Enter" && _suggActiveIdx >= 0) {
        // A suggestion is highlighted — select it and search
        e.preventDefault();
        e.stopImmediatePropagation(); // prevent the outer Enter-to-search from double-firing
        _applySuggestion(_suggItems[_suggActiveIdx].text);
      } else if (e.key === "Escape") {
        hideSuggestions();
      }
    });

    // Click to apply
    searchSuggestions.addEventListener("click", (e) => {
      const li = e.target.closest(".search-suggestion-item");
      if (!li) return;
      const idx = parseInt(li.dataset.idx, 10);
      if (_suggItems[idx]) _applySuggestion(_suggItems[idx].text);
    });

    // Hide when clicking outside
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#search-input-wrapper")) hideSuggestions();
    });
  }

  // Save recent query every time search runs
  const _origSearchBtn = document.getElementById("search-btn");
  if (_origSearchBtn) {
    _origSearchBtn.addEventListener("click", () => {
      const q = queryInput?.value.trim();
      if (q) {
        try {
          let recent = JSON.parse(localStorage.getItem("recentQueries") || "[]");
          recent = [q, ...recent.filter(r => r !== q)].slice(0, 20);
          localStorage.setItem("recentQueries", JSON.stringify(recent));
        } catch (_) {}
        hideSuggestions();
      }
    }, true); // capture phase so it fires before existing click handler
  }

  /* =================== S10-F2 — IMAGE NOTES =================== */

  const lightboxNoteBtn  = document.getElementById("lightbox-note-btn");
  const noteEditorPanel  = document.getElementById("note-editor-panel");
  const noteEditorClose  = document.getElementById("note-editor-close");
  const noteTextarea     = document.getElementById("note-textarea");
  const noteCharCount    = document.getElementById("note-char-count");
  const noteSaveBtn      = document.getElementById("note-save-btn");

  const NOTE_MAX = 500;
  let _noteCurrentPath   = null;
  let _noteCurrentFolder = null;

  function _updateNoteCharCount() {
    const len = noteTextarea.value.length;
    noteCharCount.textContent = `${len} / ${NOTE_MAX}`;
    noteCharCount.classList.toggle("warn", len > NOTE_MAX * 0.85);
  }

  async function openNoteEditor(imagePath) {
    _noteCurrentPath   = imagePath;
    _noteCurrentFolder = selectedFolders[0] || null;
    if (!_noteCurrentFolder) { showToast("No folder selected"); return; }

    lightboxNoteBtn.classList.add("active");
    noteEditorPanel.style.display = "block";
    noteTextarea.value = "";
    noteCharCount.textContent = `0 / ${NOTE_MAX}`;

    try {
      const note = await invoke("get_image_note", {
        folder: _noteCurrentFolder, path: _noteCurrentPath
      });
      noteTextarea.value = note || "";
    } catch (_) {}
    _updateNoteCharCount();
    noteTextarea.focus();
  }

  function closeNoteEditor() {
    noteEditorPanel.style.display = "none";
    if (lightboxNoteBtn) lightboxNoteBtn.classList.remove("active");
    _noteCurrentPath = null;
  }

  async function _saveNote() {
    if (!_noteCurrentPath || !_noteCurrentFolder) return;
    const note = noteTextarea.value.trim().slice(0, NOTE_MAX);
    try {
      await invoke("set_image_note", {
        folder: _noteCurrentFolder, path: _noteCurrentPath, note
      });
      _setCardNoteDot(_noteCurrentPath, note.length > 0);
      showToast(note.length > 0 ? "📝 Note saved" : "Note cleared");
      closeNoteEditor();
    } catch (err) {
      showToast(`Failed to save note: ${String(err)}`);
    }
  }

  // Add/remove purple dot indicator on grid cards
  function _setCardNoteDot(path, hasNote) {
    const card = document.querySelector(`.card[data-image-path="${CSS.escape(path)}"]`);
    if (!card) return;
    let dot = card.querySelector(".card-note-dot");
    if (hasNote && !dot) {
      dot = document.createElement("div");
      dot.className = "card-note-dot";
      card.appendChild(dot);
    } else if (!hasNote && dot) {
      dot.remove();
    }
  }

  // Load note dots for all visible cards (batched)
  async function loadNoteDotsForFolder(folder) {
    if (!folder) return;
    const cards = Array.from(document.querySelectorAll(".card[data-image-path]"));
    for (let i = 0; i < cards.length; i += 20) {
      await Promise.all(cards.slice(i, i + 20).map(async card => {
        const p = card.dataset.imagePath;
        if (!p) return;
        try {
          const note = await invoke("get_image_note", { folder, path: p });
          _setCardNoteDot(p, note && note.length > 0);
        } catch (_) {}
      }));
    }
  }

  if (lightboxNoteBtn) {
    lightboxNoteBtn.addEventListener("click", () => {
      const item = _allSearchResults[_lbIndex];
      if (!item) return;
      if (noteEditorPanel.style.display !== "none") closeNoteEditor();
      else openNoteEditor(item.path);
    });
  }

  if (noteEditorClose) noteEditorClose.addEventListener("click", closeNoteEditor);
  if (noteSaveBtn)     noteSaveBtn.addEventListener("click", _saveNote);
  if (noteTextarea) {
    noteTextarea.addEventListener("input", _updateNoteCharCount);
    noteTextarea.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); _saveNote(); }
    });
  }

  // Close note editor when lightbox closes
  if (lightboxClose) lightboxClose.addEventListener("click", closeNoteEditor);

  // Piggy-back on the tag MutationObserver to also load note dots
  const _noteObserver = new MutationObserver(() => {
    if (selectedFolders.length > 0) {
      clearTimeout(_noteObserver._timer);
      _noteObserver._timer = setTimeout(() => loadNoteDotsForFolder(selectedFolders[0]), 600);
    }
  });
  _noteObserver.observe(resultsGrid, { childList: true });

  // Command palette entry
  COMMANDS.push({ icon: "📝", title: "Note Current Image", desc: "Add/edit a note for the open image",
    shortcut: "", action: () => {
      const item = _allSearchResults[_lbIndex];
      if (item && lightboxOverlay.style.display !== "none") openNoteEditor(item.path);
      else showToast("Open an image in lightbox first");
  }});

  /* =================== S10-F3 — FOLDER HEALTH DASHBOARD =================== */

  const folderHealthBtn   = document.getElementById("folder-health-btn");
  const folderHealthModal = document.getElementById("folder-health-modal");
  const folderHealthClose = document.getElementById("folder-health-close");
  const folderHealthBody  = document.getElementById("folder-health-body");

  function closeFolderHealth() { folderHealthModal.style.display = "none"; }
  if (folderHealthClose) folderHealthClose.addEventListener("click", closeFolderHealth);
  folderHealthModal.addEventListener("click", (e) => { if (e.target === folderHealthModal) closeFolderHealth(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && folderHealthModal && folderHealthModal.style.display !== "none") closeFolderHealth();
  }, true);

  async function openFolderHealth() {
    folderHealthModal.style.display = "flex";
    folderHealthBody.innerHTML = `<div class="folder-health-loading">Loading…</div>`;

    if (selectedFolders.length === 0) {
      folderHealthBody.innerHTML = `<div class="folder-health-loading">No folders indexed yet.</div>`;
      return;
    }

    // Build cards for each folder in parallel
    const cards = await Promise.all(selectedFolders.map(async folder => {
      const name = folder.split(/[\\/]/).pop() || folder;
      let analytics = null, changes = null;
      try { analytics = await invoke("get_folder_analytics", { folder }); } catch (_) {}
      try { changes   = await invoke("engine_check_changes", { folder }); } catch (_) {}

      // Count tags and notes from tags.json / notes.json (best-effort via all_tags)
      let tagCount = 0;
      try { const tags = await invoke("get_all_tags", { folder }); tagCount = tags.length; } catch (_) {}

      const photoCount   = analytics?.total_images     ?? "–";
      const totalSize    = analytics?.total_size_bytes
        ? (analytics.total_size_bytes / (1024 * 1024)).toFixed(1) + " MB"
        : "–";
      const lastIndexed  = analytics?.oldest_file_date  ?? "–";

      const newCount     = changes?.new_count     || 0;
      const removedCount = changes?.removed_count || 0;
      const hasChanges   = (newCount + removedCount) > 0;

      const badgeClass = hasChanges ? "changes" : "ok";
      const badgeText  = hasChanges
        ? `${newCount > 0 ? "+" + newCount : ""}${removedCount > 0 ? " -" + removedCount : ""} changes`
        : "✓ Up to date";

      return `<div class="fh-card">
        <div>
          <div class="fh-card-name" title="${escapeHtml(folder)}">${escapeHtml(name)}</div>
          <div class="fh-card-path">${escapeHtml(folder)}</div>
        </div>
        <div class="fh-stats-row">
          <div class="fh-stat"><div class="fh-stat-val">${photoCount}</div><div class="fh-stat-lbl">Photos</div></div>
          <div class="fh-stat"><div class="fh-stat-val">${tagCount}</div><div class="fh-stat-lbl">Tags</div></div>
          <div class="fh-stat"><div class="fh-stat-val">${totalSize}</div><div class="fh-stat-lbl">Size</div></div>
        </div>
        <div class="fh-badge ${badgeClass}">${badgeText}</div>
        <div class="fh-card-actions">
          ${hasChanges ? `<button class="fh-action-btn primary" data-reindex="${escapeHtml(folder)}">⟳ Re-index</button>` : ""}
          <button class="fh-action-btn" data-show="${escapeHtml(folder)}">Show Photos</button>
          <button class="fh-action-btn" data-analytics="${escapeHtml(folder)}">📈 Analytics</button>
        </div>
      </div>`;
    }));

    folderHealthBody.innerHTML = cards.join("");

    // Wire action buttons
    folderHealthBody.querySelectorAll("[data-reindex]").forEach(btn => {
      btn.addEventListener("click", () => {
        const folder = btn.dataset.reindex;
        closeFolderHealth();
        // Trigger re-index flow
        if (!indexQueueRunning) {
          indexQueueState.set(folder, { status: "queued" });
          renderIndexQueue();
          runIndexQueue();
        }
        showToast(`Re-indexing ${folder.split(/[\\/]/).pop()}`);
      });
    });

    folderHealthBody.querySelectorAll("[data-show]").forEach(btn => {
      btn.addEventListener("click", () => {
        closeFolderHealth();
        queryInput.value = "";
        document.getElementById("search-btn").click();
      });
    });

    folderHealthBody.querySelectorAll("[data-analytics]").forEach(btn => {
      btn.addEventListener("click", () => {
        closeFolderHealth();
        document.getElementById("analytics-btn").click();
      });
    });
  }

  if (folderHealthBtn) folderHealthBtn.addEventListener("click", openFolderHealth);

  // Command palette entry
  COMMANDS.push({ icon: "🏥", title: "Folder Health Dashboard",
    desc: "View stats for all indexed folders", shortcut: "",
    action: () => openFolderHealth() });

});
