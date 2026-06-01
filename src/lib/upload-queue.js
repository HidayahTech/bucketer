// Bounded-concurrency task queue for file uploads (§4.6).
// Spec default N=2; implemented as N=3 (D-3 — HTTP/2 multiplexing justification).
// The concurrency value is read from the constructor argument at enqueue time, so
// Settings changes take effect for subsequent files without restarting uploads.

// S3 hard limits: minimum part size 5 MB (decimal), maximum 10,000 parts per upload.
// preferredBytes is honoured only when it is above the computed floor — we never go
// below the floor because that would either violate the 5 MB minimum (last part excluded)
// or push the part count over 10,000 for very large files.
export function calcPartSize(fileSize, preferredBytes) {
  const floor = Math.max(5 * 1000 * 1000, Math.ceil(fileSize / 10000));
  return (preferredBytes && preferredBytes > floor) ? preferredBytes : floor;
}

export class UploadQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this._running = 0;
    this._pending = [];
  }

  // Add a task function () => Promise. Returns a promise that resolves/rejects with the task result.
  enqueue(task) {
    return new Promise((resolve, reject) => {
      this._pending.push({ task, resolve, reject });
      this._drain();
    });
  }

  // Drop all pending (not yet started) tasks. In-flight tasks are NOT cancelled —
  // those must be stopped via their own AbortController. Used on "Cancel all."
  clear() {
    this._pending = [];
  }

  _drain() {
    while (this._running < this.concurrency && this._pending.length > 0) {
      const { task, resolve, reject } = this._pending.shift();
      this._running++;
      task().then(resolve, reject).finally(() => {
        this._running--;
        this._drain();
      });
    }
  }
}
