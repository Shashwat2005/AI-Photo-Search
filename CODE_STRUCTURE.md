# Code Structure Documentation - New Features

## File-by-File Changes

### 1. `folder_indexing.py` - Backend Logic

**New Functions Added (~350 lines):**

#### Index Maintenance
```python
get_index_stats(folder_path) -> dict
  Returns: {
    "total_indexed_images": int,
    "total_embeddings": int,
    "orphaned_embeddings": int,
    "orphaned_size_mb": float,
    "fragmentation_percent": float
  }

cleanup_orphaned_embeddings(folder_path) -> dict
  Returns: {
    "deleted": int,
    "total": int,
    "size_freed_mb": float
  }

compact_index(folder_path) -> dict
  Returns: {
    "compacted": bool,
    "before_size_mb": float,
    "after_size_mb": float,
    "space_saved_mb": float,
    "entries_before": int,
    "entries_after": int
  }

cleanup_index(folder_path) -> dict
  Orchestrates: cleanup_orphaned_embeddings + compact_index + get_index_stats
```

#### Duplicate Detection
```python
detect_duplicates(folder_path, similarity_threshold=0.95) -> dict
  Algorithm: Cosine similarity matrix on normalized embeddings
  Returns: {
    "status": "ok",
    "total_images": int,
    "groups": [[path1, path2, ...], ...],
    "group_count": int,
    "duplicate_count": int,
    "threshold": float
  }

get_duplicate_clusters(folder_path, similarity_threshold) -> dict
  Wrapper with error handling
```

#### Collections (Favorites)
```python
_get_collections_file(index_dir) -> Path
  Returns: indexes/{hash}/collections.json

get_collections(folder_path) -> dict
  Returns: {"collections": [...], "image_collections": {...}}

create_collection(folder_path, collection_name) -> dict
  Returns: {"id": str, "name": str, "created_at": float, "image_count": 0}

delete_collection(folder_path, collection_id) -> dict

add_to_collection(folder_path, collection_id, image_path) -> dict

remove_from_collection(folder_path, collection_id, image_path) -> dict

get_collection_images(folder_path, collection_id) -> dict
  Returns: {"collection_id": str, "images": [...], "count": int}
```

**Key Implementation Details:**
- Cleanup: Uses existing `_INDEX_CACHE_LOCK` for thread safety
- Duplicates: Leverages existing FAISS inference pipeline
- Collections: Stores in separate JSON file, independent of index
- All functions work offline with zero external dependencies

---

### 2. `engine.py` - CLI Commands

**New Commands Added (~100 lines):**

```
$ python engine.py stats <folder>
  Call: get_index_stats(folder)
  Returns: JSON with stats

$ python engine.py cleanup <folder>
  Call: cleanup_index(folder)
  Returns: JSON with cleanup results

$ python engine.py duplicates <folder> [threshold]
  Call: get_duplicate_clusters(folder, threshold)
  Returns: JSON with duplicate groups (+ thumbnails)

$ python engine.py collections <folder>
  Call: get_collections(folder)
  Returns: JSON with all collections

$ python engine.py create-collection <folder> <name>
  Call: create_collection(folder, name)
  Returns: JSON with new collection

$ python engine.py delete-collection <folder> <id>
  Call: delete_collection(folder, id)
  Returns: JSON status

$ python engine.py add-to-collection <folder> <id> <path>
  Call: add_to_collection(folder, id, path)
  Returns: JSON status

$ python engine.py remove-from-collection <folder> <id> <path>
  Call: remove_from_collection(folder, id, path)
  Returns: JSON status

$ python engine.py collection-images <folder> <id>
  Call: get_collection_images(folder, id)
  Returns: JSON with images in collection
```

**Command Routing:**
- All commands handle Path() resolution and normalization
- Duplicate detection adds thumbnail paths to response
- Collections attach thumbnail paths to image lists
- Error handling: Returns structured error JSON with message

---

### 3. `ai-photo-ui/src-tauri/src/lib.rs` - Tauri Bridge

**New Commands Added (~250 lines):**

```rust
#[tauri::command]
fn engine_stats(folder: String) -> Result<Value, String>
  Executes: engine.py stats <folder>

#[tauri::command]
fn engine_cleanup(folder: String) -> Result<Value, String>
  Executes: engine.py cleanup <folder>

#[tauri::command]
fn engine_duplicates(folder: String, threshold: Option<f32>) -> Result<Value, String>
  Executes: engine.py duplicates <folder> [threshold]

#[tauri::command]
fn engine_collections(folder: String) -> Result<Value, String>
  Executes: engine.py collections <folder>

#[tauri::command]
fn engine_create_collection(folder: String, name: String) -> Result<Value, String>
  Executes: engine.py create-collection <folder> <name>

#[tauri::command]
fn engine_add_to_collection(
  folder: String,
  collection_id: String,
  image_path: String
) -> Result<Value, String>
  Executes: engine.py add-to-collection <folder> <id> <path>
```

