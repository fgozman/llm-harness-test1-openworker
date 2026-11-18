// Confines model-supplied paths to one directory.
//
// Absolute paths, "..", backslashes, empty segments and symlinks are rejected.
// This is application-level scoping for an app-owned directory, not OS isolation.
import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const NOT_RELATIVE = 'Use a relative path inside the demo directory';
const WINDOWS_DRIVE = /^[A-Za-z]:/;

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT';
}

/** A non-empty relative path using "/" as separator, with no drive letter or NUL byte. */
function isPlainRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  if (value.includes('\0') || value.includes('\\')) return false;
  if (isAbsolute(value) || WINDOWS_DRIVE.test(value)) return false;
  return true;
}

/** True if any "/"-separated segment is empty, "." or "..". */
function hasBadSegment(path: string): boolean {
  const segments = path.split('/');
  return segments.some(segment => segment === '' || segment === '.' || segment === '..');
}

/** True if a path relative to root points outside it. */
function escapesRoot(rel: string): boolean {
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}

export class PathScope {
  /** Canonical absolute path of the directory (symlinks resolved). */
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /** Opens a scope on an existing directory. */
  static async open(directory: string): Promise<PathScope> {
    const root = await realpath(directory);
    const stat = await lstat(root);
    if (!stat.isDirectory()) throw Error('Expected a directory');
    return new PathScope(root);
  }

  /** True if `directory` is the same directory as the root (after resolving symlinks). */
  async contains(directory: string): Promise<boolean> {
    const canonical = await realpath(directory);
    return canonical === this.root;
  }

  /**
   * Turns a model-supplied path into an absolute path inside root, or throws.
   * With `allowMissing`, the last segment may not exist yet (it is about to be created).
   */
  async resolve(value: unknown, { allowMissing = false } = {}): Promise<string> {
    // 1. It must be a plain relative path, using "/" as separator.
    if (!isPlainRelativePath(value)) throw Error(NOT_RELATIVE);
    if (value === '.' || value === './') return this.root;

    const withoutLeadingDot = value.replace(/^\.\//, '');
    const cleaned = withoutLeadingDot.replace(/\/$/, '');
    if (hasBadSegment(cleaned)) throw Error(NOT_RELATIVE);

    // 2. Double-check that the resolved path is still under root.
    const path = resolve(this.root, cleaned);
    const rel = relative(this.root, path);
    if (escapesRoot(rel)) throw Error('Outside demo directory');

    // 3. Walk each segment on disk: no symlinks, and every parent must be a directory.
    const parts = rel ? rel.split(sep) : [];
    let current = this.root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const isLast = index === parts.length - 1;

      let stat: Stats;
      try {
        stat = await lstat(current);
      } catch (error) {
        if (isLast && allowMissing && isNotFound(error)) return path;
        throw error;
      }
      if (stat.isSymbolicLink()) throw Error('Symlinks are not allowed');
      if (!isLast && !stat.isDirectory()) throw Error('Parent is not a directory');
    }
    return path;
  }

  /** Converts an absolute path inside root to a "/"-separated relative path. */
  toRelative(path: string): string {
    const rel = relative(this.root, path);
    return rel.replaceAll(sep, '/');
  }

  /** Rewrites host paths in a message relative to root, so the model never sees them. */
  redact(message: string): string {
    const withoutRootPrefix = message.replaceAll(this.root + sep, '');
    return withoutRootPrefix.replaceAll(this.root, '.');
  }
}
