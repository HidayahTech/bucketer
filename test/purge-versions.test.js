import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { purgeAllVersions } from '../src/lib/purge-versions.js';
import { ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';

function makeRow(key, versionId, type = 'old-version') {
  return { key, versionId, type };
}

function makeMockClient({ pages = [], deleteErrors = [] } = {}) {
  let pageIndex = 0;
  const deletedBatches = [];
  return {
    deletedBatches,
    send: async (cmd) => {
      if (cmd instanceof ListObjectVersionsCommand) {
        const page = pages[pageIndex++] ?? { Versions: [], DeleteMarkers: [], IsTruncated: false };
        return page;
      }
      if (cmd instanceof DeleteObjectsCommand) {
        deletedBatches.push(cmd.input.Delete.Objects);
        return { Errors: deleteErrors.splice(0, 1) };
      }
      throw new Error(`Unexpected command: ${cmd.constructor.name}`);
    },
  };
}

describe('purgeAllVersions', () => {
  test('deletes all rows from a single non-truncated page', async () => {
    const initialRows = [makeRow('a.txt', 'v1'), makeRow('b.txt', 'v2')];
    const client = makeMockClient();

    const errors = await purgeAllVersions(client, {
      bucket: 'my-bucket', prefix: '', initialRows,
      nextKeyMarker: null, nextVersionIdMarker: null, isTruncated: false,
    });

    assert.deepEqual(errors, []);
    assert.equal(client.deletedBatches.length, 1);
    assert.deepEqual(client.deletedBatches[0], [
      { Key: 'a.txt', VersionId: 'v1' },
      { Key: 'b.txt', VersionId: 'v2' },
    ]);
  });

  test('fetches remaining pages before deleting when isTruncated', async () => {
    const initialRows = [makeRow('a.txt', 'v1')];
    const client = makeMockClient({
      pages: [
        {
          Versions: [{ Key: 'b.txt', VersionId: 'v2', IsLatest: false, Size: 0, LastModified: new Date() }],
          DeleteMarkers: [],
          IsTruncated: false,
          NextKeyMarker: null, NextVersionIdMarker: null,
        },
      ],
    });

    const errors = await purgeAllVersions(client, {
      bucket: 'my-bucket', prefix: 'docs/', initialRows,
      nextKeyMarker: 'a.txt', nextVersionIdMarker: 'v1', isTruncated: true,
    });

    assert.deepEqual(errors, []);
    assert.equal(client.deletedBatches.length, 1);
    assert.equal(client.deletedBatches[0].length, 2);
    assert.deepEqual(client.deletedBatches[0].map(o => o.Key).sort(), ['a.txt', 'b.txt']);
  });

  test('batches in chunks of 1000', async () => {
    const initialRows = Array.from({ length: 1500 }, (_, i) => makeRow(`file${i}.txt`, `v${i}`));
    const client = makeMockClient();

    const errors = await purgeAllVersions(client, {
      bucket: 'b', prefix: '', initialRows,
      nextKeyMarker: null, nextVersionIdMarker: null, isTruncated: false,
    });

    assert.deepEqual(errors, []);
    assert.equal(client.deletedBatches.length, 2);
    assert.equal(client.deletedBatches[0].length, 1000);
    assert.equal(client.deletedBatches[1].length, 500);
  });

  test('returns errors from DeleteObjects API without throwing', async () => {
    const initialRows = [makeRow('bad.txt', 'v1')];
    const client = makeMockClient({ deleteErrors: [{ Key: 'bad.txt', Message: 'AccessDenied' }] });

    const errors = await purgeAllVersions(client, {
      bucket: 'b', prefix: '', initialRows,
      nextKeyMarker: null, nextVersionIdMarker: null, isTruncated: false,
    });

    assert.equal(errors.length, 1);
    assert.equal(errors[0].Key, 'bad.txt');
  });

  test('handles network error on a batch and continues as an accumulated error', async () => {
    const initialRows = Array.from({ length: 3 }, (_, i) => makeRow(`f${i}.txt`, `v${i}`));
    const failingClient = {
      deletedBatches: [],
      send: async (cmd) => {
        if (cmd instanceof ListObjectVersionsCommand) return { Versions: [], DeleteMarkers: [], IsTruncated: false };
        if (cmd instanceof DeleteObjectsCommand) throw new Error('Network timeout');
      },
    };

    const errors = await purgeAllVersions(failingClient, {
      bucket: 'b', prefix: '', initialRows,
      nextKeyMarker: null, nextVersionIdMarker: null, isTruncated: false,
    });

    assert.equal(errors.length, 1);
    assert.ok(errors[0].Message.includes('Network timeout'));
  });

  test('returns empty errors array when there are no rows to delete', async () => {
    const client = makeMockClient();
    const errors = await purgeAllVersions(client, {
      bucket: 'b', prefix: '', initialRows: [],
      nextKeyMarker: null, nextVersionIdMarker: null, isTruncated: false,
    });
    assert.deepEqual(errors, []);
    assert.equal(client.deletedBatches.length, 0);
  });
});