**Handler Registration:**
- All commands added to `generate_handler![]` macro
- Python execution: Finds Python binary from venv/system
- JSON parsing: Response parsed and passed to frontend
- Error handling: Stdout/stderr captured and formatted

---

### 4. `ai-photo-ui/index.html` - UI Structure

**New HTML Sections:**

#### Cleanup Panel (24 lines)
```html
<div id="cleanup-panel" class="cleanup-panel">
  <div class="cleanup-header">
    <h3>🧹 Index Cleanup & Compaction</h3>
  </div>
  <div id="cleanup-content">
    <!-- Stats display -->
    <!-- Run button -->
    <!-- Results display -->
  </div>
</div>
```

#### Duplicates Panel (23 lines)
```html
<div id="duplicates-panel" class="duplicates-panel">
  <div class="duplicates-header">
    <h3>🔀 Duplicate Images</h3>
    <input id="duplicate-threshold" type="range" ... />
    <button id="refresh-duplicates-btn" ...>
  </div>
  <div id="duplicates-content">
    <!-- Summary stats -->
    <!-- Duplicate groups with thumbnails -->
  </div>
</div>
```

#### Collections Panel (17 lines)
```html
<div id="collections-panel" class="collections-panel">
  <div class="collections-header">
    <h3>📚 Collections</h3>
    <input id="new-collection-input" ... />
    <button id="create-collection-btn" ...>
  </div>
  <div id="collections-content">
    <!-- Collection list -->
  </div>
</div>
```

#### Toolbar Buttons (4 new)
```html
<button id="cleanup-index-btn">🧹 Cleanup Index</button>
<button id="duplicates-btn">🔀 Duplicates</button>
<button id="collections-btn">📚 Collections</button>
```

---

### 5. `ai-photo-ui/src/style.css` - Styling

**New CSS Sections (~350 lines):**

#### Cleanup Panel Styles
- `.cleanup-panel` - Fixed right-side panel with sliding animation
- `.cleanup-stats` - Stats display formatting
- `.cleanup-action-btn` - Green action buttons
- `.cleanup-result` - Results display with monospace font

#### Duplicates Panel Styles
- `.duplicates-panel` - Fixed right-side panel
- `.duplicates-header` - Header with threshold control
- `.duplicate-group` - Group container with border
- `.duplicate-item` - Individual image thumbnails
- `.duplicate-item.newest` - Green highlight for newest
- `.duplicates-summary` - Summary stats section

#### Collections Panel Styles
- `.collections-panel` - Fixed right-side panel
- `.collection-item` - Collection card layout
- `.collection-item-actions` - View/Delete buttons
- `.collections-controls` - Input and create button
- `.empty-collections` - Empty state message

#### Shared Styles
- `@keyframes slideIn` - Panel entrance animation
- `.close-btn` - Dismiss button styling
- Responsive design with `max-width: 90%`

---

### 6. `ai-photo-ui/src/main.js` - Frontend Logic

**New Functions Added (~450 lines):**

#### Cleanup Panel Functions
```javascript
async showCleanupPanel()
  Loads stats, displays panel, shows current state

async runCleanup()
  Executes cleanup, displays results, refreshes stats

async showCleanupPanel() [reused for refresh]
```

#### Duplicates Panel Functions
```javascript
async showDuplicatesPanel()
  Validates folder selection, triggers loadDuplicates

async loadDuplicates()
  Fetches duplicates from backend
  Renders groups with threshold stat
  Shows empty state if no duplicates

// Threshold UI
duplicateThresholdInput.addEventListener("input", ...)
  Updates display value on slider change
```

#### Collections Panel Functions
```javascript
async showCollectionsPanel()
  Loads collections data

async loadCollections()
  Fetches all collections
  Renders collection list with counts
  Shows empty state if no collections

async createNewCollection()
  Validates input
  Creates new collection via backend
  Refreshes display
  Shows toast notification

function viewCollection(id)
  Placeholder for collection viewer

function deleteCollection(id)
  Shows confirmation dialog
  Calls backend (placeholder)

function closeCollectionsPanel()
  Hides panel
```

#### Event Listeners
```javascript
// Cleanup
cleanupIndexBtn.click → showCleanupPanel()
cleanupRunBtn.click → runCleanup()

// Duplicates
duplicatesBtn.click → showDuplicatesPanel()
refreshDuplicatesBtn.click → loadDuplicates()
duplicateThresholdInput.input → Update display value

// Collections
collectionsBtn.click → showCollectionsPanel()
createCollectionBtn.click → createNewCollection()
newCollectionInput.keypress (Enter) → createNewCollection()
```

---

## Data Flow Diagrams

### Cleanup Operation
```
Frontend (showCleanupPanel)
  ↓ invoke("engine_stats")
Tauri (engine_stats)
  ↓ execute: engine.py stats <folder>
Backend (get_index_stats)
  ↓ Analyze index, count orphans
Engine (returns JSON)
  ↑ Tauri (parse JSON)
Frontend (display stats)
  ↓ User clicks cleanup
Frontend (runCleanup)
  ↓ invoke("engine_cleanup")
Tauri (engine_cleanup)
  ↓ execute: engine.py cleanup <folder>
Backend (cleanup_index)
  ├→ cleanup_orphaned_embeddings
  ├→ compact_index
  └→ get_index_stats
Engine (returns JSON)
  ↑ Tauri (parse JSON)
Frontend (display results)
```

