// Recursively collect { file, relativePath } pairs from FileSystemEntry objects.
// readEntries() returns at most 100 entries per call, so drain each directory reader
// in a loop until it yields an empty batch.
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
