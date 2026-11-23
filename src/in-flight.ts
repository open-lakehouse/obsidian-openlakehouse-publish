/**
 * Tracks running operations by key (e.g. a note's path), so the same note
 * can't be published twice concurrently.
 */
export class InFlightGuard {
  private running = new Set<string>();

  isRunning(key: string) {
    return this.running.has(key);
  }

  /**
   * Runs `fn` unless an operation with the same key is still running, in
   * which case `undefined` is returned and `fn` is not called. The key is
   * released when `fn` settles, whether it resolves or rejects.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> | undefined {
    if (this.running.has(key)) {
      return undefined;
    }
    this.running.add(key);
    let promise: Promise<T>;
    try {
      promise = fn();
    } catch (err) {
      this.running.delete(key);
      throw err;
    }
    return promise.finally(() => this.running.delete(key));
  }
}
