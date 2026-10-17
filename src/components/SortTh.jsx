// Copyright (C) 2026 HidayahTech, LLC
// The click handler stays on the <th> so the whole cell is a target; the inner button gives
// keyboard users a Tab stop whose Enter/Space click bubbles to it (K1).
export function SortTh({ col, sortCol, sortDir, onSort, align, colClass, children }) {
  const active = sortCol === col;
  return (
    <th
      class={`col-sortable${active ? ' col-sort-active' : ''}${colClass ? ` ${colClass}` : ''}`}
      style={align === 'right' ? { textAlign: 'right' } : undefined}
      onClick={() => onSort(col)}
      title={`Sort by ${children}`}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button type="button" class="link-btn sort-btn">
        {children}
        <span class="sort-indicator" aria-hidden="true">
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </button>
    </th>
  );
}
