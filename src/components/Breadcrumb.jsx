// Copyright (C) 2026 HidayahTech, LLC
// Breadcrumb navigation. Optionally doubles as drag-and-drop move targets: when the move
// handlers are supplied, the root and ancestor crumbs (not the current folder) become drop
// targets so a dragged object can be moved "up" the hierarchy. The MovePickerModal uses
// this component without the move props, so the drop behavior is entirely opt-in.
export function Breadcrumb({ prefix, onNavigate, onMoveOver, onMoveLeave, onMoveDrop, moveHoverTarget }) {
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

  if (!prefix) return (
    <div class="breadcrumb"><span class="current">/ (root)</span></div>
  );
  const parts = prefix.split('/').filter(Boolean);
  return (
    <div class="breadcrumb">
      <span {...crumbProps('')} onClick={() => onNavigate('')}>root</span>
      {parts.map((part, i) => {
        const target = parts.slice(0, i + 1).join('/') + '/';
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
