// End-to-end: the real harness binary, real file tools and the real run loop,
// against a scripted mock of the Responses API. No API key or network needed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRuntimeExecutable } from '@openworkerai/harness-sdk';
import { runOrganizer } from '../src/app.ts';
import { demoPaths, providerSettings } from '../src/config.ts';
import type { ModelChoice } from '../src/config.ts';
import { resetDemoDirectory } from '../src/demo-files.ts';
import type { ToolActivity } from '../src/file-tools.ts';
import { RecordingObserver, ScriptedApprover, tempDir } from './support/fakes.ts';
import { startMockResponsesServer } from './support/mock-responses-server.ts';

const runtimeAvailable = (() => {
  try { resolveRuntimeExecutable(); return true; } catch { return false; }
})();

const model: ModelChoice = { provider: 'OpenAI', api: 'responses', apiKeyEnv: 'OPENAI_API_KEY', name: 'mock' };

describe('runOrganizer (integration)', { skip: !runtimeAvailable && 'harness runtime not installed', timeout: 60_000 }, () => {
  it('runs tools, pauses for every change, and respects denials', async (t) => {
    const server = await startMockResponsesServer([
      { call: 'files__list_files', args: { path: '.' } },
      { call: 'files__read_file', args: { path: 'draft.txt' } },
      { call: 'files__create_directory', args: { path: 'travel' } },
      { call: 'files__move_file', args: { from: 'draft.txt', to: 'travel' } },
      { call: 'files__move_file', args: { from: 'file (2).txt', to: 'travel' } },
      { text: 'Moved draft.txt to travel/. The second move was denied.' },
    ]);
    t.after(() => server.close());

    const paths = demoPaths(await tempDir(t));
    await resetDemoDirectory(paths);
    const observer = new RecordingObserver();
    const approver = new ScriptedApprover([true, true, false]); // create, move, deny 2nd move
    const activity: ToolActivity[] = [];
    const statuses: string[] = [];

    const result = await runOrganizer({
      paths,
      model,
      provider: providerSettings(model, { OPENAI_BASE_URL: server.url }),
      observer,
      approver,
      onToolActivity: a => activity.push(a),
      onStatus: s => statuses.push(s),
    });

    // The run completed with the model's final message.
    assert.equal(result.status, 'completed');
    assert.equal(observer.finishedWith?.text, 'Moved draft.txt to travel/. The second move was denied.');
    assert.deepEqual(statuses, ['Starting OpenWorker harness', 'Sending task to the agent']);

    // Only the three changes needed approval; reads and listings ran freely.
    assert.deepEqual(approver.requests.map(r => r.tool), [
      'files__create_directory', 'files__move_file', 'files__move_file',
    ]);
    assert.equal(observer.calls.filter(c => c.startsWith('paused')).length, 3);

    // The denied tool never ran.
    const ran = activity.filter(a => a.phase === 'callback').map(a => a.name);
    assert.deepEqual(ran, ['files.list_files', 'files.read_file', 'files.create_directory', 'files.move_file']);

    // The disk matches: one file moved, the denied one untouched.
    assert.deepEqual(await readdir(join(paths.workspace, 'travel')), ['draft.txt']);
    assert.ok(existsSync(join(paths.workspace, 'file (2).txt')));
    assert.ok(!existsSync(join(paths.workspace, 'draft.txt')));

    // Every model request went to the mock, and no credentials were sent.
    assert.equal(server.requests.length, 6);
    assert.ok(server.requests.every(h => !h.authorization), 'no Authorization header');
  });
});
