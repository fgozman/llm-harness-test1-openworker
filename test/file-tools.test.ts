import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplicationTools, Json } from '@openworkerai/harness-sdk';
import { FILE_TOOLS, MAX_READ_BYTES, createFileTools, qualifiedName } from '../src/file-tools.ts';
import type { FileEntry, ToolActivity } from '../src/file-tools.ts';
import { tempDir, toolContext } from './support/fakes.ts';

interface Fixture {
  dir: string;
  tools: ApplicationTools;
  activity: ToolActivity[];
  call(name: string, args: Record<string, Json>): Promise<unknown>;
}

/** Temp workspace with notes.txt, recipes/ and the registered file tools. */
async function setup(t: Parameters<typeof tempDir>[0]): Promise<Fixture> {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'notes.txt'), 'line one\nline two\n');
  await mkdir(join(dir, 'recipes'));
  const activity: ToolActivity[] = [];
  const tools = await createFileTools(dir, a => activity.push(a));
  const call = async (name: string, args: Record<string, Json>) => {
    const tool = tools.tools[name];
    if (!tool) throw Error(`no tool ${name}`);
    return tool.execute(args, toolContext(dir));
  };
  return { dir, tools, activity, call };
}

describe('tool registration', () => {
  it('registers all five tools under the files namespace', async (t) => {
    const { tools } = await setup(t);
    assert.equal(tools.namespace, 'files');
    assert.deepEqual(Object.keys(tools.tools),
      ['list_files', 'read_file', 'create_directory', 'delete_directory', 'move_file']);
  });

  it('marks exactly the disk-changing tools as mutating', () => {
    assert.deepEqual(FILE_TOOLS.filter(s => s.mutating).map(qualifiedName),
      ['files.create_directory', 'files.delete_directory', 'files.move_file']);
  });

  it('gives every tool a strict object schema', () => {
    for (const spec of FILE_TOOLS) {
      assert.equal((spec.inputSchema as Record<string, Json>).additionalProperties, false, spec.name);
    }
  });
});

describe('files.list_files', () => {
  it('lists entries and marks directories', async (t) => {
    const { call } = await setup(t);
    const result = await call('list_files', { path: '.' });
    const entries = result as unknown as FileEntry[];
    assert.deepEqual(entries.sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'notes.txt', directory: false },
      { name: 'recipes', directory: true },
    ]);
  });
});

describe('files.read_file', () => {
  it('returns the text', async (t) => {
    const { call } = await setup(t);
    assert.deepEqual(await call('read_file', { path: 'notes.txt' }), { text: 'line one\nline two\n' });
  });

  it('refuses directories and large files', async (t) => {
    const { call, dir } = await setup(t);
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(MAX_READ_BYTES + 1));
    await assert.rejects(call('read_file', { path: 'recipes' }), /Expected a small regular file/);
    await assert.rejects(call('read_file', { path: 'big.txt' }), /Expected a small regular file/);
  });
});

describe('files.create_directory / delete_directory', () => {
  it('creates and removes an empty directory', async (t) => {
    const { call, dir } = await setup(t);
    assert.deepEqual(await call('create_directory', { path: 'travel' }), { created: 'travel' });
    assert.ok(existsSync(join(dir, 'travel')));
    assert.deepEqual(await call('delete_directory', { path: 'travel' }), { removed: 'travel' });
    assert.ok(!existsSync(join(dir, 'travel')));
  });

  it('will not delete the root or a non-empty directory', async (t) => {
    const { call, dir } = await setup(t);
    await writeFile(join(dir, 'recipes', 'r.txt'), '');
    await assert.rejects(call('delete_directory', { path: '.' }), /Cannot remove the demo root/);
    await assert.rejects(call('delete_directory', { path: 'recipes' }), /ENOTEMPTY/);
  });
});

describe('files.move_file', () => {
  it('moves into an existing directory, keeping the file name', async (t) => {
    const { call, dir } = await setup(t);
    assert.deepEqual(await call('move_file', { from: 'notes.txt', to: 'recipes' }),
      { moved: { from: 'notes.txt', to: 'recipes/notes.txt' } });
    assert.deepEqual(await readdir(join(dir, 'recipes')), ['notes.txt']);
    assert.ok(!existsSync(join(dir, 'notes.txt')));
  });

  it('moves to an explicit new path', async (t) => {
    const { call } = await setup(t);
    assert.deepEqual(await call('move_file', { from: 'notes.txt', to: 'recipes/renamed.txt' }),
      { moved: { from: 'notes.txt', to: 'recipes/renamed.txt' } });
  });

  it('never overwrites an existing file', async (t) => {
    const { call, dir } = await setup(t);
    await writeFile(join(dir, 'recipes', 'notes.txt'), 'original');
    await assert.rejects(call('move_file', { from: 'notes.txt', to: 'recipes' }), /EEXIST/);
    assert.equal(await readFile(join(dir, 'recipes', 'notes.txt'), 'utf8'), 'original');
    assert.ok(existsSync(join(dir, 'notes.txt')));
  });

  it('only moves regular files', async (t) => {
    const { call } = await setup(t);
    await assert.rejects(call('move_file', { from: 'recipes', to: 'elsewhere' }), /Expected a regular file/);
  });

  it('checks both ends of the move', async (t) => {
    const { call } = await setup(t);
    await assert.rejects(call('move_file', { from: '../x', to: 'a' }), /relative path/);
    await assert.rejects(call('move_file', { from: 'notes.txt', to: '/tmp/x' }), /relative path/);
  });
});

describe('tool wrapper', () => {
  it('reports callback and result activity with call ids, and progress', async (t) => {
    const { tools, dir, activity } = await setup(t);
    const context = toolContext(dir);
    await tools.tools.read_file!.execute({ path: 'notes.txt' }, context);

    assert.deepEqual(activity.map(a => a.phase), ['callback', 'result']);
    assert.deepEqual(activity[0], {
      phase: 'callback', name: 'files.read_file', args: { path: 'notes.txt' },
      sessionId: 's1', turnId: 't1', callId: 'c1',
    });
    assert.deepEqual(context.progressMessages, ['Running files.read_file']);
  });

  it('reports errors with host paths hidden', async (t) => {
    const { call, dir, activity } = await setup(t);
    await assert.rejects(call('read_file', { path: 'missing.txt' }), (error: Error) => {
      assert.ok(!error.message.includes(dir), error.message);
      assert.match(error.message, /missing\.txt/);
      return true;
    });
    const last = activity.at(-1)!;
    assert.equal(last.phase, 'error');
    assert.ok(last.phase === 'error' && !last.error.includes(dir));
  });

  it('refuses to run in a different workspace', async (t) => {
    const { tools, dir } = await setup(t);
    await assert.rejects(
      async () => tools.tools.list_files!.execute({ path: '.' }, toolContext(join(dir, 'recipes'))),
      /Wrong workspace/);
  });

  it('does nothing once the call is aborted', async (t) => {
    const { tools, dir, activity } = await setup(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      async () => tools.tools.create_directory!.execute({ path: 'x' }, toolContext(dir, { signal: controller.signal })),
      { name: 'AbortError' });
    assert.equal(activity.length, 0);
    assert.ok(!existsSync(join(dir, 'x')));
  });

  it('accepts a custom set of tool specs', async (t) => {
    const dir = await tempDir(t);
    const tools = await createFileTools(dir, undefined, [{
      name: 'echo', description: 'echo', inputSchema: {}, mutating: false,
      run: async (args) => args,
    }]);
    assert.deepEqual(await tools.tools.echo!.execute({ a: 1 }, toolContext(dir)), { a: 1 });
  });
});
