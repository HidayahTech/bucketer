// Sets up a jsdom browser environment for component tests.
//
// WHY THIS EXISTS: Preact components reference browser globals (document, window,
// navigator, etc.) at render time. This file creates a full jsdom environment and
// installs those globals before any component code runs.
//
// USAGE: import this as the FIRST import in every component test file.
//   import '../helpers/with-dom.js';   // ← must be first — sets globals before Preact loads
//   import { h, render } from 'preact';
//   import { MyComponent } from '../../src/components/MyComponent.jsx';
//
// WHY IMPORT ORDER MATTERS: ES module imports are evaluated in the order they appear.
// 'with-dom.js' must run before Preact so that global.document is set when Preact
// accesses it at render time. Placing this import anywhere other than first breaks
// component tests that check window.location or use the DOM on module init.

import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
  {
    url: 'http://localhost:3000',
    pretendToBeVisual: true, // enables requestAnimationFrame (used by Preact's scheduler)
  },
);

const { window } = dom;

// Some globals are getter-only on Node 20+ (e.g. navigator, location, performance).
// Object.defineProperty works uniformly across all Node versions.
function def(name, value) {
  Object.defineProperty(global, name, { value, writable: true, configurable: true });
}

// Core DOM globals
def('window',   window);
def('document', window.document);
def('navigator', window.navigator);
def('location', window.location);
def('history',  window.history);

// Event constructors (Preact and components dispatch/listen for these)
def('Event',        window.Event);
def('MouseEvent',   window.MouseEvent);
def('KeyboardEvent',window.KeyboardEvent);
def('CustomEvent',  window.CustomEvent);
def('InputEvent',   window.InputEvent);

// Preact's async scheduler uses MutationObserver when available
def('MutationObserver', window.MutationObserver);

// Animation frame (components use this for progress interpolation)
def('requestAnimationFrame', window.requestAnimationFrame ?? ((cb) => setTimeout(cb, 16)));
def('cancelAnimationFrame',  window.cancelAnimationFrame  ?? clearTimeout);

// Timing and rendering
def('performance',      window.performance);
def('getComputedStyle', window.getComputedStyle);

// DOM node constructors (instanceof checks in Preact internals)
def('HTMLElement', window.HTMLElement);
def('Element',     window.Element);
def('Node',        window.Node);
def('NodeList',    window.NodeList);
def('Text',        window.Text);

// Storage (components read from localStorage on mount)
def('localStorage',   window.localStorage);
def('sessionStorage', window.sessionStorage);

// Web Crypto (used by computeFileHash in file-identity.js)
def('crypto', window.crypto);

// Notification API (used by UploadQueue — stub if jsdom does not provide it)
def('Notification', window.Notification ?? class Notification {
  static permission = 'default';
  constructor() {}
});
