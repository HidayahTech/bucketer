// Copyright (C) 2026 HidayahTech, LLC
// Breadcrumb navigation. Optionally doubles as drag-and-drop move targets: when the move
// handlers are supplied, the root and ancestor crumbs (not the current folder) become drop
// targets so a dragged object can be moved "up" the hierarchy. The MovePickerModal uses
// this component without the move props, so the drop behavior is entirely opt-in.
//
// floor (prefix-scoped keys, #60): the connection's base prefix. Segments above the
// floor are hidden entirely — a crumb whose only possible outcome is a 403 invites a
// doomed click — and the leftmost crumb becomes the floor itself, labeled with its leaf
// segment and navigating to the floor rather than ''. floor='' reproduces the unscoped
// rendering byte-for-byte.
export function Breadcrumb({ prefix, floor = '', onNavigate, onMoveOver, onMoveLeave, onMoveDrop, moveHoverTarget }) {
  // Props for a droppable crumb. The class is always `crumb` (+ highlight when hovered);
  // drag handlers attach only when move handlers are supplied.
  function crumbProps(target) {
    const cls = `crumb${moveHoverTarget === target ? ' drop-target-active' : ''}`;
    if (!onMoveOver && !onMoveDrop) return { class: cls };
    return {
      class: cls,
      onDragOver:  onMoveOver  ? (e) => onMoveOver(target, e)  : undefined,
      onDragLeave: onMoveLeave ? (e) => onMoveLeave(target, e) : undefined,
      onDrop:      onMoveDrop  ? (e) => { e.preventDefault(); onMoveDrop(target, e); } : undefined,
    };
  }

  // Defensive: a prefix outside the floor should be impossible (every caller clamps),
  // but must not crash — fall back to unscoped rendering.
  const effectiveFloor = (floor && (prefix || '').startsWith(floor)) ? floor : '';
  const floorParts = effectiveFloor.split('/').filter(Boolean);
  const rootLabel = floorParts.length ? floorParts[floorParts.length - 1] : 'root';
  const rootTitle = effectiveFloor ? `Your access starts here — ${effectiveFloor}` : undefined;

  if (!prefix || prefix === effectiveFloor) return (
    <div class="breadcrumb"><span class="current" title={rootTitle}>{effectiveFloor ? rootLabel : '/ (root)'}</span></div>
  );
  const parts = prefix.split('/').filter(Boolean).slice(floorParts.length);
  return (
    <div class="breadcrumb">
      <span {...crumbProps(effectiveFloor)} title={rootTitle} onClick={() => onNavigate(effectiveFloor)}>{rootLabel}</span>
      {parts.map((part, i) => {
        const target = effectiveFloor + parts.slice(0, i + 1).join('/') + '/';
        const isLast = i === parts.length - 1;
        return [
          <span key={`sep-${i}`} class="sep">/</span>,
          isLast
            ? <span key={part} class="current">{part}</span>
            : <span key={part} {...crumbProps(target)} onClick={() => onNavigate(target)}>{part}</span>,
        ];
      })}
    </div>
  );
}
