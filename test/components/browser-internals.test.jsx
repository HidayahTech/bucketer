// Tests for Browser.jsx internal sub-components: CopyLinkPopover, Breadcrumb, SortTh.
// Testing these directly (rather than through the full Browser mount) avoids needing
// a real S3 client. Each sub-component is a focused rendering unit — props in, DOM out.
import '../helpers/with-dom.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h } from 'preact';
import { mount, fire, setInput } from '../helpers/render.js';
import { CopyLinkPopover } from '../../src/components/CopyLinkPopover.jsx';
import { Breadcrumb } from '../../src/components/Breadcrumb.jsx';
import { SortTh } from '../../src/components/SortTh.jsx';

// ─── Breadcrumb ───────────────────────────────────────────────────────────────

describe('Breadcrumb — root prefix', () => {
  test('shows "(root)" text when prefix is empty', () => {
    const { text, cleanup } = mount(h(Breadcrumb, { prefix: '', onNavigate: () => {} }));
    assert.ok(text().includes('root'), '"root" must appear in the breadcrumb for empty prefix');
    cleanup();
  });

  test('renders a breadcrumb container', () => {
    const { query, cleanup } = mount(h(Breadcrumb, { prefix: '', onNavigate: () => {} }));
    assert.ok(query('.breadcrumb'), '.breadcrumb element must be present');
    cleanup();
  });
});

describe('Breadcrumb — nested prefix', () => {
  test('shows the "root" home link', () => {
    const { query, cleanup } = mount(h(Breadcrumb, { prefix: 'photos/', onNavigate: () => {} }));
    const crumbs = query('.breadcrumb');
    assert.ok(crumbs.textContent.includes('root'), '"root" link must appear in breadcrumb');
    cleanup();
  });

  test('clicking "root" navigates to empty prefix', () => {
    let navigatedTo = null;
    const { query, cleanup } = mount(h(Breadcrumb, { prefix: 'photos/2024/', onNavigate: p => { navigatedTo = p; } }));
    fire(query('.crumb'), 'click');
    assert.equal(navigatedTo, '', 'clicking root crumb must navigate to empty prefix');
    cleanup();
  });

  test('shows intermediate path segments as clickable crumbs', () => {
    const { queryAll, cleanup } = mount(h(Breadcrumb, { prefix: 'photos/2024/', onNavigate: () => {} }));
    const crumbs = queryAll('.crumb');
    // 'root' + 'photos' are clickable; '2024' is current (not clickable)
    assert.ok(crumbs.length >= 2, 'at least 2 clickable crumb elements for nested prefix');
    cleanup();
  });

  test('last segment is rendered as .current (not a .crumb)', () => {
    const { query, cleanup } = mount(h(Breadcrumb, { prefix: 'photos/2024/', onNavigate: () => {} }));
    const current = query('.current');
    assert.ok(current, '.current element must exist for the last path segment');
    assert.ok(current.textContent.includes('2024'), 'last segment must be "2024"');
    cleanup();
  });

  test('clicking an intermediate segment navigates to its prefix', () => {
    let navigatedTo = null;
    const { queryAll, cleanup } = mount(h(Breadcrumb, { prefix: 'photos/2024/summer/', onNavigate: p => { navigatedTo = p; } }));
    // Find the 'photos' crumb (index 1, after 'root')
    const crumbs = queryAll('.crumb');
    const photosCrumb = crumbs.find(c => c.textContent.includes('photos'));
    assert.ok(photosCrumb, '"photos" crumb must exist');
    fire(photosCrumb, 'click');
    assert.equal(navigatedTo, 'photos/', 'clicking "photos" crumb must navigate to "photos/"');
    cleanup();
  });
});

