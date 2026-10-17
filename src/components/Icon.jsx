// Copyright (C) 2026 HidayahTech, LLC
// Inline SVG icons (look B, v1.65.0) — replace the emoji/Unicode glyphs that rendered
// differently on every OS and let ✕ mean Delete, Cancel and Close at once (REPORT A3).
// 24×24 stroke outlines in the Lucide style, from the BUCKET-1 mockups; where a path matches
// Lucide's (https://lucide.dev), it is used under Lucide's ISC licence: "Copyright (c) for
// portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other
// copyright (c) for Lucide are held by Lucide Contributors 2022."
//
// Icons are decorative (aria-hidden): the control carrying one must have its own accessible
// name (visible text, aria-label, or title).

const PATHS = {
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  check: <path d="M20 6 9 17l-5-5" />,
  'chevron-up': <path d="m18 15-6-6-6 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  sort: <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  monitor: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  folder: (
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
  ),
  'folder-plus': (
    <>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>
  ),
  'file-text': (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </>
  ),
  video: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m10 9 5 3-5 3z" />
    </>
  ),
  archive: (
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5M12 15V3" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8" />
      <path d="M21 3v5h-5M3 21v-5h5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  undo: <path d="M3 7v6h6M3 13a9 9 0 1 0 3-7" />,
  pencil: <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />,
  move: (
    <>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
      <path d="M8 13h7M12 10l3 3-3 3" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  trash: (
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  ),
};

export function Icon({ name, size = 16, class: extraClass }) {
  const shape = PATHS[name];
  if (!shape) return null;
  return (
    <svg
      class={extraClass ? `icon ${extraClass}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {shape}
    </svg>
  );
}

// File-type icon for an object key, from its extension.
const TYPE_BY_EXT = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'heic', 'tif', 'tiff', 'ico'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'],
  archive: ['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'zst'],
  'file-text': ['txt', 'md', 'csv', 'json', 'log', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'xml', 'yaml', 'yml', 'html'],
};
export function fileIconName(key) {
  const ext = (key.split('/').pop().split('.').pop() || '').toLowerCase();
  for (const [name, exts] of Object.entries(TYPE_BY_EXT)) if (exts.includes(ext)) return name;
  return 'file';
}
