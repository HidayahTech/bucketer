// Copyright (C) 2026 HidayahTech, LLC
export function SortTh({ col, sortCol, sortDir, onSort, align, children }) {
  const active = sortCol === col;
  return (
    <th
      class={`col-sortable${active ? ' col-sort-active' : ''}`}
      style={align === 'right' ? { textAlign: 'right' } : undefined}
      onClick={() => onSort(col)}
      title={`Sort by ${children}`}
    >
      {children}
      <span class="sort-indicator">
        {active ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </th>
  );
}
