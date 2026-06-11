// Copyright (C) 2026 HidayahTech, LLC
// Entry point — mounts App into the #app div injected by build.mjs.
// Startup routing: if the URL fragment contains a #dl= presigned URL blob, render
// the standalone DownloadPage; otherwise render the full App session state machine.
import { render } from 'preact';
import { App } from './components/App.jsx';
import { DownloadPage } from './components/DownloadPage.jsx';
import { readShareLink } from './lib/share-url.js';

const downloadUrl = readShareLink();
render(
  downloadUrl ? <DownloadPage presignedUrl={downloadUrl} /> : <App />,
  document.getElementById('app')
);