describe('Breadcrumb — move drop targets (drag-and-drop move)', () => {
  test('firing drop on the root crumb calls onMoveDrop with the empty prefix', () => {
    let dropped;
    const { query, cleanup } = mount(h(Breadcrumb, {
      prefix: 'photos/2024/', onNavigate: () => {},
      onMoveDrop: (target) => { dropped = target; },
    }));
    fire(query('.crumb'), 'drop'); // first .crumb is "root"
    assert.equal(dropped, '', 'dropping on root must move to the bucket root');
    cleanup();
  });

  test('firing drop on an ancestor crumb calls onMoveDrop with that prefix', () => {
    let dropped;
    const { queryAll, cleanup } = mount(h(Breadcrumb, {
      prefix: 'photos/2024/summer/', onNavigate: () => {},
      onMoveDrop: (target) => { dropped = target; },
    }));
    const photos = queryAll('.crumb').find(c => c.textContent.includes('photos'));
    fire(photos, 'drop');
    assert.equal(dropped, 'photos/', 'dropping on the "photos" crumb must move to photos/');
    cleanup();
  });

  test('dragover on a crumb forwards to onMoveOver with the target prefix', () => {
    let overTarget = 'unset';
    const { query, cleanup } = mount(h(Breadcrumb, {
      prefix: 'photos/', onNavigate: () => {},
      onMoveOver: (target) => { overTarget = target; },
    }));
    fire(query('.crumb'), 'dragover');
    assert.equal(overTarget, '', 'dragover on root must report the root target');
    cleanup();
  });

  test('moveHoverTarget applies drop-target-active to the matching crumb only', () => {
    const { queryAll, cleanup } = mount(h(Breadcrumb, {
      prefix: 'photos/2024/', onNavigate: () => {},
      onMoveDrop: () => {}, moveHoverTarget: 'photos/',
    }));
    const crumbs = queryAll('.crumb');
    const photos = crumbs.find(c => c.textContent.includes('photos'));
    const root   = crumbs.find(c => c.textContent.includes('root'));
    assert.ok(photos.className.includes('drop-target-active'), 'hovered crumb must be highlighted');
    assert.ok(!root.className.includes('drop-target-active'), 'non-hovered crumb must not be highlighted');
    cleanup();
  });

  test('the current (last) crumb is NOT a drop target', () => {
    let dropped = 'unset';
    const { query, cleanup } = mount(h(Breadcrumb, {
      prefix: 'photos/2024/', onNavigate: () => {},
      onMoveDrop: (target) => { dropped = target; },
    }));
    fire(query('.current'), 'drop'); // "2024" — the folder we're already in
    assert.equal(dropped, 'unset', 'dropping on the current folder must do nothing');
    cleanup();
  });

  test('without move props, crumbs carry no drop-target-active class', () => {
    const { queryAll, cleanup } = mount(h(Breadcrumb, { prefix: 'photos/2024/', onNavigate: () => {} }));
    assert.ok(queryAll('.crumb').every(c => !c.className.includes('drop-target-active')));
    cleanup();
  });
});

// ─── SortTh ───────────────────────────────────────────────────────────────────

describe('SortTh — inactive column', () => {
  test('shows the ⇅ neutral sort indicator when not active', () => {
    const { text, cleanup } = mount(h(SortTh, { col: 'name', sortCol: 'size', sortDir: 'asc', onSort: () => {}, children: 'Name' }));
    assert.ok(text().includes('⇅'), '⇅ neutral indicator must show for non-active column');
    cleanup();
  });

  test('does NOT have the col-sort-active class when inactive', () => {
    const { query, cleanup } = mount(h(SortTh, { col: 'name', sortCol: 'size', sortDir: 'asc', onSort: () => {}, children: 'Name' }));
    assert.ok(!query('th').className.includes('col-sort-active'), 'inactive column must not have col-sort-active class');
    cleanup();
  });
});

describe('SortTh — active column', () => {
  test('shows ▲ for ascending sort on active column', () => {
    const { text, cleanup } = mount(h(SortTh, { col: 'name', sortCol: 'name', sortDir: 'asc', onSort: () => {}, children: 'Name' }));
    assert.ok(text().includes('▲'), '▲ must appear for ascending active column');
    cleanup();
  });

  test('shows ▼ for descending sort on active column', () => {
    const { text, cleanup } = mount(h(SortTh, { col: 'name', sortCol: 'name', sortDir: 'desc', onSort: () => {}, children: 'Name' }));
    assert.ok(text().includes('▼'), '▼ must appear for descending active column');
    cleanup();
  });

  test('has col-sort-active class when this column is the sort column', () => {
    const { query, cleanup } = mount(h(SortTh, { col: 'size', sortCol: 'size', sortDir: 'asc', onSort: () => {}, children: 'Size' }));
    assert.ok(query('th').className.includes('col-sort-active'), 'active column must have col-sort-active class');
    cleanup();
  });

  test('clicking calls onSort with the column name', () => {
    let sortedCol = null;
    const { query, cleanup } = mount(h(SortTh, { col: 'modified', sortCol: 'name', sortDir: 'asc', onSort: col => { sortedCol = col; }, children: 'Modified' }));
    fire(query('th'), 'click');
    assert.equal(sortedCol, 'modified', 'onSort must be called with the column name');
    cleanup();
  });

  test('renders the column label as children text', () => {
    const { text, cleanup } = mount(h(SortTh, { col: 'size', sortCol: 'name', sortDir: 'asc', onSort: () => {}, children: 'Size' }));
    assert.ok(text().includes('Size'), 'column label must appear as text');
    cleanup();
  });
});

