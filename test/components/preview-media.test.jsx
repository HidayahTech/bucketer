import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../helpers/render.js';
import { PreviewMedia } from '../../src/components/PreviewMedia.jsx';

const URL = 'https://s3.example.com/bucket/file?sig=abc';

describe('PreviewMedia — image', () => {
  test('renders img with correct src', () => {
    const { query } = mount(<PreviewMedia kind="image" url={URL} alt="photo.jpg" />);
    const img = query('img');
    assert.ok(img, 'expected img element');
    assert.equal(img.getAttribute('src'), URL);
  });

  test('sets alt attribute on img', () => {
    const { query } = mount(<PreviewMedia kind="image" url={URL} alt="my-photo.jpg" />);
    assert.equal(query('img').getAttribute('alt'), 'my-photo.jpg');
  });

  test('applies pixelated class when pixelated=true', () => {
    const { query } = mount(<PreviewMedia kind="image" url={URL} alt="px" pixelated={true} />);
    assert.ok(query('img').className.includes('pixelated'), 'img must have pixelated class');
  });

  test('does not apply pixelated class when pixelated=false', () => {
    const { query } = mount(<PreviewMedia kind="image" url={URL} alt="px" pixelated={false} />);
    assert.ok(!query('img').className.includes('pixelated'), 'img must not have pixelated class');
  });
});

describe('PreviewMedia — audio', () => {
  test('renders audio element with src and controls', () => {
    const { query } = mount(<PreviewMedia kind="audio" url={URL} />);
    const audio = query('audio');
    assert.ok(audio, 'expected audio element');
    assert.equal(audio.getAttribute('src'), URL);
    assert.ok(audio.hasAttribute('controls'));
  });
});

describe('PreviewMedia — video', () => {
  test('renders video element with src and controls', () => {
    const { query } = mount(<PreviewMedia kind="video" url={URL} />);
    const video = query('video');
    assert.ok(video, 'expected video element');
    assert.equal(video.getAttribute('src'), URL);
    assert.ok(video.hasAttribute('controls'));
  });
});

// PDF renders an <iframe sandbox=""> — jsdom cannot render iframes without a stack overflow,
// so that kind is exercised via manual/build testing rather than a unit test.

describe('PreviewMedia — text', () => {
  test('renders pre element containing the text', () => {
    const { query, text } = mount(<PreviewMedia kind="text" text="hello world" />);
    assert.ok(query('pre'), 'expected pre element');
    assert.ok(text().includes('hello world'));
  });

  test('shows truncation notice when truncated=true', () => {
    const { text } = mount(<PreviewMedia kind="text" text="content" truncated={true} />);
    assert.ok(text().includes('100 KB'), `expected truncation notice, got: ${text()}`);
  });

  test('does not show truncation notice when truncated=false', () => {
    const { text } = mount(<PreviewMedia kind="text" text="content" truncated={false} />);
    assert.ok(!text().includes('100 KB'), 'must not show truncation notice');
  });
});
