// Copyright (C) 2026 HidayahTech, LLC
// Tests for src/lib/zip-job.js's selectZipEngine — worker-scope caps (createSyncAccessHandle)
// can't be feature-detected on the main thread, so selection is tested at the level of the
// pure helper rather than by exercising runZipJob's actual engine dispatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectZipEngine } from '../src/lib/zip-job.js';

test('selectZipEngine returns in-place only when caps support it AND a worker factory is given', () => {
  assert.equal(selectZipEngine({ opfs:1, streamingFetch:1, webWorker:1 }, () => ({})), 'inplace');
  assert.equal(selectZipEngine({ opfs:1, streamingFetch:1, webWorker:0 }, () => ({})), 'serial');
  assert.equal(selectZipEngine({ opfs:1, streamingFetch:1, webWorker:1 }, null), 'serial');
});
