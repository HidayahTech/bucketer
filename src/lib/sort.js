// Copyright (C) 2026 HidayahTech, LLC
// Sort comparator factories for the object browser.
//
// WHY THIS FILE EXISTS: the locale-comparison options (sensitivity: 'base') for
// case-insensitive name sorting were previously duplicated in two inline .sort()
// calls in Browser.jsx (one for folders, one for files). If the collation behavior
// needs to change (e.g. to support locale-aware sorting), there is now one place.
//
// WHAT BELONGS HERE: comparator factories used by the browser's sort feature.
//
// WHAT DOES NOT BELONG HERE: sort state (sortCol, sortDir), filtering, or any
// component-level logic. Consumers own the sort state and pass the direction here.

// Returns a comparator for locale-insensitive string comparison.
// Use for S3 key names (case-insensitive, accent-insensitive).
export function nameComparator(sortDir) {
  return (a, b) => {
    const cmp = a.localeCompare(b, undefined, { sensitivity: 'base' });
    return sortDir === 'asc' ? cmp : -cmp;
  };
}

// Returns a comparator for numeric values (file size, timestamps).
export function numericComparator(sortDir) {
  return (a, b) => sortDir === 'asc' ? a - b : b - a;
}
