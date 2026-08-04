// Copyright (C) 2026 HidayahTech, LLC
// Entry point — mounts App into the #app div injected by build.mjs.
// Startup routing: if the URL fragment contains a #dl= presigned URL blob, render
// the standalone DownloadPage; otherwise render the full App session state machine.
import { render } from 'preact';
import { App } from './components/App.jsx';
import { DownloadPage } from './components/DownloadPage.jsx';
import { readShareLink } from './lib/share-url.js';
import { loadThemePref } from './lib/storage.js';
import { applyThemeToRoot } from './lib/theme.js';

// Reflect the saved theme preference on <html> before the first render so there
// is no flash of the wrong theme. 'system' leaves the attribute unset, letting
// the prefers-color-scheme media query (and live OS changes) govern.
applyThemeToRoot(loadThemePref(), document.documentElement);

const downloadUrl = readShareLink();
render(
  downloadUrl ? <DownloadPage presignedUrl={downloadUrl} /> : <App />,
  document.getElementById('app')
);
