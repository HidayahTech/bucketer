// Copyright (C) 2026 HidayahTech, LLC
// Recursively enumerate files from FileSystemEntry objects (drag-and-drop, folder picker),
// returning flat { file, relativePath } pairs with folder structure preserved.
//
// Critical: the Directory Reader API returns at most 100 entries per readEntries() call.
// The loop below repeats until an empty batch is returned — stopping after the first call
// would silently drop files in folders with more than 100 items.
// Unreadable entries (permission errors, broken symlinks) are skipped without throwing.
export async function collectFileEntries(entries) {
  const result = [];

  async function traverse(entry, pathPrefix) {
    if (entry.isFile) {
      await new Promise(resolve => {
        entry.file(
          file => { result.push({ file, relativePath: pathPrefix + file.name }); resolve(); },
          () => resolve(), // skip unreadable files
        );
      });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const prefix = pathPrefix + entry.name + '/';
      while (true) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const e of batch) await traverse(e, prefix);
      }
    }
  }

  await Promise.all(entries.map(entry => traverse(entry, '')));
  return result;
}

// Resolve a drop's DataTransfer into { file, relativePath } pairs. Prefers the
// FileSystemEntry path (preserves folder structure), but falls back to the flat
// dataTransfer.files list when the entries yield nothing or fail (BUG-041: WebKit
// returns truthy entries for synthetic DataTransfers whose .file() then errors
// NotFoundError — without the fallback such a drop dies silently).
export async function resolveDroppedFiles(dataTransfer) {
  if (!dataTransfer) return [];
  const fsEntries = [];
  const items = dataTransfer.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const entry = item.kind === 'file' && (item.getAsEntry?.() ?? item.webkitGetAsEntry?.());
      if (entry) fsEntries.push(entry);
    }
  }
  // Snapshot the flat list synchronously — a DataTransfer is not reliably readable
  // after an await.
  const flat = dataTransfer.files ? Array.from(dataTransfer.files) : [];
  if (fsEntries.length) {
    const fileEntries = await collectFileEntries(fsEntries).catch(() => []);
    if (fileEntries.length) return fileEntries;
  }
  return flat.map(f => ({ file: f, relativePath: f.name }));
}
