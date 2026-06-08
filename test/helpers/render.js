// Shared render helper for component tests.
//
// WHY THIS EXISTS: every component test file needs the same mount/cleanup
// pattern. Centralising it prevents drift (one file using render(null) to
// unmount, another using remove() without unmounting, etc.) and makes the
// contract explicit: always call cleanup() at the end of every test.
//
// USAGE:
//   import { mount } from '../helpers/render.js';
//   // (with-dom.js must already be imported before this file)
//
// mount(vnode) → { text, html, query, queryAll, container, cleanup }
//   text()        — full textContent of the render root
//   html()        — innerHTML of the render root
//   query(sel)    — container.querySelector(sel)
//   queryAll(sel) — [...container.querySelectorAll(sel)]
//   container     — the raw DOM node (for direct manipulation)
//   cleanup()     — unmount Preact tree and remove container from document
//
// fire(element, eventName, init?) — dispatch a DOM event and flush Preact state
//   Wraps the dispatch in act() so Preact's scheduler runs synchronously.
//
// setInput(input, value) — set an input's value and fire the 'input' event.
//   Simulates a user typing into a controlled Preact text field.

import { render } from 'preact';
import { act } from 'preact/test-utils';

export function mount(vnode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(vnode, container));
  return {
    text:      ()    => container.textContent,
    html:      ()    => container.innerHTML,
    query:     (sel) => container.querySelector(sel),
    queryAll:  (sel) => [...container.querySelectorAll(sel)],
    container,
    cleanup:   ()    => { act(() => render(null, container)); container.remove(); },
  };
}

// Dispatch a real DOM event and flush Preact's state synchronously.
// Use this for click, input, change, keydown, etc.
export function fire(element, eventName, init = {}) {
  const Ctor = eventName === 'click'   ? MouseEvent
             : eventName === 'keydown' || eventName === 'keyup' ? KeyboardEvent
             : Event;
  act(() => element.dispatchEvent(new Ctor(eventName, { bubbles: true, cancelable: true, ...init })));
}

// Simulate a user typing into a controlled Preact input field.
// Sets the value property (Preact reads this in its onInput handler) then fires
// the 'input' event so Preact's synthetic handler updates component state.
export function setInput(element, value) {
  element.value = value;
  fire(element, 'input');
}
