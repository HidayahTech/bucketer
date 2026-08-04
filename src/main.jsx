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
// Task 7: keeps assembler-worker-url.js in the app's module graph so build.mjs's
// worker-inlining plugin fires and the build invariant can verify it. Task 6 will
// wire makeAssemblerWorker() into the actual zip-in-place call site (App.jsx); this
// reference is a placeholder for that and can be removed once Task 6 lands its own.
import { workerInlined } from './lib/assembler-worker-url.js';
void workerInlined();

// Reflect the saved theme preference on <html> before the first render so there
// is no flash of the wrong theme. 'system' leaves the attribute unset, letting
// the prefers-color-scheme media query (and live OS changes) govern.
applyThemeToRoot(loadThemePref(), document.documentElement);

const downloadUrl = readShareLink();
render(
  downloadUrl ? <DownloadPage presignedUrl={downloadUrl} /> : <App />,
  document.getElementById('app')
);
