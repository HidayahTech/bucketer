// Bounded concurrency upload queue (§4.6 — default N=2)

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
