// Copyright (C) 2026 HidayahTech, LLC
// Per-row "⋯" menu (layout A, slice 4b): the row keeps one Download button and every other
// action moves here, labelled in words. Rows carried 4–6 unlabelled icon buttons that wrapped
// to 2–3 lines on tablets and phones (REPORT M2/W3). Same disclosure as BucketToolsMenu: a
// button with aria-expanded over plain buttons, closed by Escape (focus returns to ⋯), a click
// outside, or picking an item. On phones the CSS turns the menu into a bottom sheet.
import { Fragment } from 'preact';
import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import { Icon } from './Icon.jsx';

const MENU_ROOM = 300; // px: a five-item menu with its label

// items: [{ label, icon, onSelect, disabled?, title?, danger?, separator? }] — separator: true
// draws a rule above the item (Delete sits apart from the rest, as in the mockup).
export function RowMenu({ name, items, done = false, doneLabel }) {
  const [open, setOpen] = useState(false);
  // Opens upward when the row sits too low for the menu to fit below it (the last rows of a
  // listing put Delete under the fold). Phones ignore this: the menu is a bottom sheet there.
  const [up, setUp] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);

  // Layout effect, not useEffect: Preact defers useEffect until after paint (up to 100 ms
  // when frames are slow), so an Escape pressed right after opening was missed.
  useLayoutEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div class="row-menu-wrap" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        class="btn btn-ghost btn-sm row-menu-btn"
        aria-expanded={open ? 'true' : 'false'}
        aria-label={done && doneLabel ? doneLabel : `More actions for ${name}`}
        title={`More actions for ${name}`}
        data-testid={`row-menu:${name}`}
        onClick={() => {
          if (!open) {
            const r = buttonRef.current.getBoundingClientRect();
            setUp(window.innerHeight - r.bottom < MENU_ROOM && r.top > MENU_ROOM);
          }
          setOpen((v) => !v);
        }}
      >
        <Icon name={done ? 'check' : 'more'} />
      </button>
      {open && (
        <div
          class={`copy-link-popover row-menu${up ? ' copy-link-popover--up' : ''}`}
          role="group"
          aria-label={`Actions for ${name}`}
        >
          <p class="row-menu-label">
            <bdi>{name}</bdi>
          </p>
          {items.map((it) => (
            <Fragment key={it.label}>
              {it.separator && <div class="row-menu-sep" />}
              <button
                type="button"
                class={`btn btn-ghost btn-sm row-menu-item${it.danger ? ' row-menu-danger' : ''}`}
                disabled={it.disabled}
                title={it.title}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                <Icon name={it.icon} /> {it.label}
              </button>
            </Fragment>
          ))}
          {/* Phones only (CSS): the bottom sheet covers the rows, so it says how to leave it. */}
          <button
            type="button"
            class="btn btn-ghost btn-sm row-menu-cancel"
            onClick={() => {
              setOpen(false);
              buttonRef.current?.focus();
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
