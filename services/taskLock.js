/**
 * Single shared lock for document processing runs.
 *
 * Previously `runningTask` was a module-local in server.js, and routes/setup.js
 * assigned to an undeclared name, which created a global on globalThis. The scan
 * route therefore never saw the cron's lock state and could process the same
 * documents twice (duplicate history rows, double LLM cost, racing writes to the
 * same document). Both paths now go through this module so there is exactly one
 * lock, shared by the cron scan, the scan-now route, the queue worker and the
 * reprocess-all route.
 */
class TaskLock {
  constructor() {
    this.locked = false;
    this.waiters = [];
  }

  isRunning() {
    return this.locked;
  }

  /** Resolves as soon as the lock is free. Used by the webhook queue so it does
   *  not process documents while a full reprocess run is walking the same corpus. */
  async waitUntilFree() {
    if (!this.locked) return;
    await new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Returns true when the caller acquired the lock, false when it was already held. */
  tryAcquire() {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  release() {
    this.locked = false;
    const waiters = this.waiters.splice(0);
    waiters.forEach(resolve => resolve());
  }

  /** Run fn while holding the lock. Rejects with `alreadyRunning` when busy. */
  async run(fn) {
    if (!this.tryAcquire()) {
      const error = new Error('A processing run is already active');
      error.alreadyRunning = true;
      throw error;
    }
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

module.exports = new TaskLock();
