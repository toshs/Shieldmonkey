let queue: Promise<unknown> = Promise.resolve();
let revision = crypto.randomUUID();
export function serializeGM<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work); queue = next.catch(() => {}); return next;
}
// A worker restart invalidates previews as well; a stale preview must not restore.
export const gmValueRevision = () => revision;
export function changedGMValues() { revision = crypto.randomUUID(); }
