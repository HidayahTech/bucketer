// Coalesces rapid non-urgent updateItem calls (progress ticks) into a single
// setItems call per animation frame, while urgent patches (status transitions)
// flush immediately. Keeps pending bytes for an item when an urgent status patch
// arrives by merging into the accumulator before flushing.
//
// scheduleFlush / cancelFlush are injected so the logic is testable without rAF.
export function createUpdateBatcher(setItems, scheduleFlush, cancelFlush) {
  const pending = new Map(); // id → accumulated patch
  let handle = null;

  function flush() {
    handle = null;
    if (pending.size === 0) return;
    const patches = new Map(pending);
    pending.clear();
    setItems(prev => prev.map(it => {
      const p = patches.get(it.id);
      return p ? { ...it, ...p } : it;
    }));
  }

  function update(id, patch, urgent = false) {
    // Merge into pending first — urgent status patches preserve accumulated bytes
    const acc = pending.get(id);
    pending.set(id, acc ? { ...acc, ...patch } : patch);

    if (urgent) {
      if (handle !== null) cancelFlush(handle);
      flush();
    } else if (handle === null) {
      handle = scheduleFlush(flush);
    }
  }

  return { update, flush };
}
