import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PathScope } from '../src/path-scope.ts';
import { tempDir } from './support/fakes.ts';

/** A scope over a temp dir containing: a.txt, sub/b.txt, link -> sub */
async function setup(t: Parameters<typeof tempDir>[0]): Promise<PathScope> {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'a.txt'), 'a');
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'b.txt'), 'b');
  await symlink(join(dir, 'sub'), join(dir, 'link'));
  return PathScope.open(dir);
}

describe('PathScope.open', () => {
  it('rejects a file', async (t) => {
    const dir = await tempDir(t);
    await writeFile(join(dir, 'f'), '');
    await assert.rejects(PathScope.open(join(dir, 'f')), /Expected a directory/);
  });
});

describe('PathScope.resolve', () => {
  it('resolves the root and nested paths', async (t) => {
    const scope = await setup(t);
    assert.equal(await scope.resolve('.'), scope.root);
    assert.equal(await scope.resolve('./'), scope.root);
    assert.equal(await scope.resolve('a.txt'), join(scope.root, 'a.txt'));
    assert.equal(await scope.resolve('./sub/b.txt'), join(scope.root, 'sub', 'b.txt'));
    assert.equal(await scope.resolve('sub/'), join(scope.root, 'sub'));
  });

  const notRelative = /Use a relative path inside the demo directory/;
  for (const bad of ['', '/etc/passwd', 'C:/x', 'sub\\b.txt', 'a\0b', '..', '../x', 'sub/../a.txt', 'sub//b.txt', 'sub/./b.txt']) {
    it(`rejects ${JSON.stringify(bad)}`, async (t) => {
      const scope = await setup(t);
      await assert.rejects(scope.resolve(bad), notRelative);
    });
  }

  for (const bad of [undefined, null, 42, { path: 'a.txt' }]) {
    it(`rejects non-string ${JSON.stringify(bad)}`, async (t) => {
      const scope = await setup(t);
      await assert.rejects(scope.resolve(bad), notRelative);
    });
  }

  it('rejects symlinks anywhere in the path', async (t) => {
    const scope = await setup(t);
    await assert.rejects(scope.resolve('link'), /Symlinks are not allowed/);
    await assert.rejects(scope.resolve('link/b.txt'), /Symlinks are not allowed/);
  });

  it('rejects a file used as a parent', async (t) => {
    const scope = await setup(t);
    await assert.rejects(scope.resolve('a.txt/x', { allowMissing: true }), /Parent is not a directory/);
  });

  it('requires the path to exist unless allowMissing is set', async (t) => {
    const scope = await setup(t);
    await assert.rejects(scope.resolve('new.txt'), { code: 'ENOENT' });
    assert.equal(await scope.resolve('new.txt', { allowMissing: true }), join(scope.root, 'new.txt'));
  });

  it('allows only the last segment to be missing', async (t) => {
    const scope = await setup(t);
    await assert.rejects(scope.resolve('missing/new.txt', { allowMissing: true }), { code: 'ENOENT' });
  });
});

describe('PathScope helpers', () => {
  it('contains() compares real paths', async (t) => {
    const scope = await setup(t);
    assert.equal(await scope.contains(scope.root), true);
    assert.equal(await scope.contains(join(scope.root, 'sub')), false);
  });

  it('toRelative() returns "/"-separated paths', async (t) => {
    const scope = await setup(t);
    assert.equal(scope.toRelative(join(scope.root, 'sub', 'b.txt')), 'sub/b.txt');
  });

  it('redact() hides host paths', async (t) => {
    const scope = await setup(t);
    assert.equal(scope.redact(`ENOENT: no such file '${join(scope.root, 'x.txt')}'`), "ENOENT: no such file 'x.txt'");
    assert.equal(scope.redact(`bad dir '${scope.root}'`), "bad dir '.'");
  });
});