### Duplicate Detection
```
Frontend (showDuplicatesPanel)
  ↓ User adjusts threshold slider
Frontend (loadDuplicates)
  ↓ invoke("engine_duplicates", threshold)
Tauri (engine_duplicates)
  ↓ execute: engine.py duplicates <folder> <threshold>
Backend (get_duplicate_clusters)
  ↓ detect_duplicates
    ├→ Load embeddings from .npy files
    ├→ Compute cosine similarity matrix
    └→ Group by threshold
  ↑ Add thumbnail paths
Engine (returns JSON with groups)
  ↑ Tauri (parse JSON)
Frontend (render duplicate groups)
  └→ Show thumbnails, newest highlighted
```

### Collections Management
```
Frontend (showCollectionsPanel)
  ↓ invoke("engine_collections")
Tauri (engine_collections)
  ↓ execute: engine.py collections <folder>
Backend (get_collections)
  ↓ Load collections.json
Engine (returns JSON)
  ↑ Tauri
Frontend (display collection list)

User creates collection:
  ↓ invoke("engine_create_collection", name)
Tauri (engine_create_collection)
  ↓ execute: engine.py create-collection <folder> <name>
Backend (create_collection)
  ├→ Generate collection ID
  ├→ Add to collections array
  └→ Save to collections.json
Engine (returns new collection)
  ↑ Tauri
Frontend (refresh list, show toast)
```

---

## Integration Points

### With Existing Systems
- **Index Manager**: Uses existing `get_index_dir()`, `_image_key()`
- **FAISS Index**: Leverages loaded index for similarity computation
- **Manifest System**: Reads/writes manifest.json for tracking
- **Thumbnail Service**: Uses `ASSETS_ROOT` for thumbnail paths
- **Tauri Bridge**: Follows existing command/response pattern
- **UI Framework**: Uses existing panel pattern with animations

### No Breaking Changes
- All new functions are additive
- No modifications to existing APIs
- Backward compatible with old indexes
- Collections file optional (if not present, empty state)

---

## Testing Entry Points

### Unit Test Examples
```python
# Test cleanup
stats = get_index_stats(test_folder)
assert stats["total_embeddings"] > 0
cleanup_result = cleanup_index(test_folder)
assert cleanup_result["compaction"]["compacted"] == True

# Test duplicates
duplicates = detect_duplicates(test_folder, 0.95)
assert isinstance(duplicates["groups"], list)
for group in duplicates["groups"]:
    assert len(group) > 1

# Test collections
coll = create_collection(test_folder, "Test")
assert coll["name"] == "Test"
add_to_collection(test_folder, coll["id"], "/path/to/image.jpg")
images = get_collection_images(test_folder, coll["id"])
assert len(images["images"]) == 1
```

### Integration Test Examples
```javascript
// Frontend integration
await invoke("engine_stats", { folder: testFolder })
  .then(data => assert(data.total_images > 0))

await invoke("engine_duplicates", { folder: testFolder, threshold: 0.95 })
  .then(data => assert(Array.isArray(data.groups)))

await invoke("engine_collections", { folder: testFolder })
  .then(data => assert(Array.isArray(data.collections)))
```

---

## Performance Optimization Notes

### Potential Future Improvements

1. **Duplicate Detection Caching**
   - Cache similarity matrix for repeated threshold queries
   - Invalidate on index rebuild

2. **Incremental Cleanup**
   - Batch orphan deletion in smaller chunks
   - Show progress bar for large cleanups

3. **Collection Indexing**
   - Build image → collections index for O(1) lookups
   - Pre-compute collection stats

4. **Lazy Loading**
   - Load thumbnails on-demand in duplicate groups
   - Stream collections instead of loading all at once

---

## Error Handling Strategy

### Backend Errors
- All functions wrap with try/except
- Return structured error JSON with message
- Engine.py catches and formats for CLI

### Frontend Errors
- Tauri command results checked for Err variant
- Alert or toast shown to user
- Console logged for debugging
- Graceful fallback (empty state shown)

### User-Facing Error Messages
- "Folder not indexed yet" - Run index first
- "Python not found" - Check environment
- "Collection already exists" - Pick different name
- "Invalid folder path" - Select valid folder

---

## Security Considerations

### Input Validation
- Folder paths validated and resolved
- Collection names checked for empty/null
- File paths normalized before operations
- No path traversal possible (restrictions at get_index_dir level)

### Data Privacy
- All operations local (no external calls)
- Collections file format: Plain JSON (readable)
- User controls all cleanup/delete operations
- No telemetry or analytics

### Access Control
- All data scoped to selected folder index
- Collections can't access other folders
- No elevated permissions required

---

This documentation should help future developers understand the implementation structure and extend these features as needed.
