// One origin-wide lock covers options tabs and the action popup. Keep file I/O
// and its library commit in the same lock; a per-page Promise queue is not enough.
export async function withLibraryLock<T>(work: () => Promise<T>): Promise<T> {
    if (!globalThis.navigator?.locks) return Promise.reject(new Error('Safe library updates require Web Locks support.'));
    return await navigator.locks.request('shieldmonkey-library-v1', work);
}
export const libraryRevision = (value: unknown): string => typeof value === 'string' ? value : '';
export function assertLibraryRevision(current: unknown, expected: unknown): void {
    if (typeof expected !== 'string' || libraryRevision(current) !== expected) {
        throw new Error('The library changed. Reload and review your changes before saving again.');
    }
}