// ─── CopyLinkPopover ─────────────────────────────────────────────────────────

// Mock S3 client that never resolves (we only test the UI, not the URL generation)
function pendingClient() {
  return { send: () => new Promise(() => {}) };
}

describe('CopyLinkPopover — preset buttons', () => {
  test('shows the 1-hour preset button', () => {
    const { text, cleanup } = mount(h(CopyLinkPopover, {
      client: pendingClient(), bucket: 'my-bucket', fileKey: 'photo.jpg',
      onClose: () => {}, onCopied: () => {},
    }));
    assert.ok(text().includes('1 hour'), '"1 hour" preset button must be present');
    cleanup();
  });

  test('shows the 24-hours preset button', () => {
    const { text, cleanup } = mount(h(CopyLinkPopover, {
      client: pendingClient(), bucket: 'my-bucket', fileKey: 'photo.jpg',
      onClose: () => {}, onCopied: () => {},
    }));
    assert.ok(text().includes('24 hours'), '"24 hours" preset must be present');
    cleanup();
  });

  test('shows the 7-days preset button', () => {
    const { text, cleanup } = mount(h(CopyLinkPopover, {
      client: pendingClient(), bucket: 'my-bucket', fileKey: 'photo.jpg',
      onClose: () => {}, onCopied: () => {},
    }));
    assert.ok(text().includes('7 days'), '"7 days" preset must be present');
    cleanup();
  });

  test('shows the "Custom…" button', () => {
    const { text, cleanup } = mount(h(CopyLinkPopover, {
      client: pendingClient(), bucket: 'my-bucket', fileKey: 'photo.jpg',
      onClose: () => {}, onCopied: () => {},
    }));
    assert.ok(text().includes('Custom'), '"Custom…" button must be present');
    cleanup();
  });
});

describe('CopyLinkPopover — custom duration', () => {
  test('clicking "Custom…" reveals the custom duration input', () => {
    const { query, cleanup } = mount(h(CopyLinkPopover, {
      client: pendingClient(), bucket: 'my-bucket', fileKey: 'photo.jpg',
      onClose: () => {}, onCopied: () => {},
    }));
    const customBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Custom'));
    assert.ok(customBtn, '"Custom…" button must be present');
    fire(customBtn, 'click');
    assert.ok(query('input[type="number"]') || query('input'), 'custom duration input must appear after clicking Custom…');
    cleanup();
  });

  test('shows a unit selector (hours/minutes/days) in custom mode', () => {
    const { query, cleanup } = mount(h(CopyLinkPopover, {
      client: pendingClient(), bucket: 'my-bucket', fileKey: 'photo.jpg',
      onClose: () => {}, onCopied: () => {},
    }));
    fire([...document.querySelectorAll('button')].find(b => b.textContent.includes('Custom')), 'click');
    const select = query('select');
    assert.ok(select, 'unit selector must appear in custom mode');
    // Options are: 'min', 'hrs', 'days'
    assert.ok(select.textContent.includes('min') || select.textContent.includes('hrs') || select.textContent.includes('days'));
    cleanup();
  });
});

describe('CopyLinkPopover — batch mode', () => {
  test('shows batch description note when fileKeys array is passed', () => {
    const { text, cleanup } = mount(h(CopyLinkPopover, {
      client: pendingClient(), bucket: 'my-bucket',
      fileKeys: ['a.jpg', 'b.jpg', 'c.jpg'],
      onClose: () => {}, onCopied: () => {},
    }));
    // Batch note mentions the count
    assert.ok(text().includes('3') || text().includes('link'), 'batch note must mention link count');
    cleanup();
  });

  test('shows single-file note when fileKey (not fileKeys) is passed', () => {
    const { text, cleanup } = mount(h(CopyLinkPopover, {
      client: pendingClient(), bucket: 'my-bucket', fileKey: 'photo.jpg',
      onClose: () => {}, onCopied: () => {},
    }));
    assert.ok(text().includes('Link expires') || text().includes('expires'), 'single-file expiry note must appear');
    cleanup();
  });
});
