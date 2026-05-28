export const CURRENT_VERSION = '1.7.0';

export const CHANGELOG = [
  {
    version: '1.7.0',
    date: '2026-05-28',
    title: 'Dark mode',
    changes: [
      'Full dark mode via prefers-color-scheme: dark — no manual toggle needed',
      'All UI surfaces, modals, tables, and status indicators adapt automatically to the system theme',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-05-28',
    title: 'Drag-and-drop upload onto file table',
    changes: [
      'Files and folders can now be dropped directly onto the file browser to queue them for upload',
      'Visual drop target overlay appears while dragging over the browser area',
      'Folder drops preserve directory structure (same as the upload queue\'s folder picker)',
      'Dropped files are queued into the existing upload queue targeting the current folder',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-05-28',
    title: 'File properties panel',
    changes: [
      'Properties button (ℹ) on each file row opens a panel showing HeadObject metadata',
      'Displays Content-Type, file size, last modified date, ETag, storage class, version ID, and any custom x-amz-meta-* headers',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-05-28',
    title: 'Rename files',
    changes: [
      'Rename button (✎) on each file row activates an inline edit field',
      'Confirm with Enter or the ✓ button; cancel with Escape or ✕',
      'Validates that the new name is non-empty, contains no slashes, and is not already taken',
      'Implemented as a server-side copy + delete to preserve all object metadata',
    ],
  },
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
