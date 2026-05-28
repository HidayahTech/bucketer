export const CURRENT_VERSION = '1.0.0';

export const CHANGELOG = [
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
