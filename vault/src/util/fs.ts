import { fstatSync, writeSync } from 'node:fs';

/**
 * Write every byte of `buf` to `fd`, looping on short writes the way fs.writeFileSync does. A bare writeSync returns
 * the number of bytes the kernel accepted and does not retry: on a nearly full disk it can hand back a short count
 * with no error, which silently left torn journal lines, truncated manifests and truncated key files behind
 * successful-looking calls. Throws a plain Error (callers map it to VaultError('IO')) when no progress is made.
 */
export function writeFully(fd: number, buf: Buffer): void {
  let done = 0;
  while (done < buf.length) {
    const n = writeSync(fd, buf, done, buf.length - done);
    if (n <= 0) throw new Error(`short write: ${done} of ${buf.length} bytes written`);
    done += n;
  }
}

/** The file's current size as seen through `fd`, for the post-fsync check that what was written is what is on disk. */
export function fileSize(fd: number): number {
  return fstatSync(fd).size;
}
