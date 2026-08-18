# Quick Start Guide - New Features

## 🚀 Testing the Newly Implemented Features

### Prerequisites
- App running: `npm run tauri dev` in `ai-photo-ui/` directory
- Python environment activated: `& venv\Scripts\Activate.ps1`
- Folder indexed with images

---

## 1️⃣ Index Cleanup & Compaction

### When to Use
- After deleting many images from a folder
- Performance feels slow
- Want to reclaim disk space

### How to Test
1. Select a folder you've indexed before
2. Delete some image files from the actual folder (on disk)
3. Click **🧹 Cleanup Index** button (top toolbar)
4. Panel appears showing:
   - Current orphaned embeddings count
   - Fragmentation percentage
   - Estimated space to reclaim
5. Click **🚀 Run Cleanup & Compaction**
6. Wait for completion
7. Results show:
   - Files deleted
   - Size freed
   - New fragmentation %

### Expected Results
- ✅ Orphaned .npy files removed
- ✅ FAISS index rebuilt (may be slightly smaller)
- ✅ Query cache cleared
- ✅ Fragmentation reduced

---

## 2️⃣ Duplicate Detection

### When to Use
- Find similar photos from multiple shots
- Identify copies of the same image
- Discover near-exact matches

### How to Test
1. Select a folder with photos (ideally with some similar/duplicate images)
2. Click **🔀 Duplicates** button (top toolbar)
3. Duplicates panel appears with:
   - **Similarity slider** (0.80 - 0.99)
   - **Refresh button** to find duplicates
4. Try different thresholds:
   - **0.99** = Near-perfect duplicates only
   - **0.95** = Very similar images
   - **0.90** = Similar compositions
   - **0.85** = Related scenes

### What You'll See
- Groups of similar images
- Thumbnails numbered (1, 2, 3...)
- Green highlight = Newest image (recommended to keep)
- Image count and similarity stats

### Try This
```
1. Take photos of the same subject multiple times
2. Set threshold to 0.95
3. See all similar shots grouped together
4. The green-numbered image is newest
```

---

## 3️⃣ Collections (Favorites)

### When to Use
- Group photos into themes (Vacation, Family, Pets, etc.)
- Create custom bookmarks
- Organize before export

### How to Test
1. Click **📚 Collections** button (top toolbar)
2. Collections panel appears
3. Enter collection name: "Test Collection"
4. Click **Create** or press Enter
5. Collection appears in list
6. Shows: Name, image count (initially 0), View/Delete buttons

### Example Workflow
```
1. Create "Vacation" collection
2. Create "Family" collection  
3. Create "Nature" collection
4. (Future: Add images to collections)
5. View collections to see organized photos
```

### Collections Features
- ✅ Create unlimited collections
- ✅ Collections stored locally in index
- ✅ One image can be in multiple collections
- ✅ Delete collection (keeps images)

---

## 🧪 Testing Tips

### Test Scenario 1: Fresh Start
1. Index a folder with 100+ photos
2. Run duplicate detection (0.95 threshold)
3. Review groups
4. Delete some originals
5. Run cleanup
6. Create a "Favorites" collection

### Test Scenario 2: Performance Check
```bash
# Open DevTools (F12) Console tab
# After each operation, check:
console.log("Operation complete");

# Note approximate time taken
# Cleanup: should be quick (<1s for 1k images)
# Duplicates: ~1s for 1k images
# Collections: <10ms for any operation
```

### Test Scenario 3: Edge Cases

**Empty Folder:**
- Index folder with no duplicates
- Run duplicate detection → "No duplicates found"

**Very Similar Duplicates:**
- Take identical photos (same subject, same angle)
- Set threshold to 0.95-0.99
- Should group very closely

**Collections Edge Case:**
- Create collection "Test"
- Create collection "test" (different case)
- Both should be allowed (separate collections)

---

## 🐛 Troubleshooting

### Issue: "Cleanup Index button not working"
- [ ] Folder properly indexed? (Check sidebar status)
- [ ] Images in the folder? (At least 1)
- [ ] Try reselecting folder
- [ ] Check console for errors (F12 → Console)

### Issue: "No duplicates found" but there are similar photos
- [ ] Lower similarity threshold (try 0.90)
- [ ] Wait for analysis to complete
- [ ] Check that folder is actually indexed
- [ ] Ensure images are in indexed folder (not subdirectory)

### Issue: Collections button not visible
- [ ] Folder must be selected first
- [ ] Try clicking Select Folder again
- [ ] Refresh page (Ctrl+R)

### Issue: Very slow duplicate detection
- [ ] Large image folder (10k+)? Normal, takes 10-30s
- [ ] Lower threshold = faster (0.85 vs 0.95)
- [ ] Check CPU usage (duplicate detection is CPU-intensive)

---

## 📊 Performance Baseline

### Expected Times (on typical machine)
- **Cleanup** (1k images): ~100-200ms
- **Duplicates** (1k images, threshold 0.95): ~500ms
- **Collections create**: <10ms
- **Collections add image**: <10ms

### If Slower:
- CPU-bound operation (duplicates checks all image pairs)
- Network check: Should be 0 (all local)
- Storage check: If on network drive, expect 2-5x slower

---

## ✅ Verification Checklist

After testing, verify:

### Cleanup Index
- [ ] Button visible in toolbar
- [ ] Panel opens on click
- [ ] Shows current statistics
- [ ] Cleanup runs without hanging
- [ ] Results display correctly
- [ ] No error messages

### Duplicates  
- [ ] Button visible in toolbar
- [ ] Panel opens on click
- [ ] Threshold slider works (0.80-0.99)
- [ ] Refresh button finds duplicates
- [ ] Thumbnails display
- [ ] Newest image highlighted in green
- [ ] Summary stats accurate

### Collections
- [ ] Button visible in toolbar
- [ ] Panel opens on click
- [ ] Can type collection name
- [ ] Create button works
- [ ] New collection appears in list
- [ ] Image count displayed
- [ ] View/Delete buttons present

---

## 🎯 Next Steps to Try

1. **Test all three features in sequence** on one folder
2. **Create collections** for organizations
3. **Find duplicates** before cleanup
4. **Check disk space** before/after cleanup
5. **Try different thresholds** for duplicates
6. **Report any issues** with exact steps to reproduce

---

## 💡 Pro Tips

### For Optimal Results
```
1. Index folder with diverse images (mix of duplicates/unique)
2. Set duplicate threshold to 0.95 for balanced results
3. Create themed collections ("Favorites", "Archive", "Inbox")
4. Run cleanup after bulk deleting images
5. Use collections to organize before export/sharing
```

### For Testing Edge Cases  
```
1. Index folder with 100+ similar photos of same object
2. Index folder with no duplicates (different subjects)
3. Index very large folder (5k+ images)
4. Delete images mid-indexing then run cleanup
5. Create many collections (50+) and verify performance
```

---

## 📝 Feedback Template

When reporting issues, include:

```
Feature: [Cleanup/Duplicates/Collections]
Action: [What you did]
Expected: [What should happen]
Actual: [What actually happened]
Folder Size: [Number of images]
Time Taken: [Seconds]
Error Message: [If any]
Environment: [App version, OS, Python version]
```

---

Happy testing! 🎉

For detailed feature documentation, see: `IMPLEMENTATION_SESSION_SUMMARY.md`
