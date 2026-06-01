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

  for (const entry of entries) await traverse(entry, '');
  return result;
}
