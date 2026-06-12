import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../helpers/render.js';
import { DownloadPage } from '../../src/components/DownloadPage.jsx';

// A presigned URL signed at a known time, with a 7-day expiry.
// X-Amz-Date=20260101T000000Z, X-Amz-Expires=604800 (7 days).
// Expiry = 2026-01-08T00:00:00Z, which is always in the past relative to today (2026-06-11).
const EXPIRED_URL = 'https://s3.example.com/my-bucket/path/to/video.braw?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F20260101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260101T000000Z&X-Amz-Expires=604800&X-Amz-Signature=abc123&X-Amz-SignedHeaders=host&x-id=GetObject';

// Expiry far in the future (year 2099).
const FRESH_URL = 'https://s3.example.com/my-bucket/path/to/video.braw?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F20990601%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20990601T000000Z&X-Amz-Expires=604800&X-Amz-Signature=abc123&X-Amz-SignedHeaders=host&x-id=GetObject';

// Image URL — previewable directly from the presigned URL.
const IMAGE_URL = 'https://s3.example.com/my-bucket/photos/sunset.jpg?X-Amz-Date=20990601T000000Z&X-Amz-Expires=604800&X-Amz-Signature=abc123&X-Amz-SignedHeaders=host';

// Video URL — previewable directly from the presigned URL.
const VIDEO_URL = 'https://s3.example.com/my-bucket/clips/demo.mp4?X-Amz-Date=20990601T000000Z&X-Amz-Expires=604800&X-Amz-Signature=abc123&X-Amz-SignedHeaders=host';

describe('DownloadPage', () => {
  test('renders the file name extracted from the URL path', () => {
    const { text } = mount(<DownloadPage presignedUrl={FRESH_URL} />);
    assert.ok(text().includes('video.braw'), `expected file name in output, got: ${text()}`);
  });

  test('renders a link whose href is the presigned URL', () => {
    const { query } = mount(<DownloadPage presignedUrl={FRESH_URL} />);
    const link = query('a[href]');
    assert.ok(link, 'expected an anchor element');
    assert.equal(link.getAttribute('href'), FRESH_URL);
  });

  test('shows expiry information when URL is not yet expired', () => {
    const { text } = mount(<DownloadPage presignedUrl={FRESH_URL} />);
    // Should mention "expires" or a time duration somewhere
    assert.ok(
      text().toLowerCase().includes('expir'),
      `expected expiry information in output, got: ${text()}`
    );
  });

  test('shows expired message when URL has already expired', () => {
    const { text } = mount(<DownloadPage presignedUrl={EXPIRED_URL} />);
    assert.ok(
      text().toLowerCase().includes('expired'),
      `expected "expired" in output for past URL, got: ${text()}`
    );
  });

  test('download link is not shown when URL has expired', () => {
    const { query } = mount(<DownloadPage presignedUrl={EXPIRED_URL} />);
    const link = query('a[href]');
    assert.equal(link, null, 'download link must not be rendered for expired URL');
  });

  test('renders an image preview for image files', () => {
    const { query } = mount(<DownloadPage presignedUrl={IMAGE_URL} />);
    const img = query('img[src]');
    assert.ok(img, 'expected img element for image file');
    assert.equal(img.getAttribute('src'), IMAGE_URL);
  });

  test('renders a video preview for video files', () => {
    const { query } = mount(<DownloadPage presignedUrl={VIDEO_URL} />);
    const video = query('video[src]');
    assert.ok(video, 'expected video element for video file');
    assert.equal(video.getAttribute('src'), VIDEO_URL);
  });

  test('does not render a media preview for non-previewable files', () => {
    const { query } = mount(<DownloadPage presignedUrl={FRESH_URL} />); // .braw — not previewable
    assert.equal(query('img'), null, 'no img for non-previewable file');
    assert.equal(query('video'), null, 'no video for non-previewable file');
    assert.equal(query('audio'), null, 'no audio for non-previewable file');
  });
});
