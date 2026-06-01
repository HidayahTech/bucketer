// Bounded-concurrency task queue for file uploads (§4.6).
// Spec default N=2; implemented as N=3 (D-3 — HTTP/2 multiplexing justification).
// The concurrency value is read from the constructor argument at enqueue time, so
// Settings changes take effect for subsequent files without restarting uploads.

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
