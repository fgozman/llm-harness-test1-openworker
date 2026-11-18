import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AttemptOutput } from '@openworkerai/harness-sdk';
import { PLAIN_STYLE, terminalStyle } from '../src/style.ts';
import {
  StatusLine, TerminalApprover, TerminalRunObserver, printToolActivity, printTree,
} from '../src/terminal.ts';
import {
  CapturingOutput, ScriptedPrompter, approvalRequest, attemptFinished, delta, runEvent, runResult, tempDir,
} from './support/fakes.ts';

const ids = { sessionId: 's', turnId: 't', callId: 'c' };

describe('style', () => {
  it('colors only when enabled', () => {
    assert.equal(terminalStyle(false).red('x'), 'x');
    assert.equal(terminalStyle(true).red('x'), '\x1b[31mx\x1b[0m');
  });
});

describe('StatusLine', () => {
  it('prints status lines and skips exact repeats', () => {
    const out = new CapturingOutput();
    const status = new StatusLine(out, PLAIN_STYLE);
    status.show('a');
    status.show('a');
    status.show('b');
    status.show('a');
    assert.deepEqual(out.lines, ['◆ status a', '◆ status b', '◆ status a']);
  });
});

describe('printToolActivity', () => {
  it('prints start, result and error lines', () => {
    const out = new CapturingOutput();
    printToolActivity({ phase: 'callback', name: 'files.read_file', args: { path: 'a' }, ...ids }, out, PLAIN_STYLE);
    printToolActivity({ phase: 'result', name: 'files.read_file', result: { text: 'hi' }, ...ids }, out, PLAIN_STYLE);
    printToolActivity({ phase: 'error', name: 'files.read_file', error: 'nope', ...ids }, out, PLAIN_STYLE);
    assert.deepEqual(out.lines, [
      '  ▶ tool files.read_file {"path":"a"}',
      '  ✔ done files.read_file 2 chars — "hi"',
      '  ✖ error files.read_file nope',
    ]);
  });
});

describe('printTree', () => {
  it('prints a sorted, indented tree with directories marked', async (t) => {
    const dir = await tempDir(t);
    await mkdir(join(dir, 'b-dir'));
    await writeFile(join(dir, 'b-dir', 'inner.txt'), '');
    await writeFile(join(dir, 'a.txt'), '');
    const out = new CapturingOutput();
    await printTree(dir, out, PLAIN_STYLE, '> ');
    assert.deepEqual(out.lines, ['> a.txt', '> b-dir/', '>     inner.txt']);
  });
});

describe('TerminalApprover', () => {
  const request = approvalRequest('files__move_file', { from: 'a.txt', to: 'b' });

  for (const [answer, expected] of [['y', true], ['Yes', true], ['  y ', true], ['n', false], ['', false], ['ok', false]] as const) {
    it(`answer ${JSON.stringify(answer)} -> ${expected ? 'approved' : 'denied'}`, async () => {
      const out = new CapturingOutput();
      const approver = new TerminalApprover(new ScriptedPrompter([answer]), out, PLAIN_STYLE);
      assert.equal(await approver.approve(request), expected);
      assert.equal(out.lines.at(-1), expected ? '  approved' : '  denied');
    });
  }

  it('shows the operation and asks the question', async () => {
    const out = new CapturingOutput();
    const prompter = new ScriptedPrompter(['y']);
    await new TerminalApprover(prompter, out, PLAIN_STYLE).approve(request);
    assert.ok(out.lines.includes('│ MOVE FILE  a.txt  →  b'));
    assert.ok(out.lines.includes('│ tool: files.move_file  args: {"from":"a.txt","to":"b"}'));
    assert.deepEqual(prompter.asked, ['Allow this operation? [y/N] ']);
  });
});

describe('TerminalRunObserver', () => {
  function setup() {
    const out = new CapturingOutput();
    const observer = new TerminalRunObserver(new StatusLine(out, PLAIN_STYLE), out, PLAIN_STYLE);
    const output = new AttemptOutput();
    const feed = (item: ReturnType<typeof delta>) => { output.apply(item); observer.event(item, output); };
    return { out, observer, feed };
  }

  it('prints the agent text when a model call finishes, before its status', () => {
    const { out, feed } = setup();
    feed(runEvent({ type: 'model_attempt_started', attemptId: 'a1', attempt: 1 }));
    feed(delta('Sorting files.'));
    feed(attemptFinished());
    assert.deepEqual(out.lines, [
      '◆ status Model call #1 — agent is deciding the next step',
      '◆ status Agent is writing a message',
      'agent: Sorting files.',
      '◆ status Model call #1 finished',
    ]);
  });

  it('reports pauses and resumes', () => {
    const { out, observer } = setup();
    observer.paused(2);
    observer.resumed();
    assert.deepEqual(out.lines, [
      '◆ status Paused — 2 proposed operation(s) awaiting your approval',
      '◆ status Resuming agent loop with your decision(s)',
    ]);
  });

  it('prints the final text once, and the outcome', () => {
    const { out, observer, feed } = setup();
    feed(runEvent({ type: 'model_attempt_started', attemptId: 'a1', attempt: 1 }));
    feed(delta('Done.'));
    feed(attemptFinished());
    observer.finished(runResult(), 'Done.');
    assert.equal(out.lines.filter(l => l.startsWith('agent:')).length, 1);
    assert.equal(out.lines.at(-1), '◆ status Agent loop completed after 1 model call(s)');
  });

  it('writes failures to the error stream', () => {
    const { out, observer } = setup();
    observer.finished(runResult({
      status: 'failed', failure: 'boom', providerError: { category: 'transport', retryable: true },
    }), '');
    assert.equal(out.lines.at(-1), '◆ status Agent loop failed after 0 model call(s)');
    assert.deepEqual(out.errors, ['{"category":"transport","retryable":true}', 'failure: boom']);
  });
});
