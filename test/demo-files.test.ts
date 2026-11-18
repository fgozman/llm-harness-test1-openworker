import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { demoPaths } from '../src/config.ts';
import { SAMPLE_FILES, resetDemoDirectory } from '../src/demo-files.ts';
import { tempDir } from './support/fakes.ts';

describe('resetDemoDirectory', () => {
  it('creates the workspace, the marker and all sample files', async (t) => {
    const paths = demoPaths(await tempDir(t));
    const names = await resetDemoDirectory(paths);

    assert.deepEqual(names, Object.keys(SAMPLE_FILES));
    assert.ok(existsSync(paths.marker));
    const written = await readdir(paths.workspace);
    const expected = Object.keys(SAMPLE_FILES);
    assert.deepEqual(written.sort(), expected.sort());

    const draft = await readFile(join(paths.workspace, 'draft.txt'), 'utf8');
    assert.equal(draft, SAMPLE_FILES['draft.txt'] + '\n');
  });

  it('ships ten sample files', () => {
    assert.equal(Object.keys(SAMPLE_FILES).length, 10);
  });

  it('replaces a previous demo it created', async (t) => {
    const paths = demoPaths(await tempDir(t));
    await resetDemoDirectory(paths);
    await mkdir(join(paths.workspace, 'leftover'));
    await mkdir(paths.stateDir);

    await resetDemoDirectory(paths, { 'only.txt': 'x' });

    assert.deepEqual(await readdir(paths.workspace), ['only.txt']);
    assert.ok(!existsSync(paths.stateDir));
  });

  it('refuses to delete a directory it did not create', async (t) => {
    const paths = demoPaths(await tempDir(t));
    await mkdir(paths.root);
    await writeFile(join(paths.root, 'precious.txt'), 'keep me');

    await assert.rejects(resetDemoDirectory(paths), /was not created by this demo; refusing to reset it/);
    assert.equal(await readFile(join(paths.root, 'precious.txt'), 'utf8'), 'keep me');
  });
});
