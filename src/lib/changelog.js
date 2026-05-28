export const CURRENT_VERSION = '1.3.0';

export const CHANGELOG = [
  {
    version: '1.3.0',
    date: '2026-05-28',
    title: 'Multi-select and batch operations',
    changes: [
      'Checkboxes on file rows and a select-all header checkbox for bulk selection',
      'Batch delete: confirm and delete all selected files in one operation',
      'Batch copy links: generate presigned URLs for all selected files (one per line) with the same duration picker as single-file copy',
      'Selection is cleared automatically on folder navigation',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-05-28',
    title: 'Create folder',
    changes: [
      'New folder button in the browser toolbar creates a folder at the current prefix',
      'Validates the name (no slashes, no duplicates) before creating',
      'Folder appears immediately in the listing without a full reload',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-05-28',
    title: 'Filter / search',
    changes: [
      'Filter bar above the file table to search files and folders by name in real time',
      'Shows a match count (X of Y) when a filter is active',
      'Filter resets automatically when navigating into a different folder',
      'Preview navigation respects the active filter so arrow keys stay within results',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-05-28',
    title: 'Initial release',
    changes: [
      'Object browser with folder navigation, sorting by name/size/date, and paginated listing',
      'File preview for images, audio, video, PDF, and plain text',
      'File upload with queue management, per-file progress, and editable destination folder',
      'Download files via presigned S3 URLs',
      'Copy shareable link with configurable expiry (1 hr / 24 hr / 7 days / custom)',
      'Delete individual files and folders with progress reporting',
      'Support for AWS S3, Backblaze B2, Cloudflare R2, and other S3-compatible providers',
      'Credentials stored locally in browser — never sent to any server',
      'Permission capability detection for list, download, upload, and delete operations',
    ],
  },
];
