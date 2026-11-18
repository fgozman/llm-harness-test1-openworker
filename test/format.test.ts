import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RunProgress, UnseenText, asObject, clip, describeOperation, summarizeResult, toolName,
} from '../src/format.ts';
import { PLAIN_STYLE } from '../src/style.ts';
import { attemptFinished, delta, runEvent } from './support/fakes.ts';

describe('helpers', () => {
  it('toolName converts wire names to display names', () => {
    assert.equal(toolName('files__move_file'), 'files.move_file');
    assert.equal(toolName('files.move_file'), 'files.move_file');
    assert.equal(toolName(undefined), '?');
  });

  it('clip shortens long text with an ellipsis', () => {
    assert.equal(clip('abcdef', 10), 'abcdef');
    assert.equal(clip('abcdef', 4), 'abc…');
    assert.equal(clip('abcdef', 4).length, 4);
  });

  it('asObject only accepts plain objects', () => {
    assert.deepEqual(asObject({ a: 1 }), { a: 1 });
    assert.deepEqual(asObject([1]), {});
    assert.deepEqual(asObject(null), {});
    assert.deepEqual(asObject('x'), {});
  });
});

describe('describeOperation', () => {
  const describe_ = (tool: string, args: Parameters<typeof describeOperation>[1]) =>
    describeOperation(tool, args, PLAIN_STYLE);

  it('describes each mutating tool', () => {
    assert.equal(describe_('files__create_directory', { path: 'travel' }), 'CREATE DIRECTORY  travel/');
    assert.equal(describe_('files__delete_directory', { path: 'old' }), 'DELETE EMPTY DIRECTORY  old/');
    assert.equal(describe_('files__move_file', { from: 'a.txt', to: 'b' }), 'MOVE FILE  a.txt  →  b');
  });

  it('falls back to the name and JSON for unknown tools', () => {
    assert.equal(describe_('other__tool', { x: 1 }), 'other.tool {"x":1}');
  });
});

describe('summarizeResult', () => {
  it('summarizes a listing', () => {
    const result = [{ name: 'a.txt', directory: false }, { name: 'sub', directory: true }];
    assert.equal(summarizeResult('files.list_files', result), '2 entries: a.txt, sub/');
  });

  it('summarizes a read with length and first line', () => {
    assert.equal(summarizeResult('files.read_file', { text: 'Title\nbody' }), '10 chars — "Title"');
  });

  it('falls back to clipped JSON', () => {
    assert.equal(summarizeResult('files.move_file', { moved: true }), '{"moved":true}');
    assert.equal(summarizeResult('files.read_file', { other: 1 }), '{"other":1}');
    assert.equal(summarizeResult('x', 'y'.repeat(200)).length, 120);
  });
});

describe('RunProgress', () => {
  it('numbers model calls and notes retries', () => {
    const progress = new RunProgress();
    assert.deepEqual(progress.statusFor(runEvent({ type: 'model_attempt_started', attemptId: 'a', attempt: 1 })),
      { text: 'Model call #1 — agent is deciding the next step' });
    assert.deepEqual(progress.statusFor(runEvent({ type: 'model_attempt_started', attemptId: 'b', attempt: 2 })),
      { text: 'Model call #2 (retry 2) — agent is deciding the next step' });
    assert.equal(progress.modelCalls, 2);
  });

  it('announces writing once per model call', () => {
    const progress = new RunProgress();
    progress.statusFor(runEvent({ type: 'model_attempt_started', attemptId: 'a', attempt: 1 }));
    assert.deepEqual(progress.statusFor(delta('a')), { text: 'Agent is writing a message' });
    assert.equal(progress.statusFor(delta('b')), undefined);
    progress.statusFor(runEvent({ type: 'model_attempt_started', attemptId: 'b', attempt: 1 }));
    assert.deepEqual(progress.statusFor(delta('c')), { text: 'Agent is writing a message' });
  });

  it('flags failures and provider errors', () => {
    const progress = new RunProgress();
    assert.deepEqual(progress.statusFor(attemptFinished('a', 'failed')),
      { text: 'Model call #0 failed (unknown)', alert: true });
    assert.deepEqual(progress.statusFor(runEvent({
      type: 'provider_error', attemptId: 'a', diagnostic: { category: 'rate_limit', retryable: true, httpStatus: 429 },
    })), { text: 'Provider error: rate_limit HTTP 429', alert: true });
  });

  it('describes tool events and waiting time', () => {
    const progress = new RunProgress();
    assert.equal(progress.statusFor(runEvent({ type: 'auto_approved', tool: 'files__list_files' }))?.text,
      'files.list_files allowed by policy (read-only, no approval needed)');
    assert.equal(progress.statusFor(runEvent({ type: 'tool_started', tool: 'files__x', callId: 'c' }))?.text,
      'Running tool files.x');
    assert.equal(progress.statusFor(runEvent({ type: 'tool_finished', tool: 'files__x', callId: 'c' }))?.text,
      'Tool files.x finished — returning result to the model');
    assert.equal(progress.statusFor(runEvent({ type: 'model_activity', attemptId: 'a', elapsedMs: 2600 }))?.text,
      'Waiting on model call #0 (3s)');
  });

  it('uses raw tool_started events and ignores other raw events', () => {
    const progress = new RunProgress();
    assert.equal(progress.statusFor(runEvent(null, { type: 'tool_started', data: { name: 'files__y' } }))?.text,
      'Running tool files.y');
    assert.equal(progress.statusFor(runEvent(null, { type: 'something_else' })), undefined);
    assert.equal(progress.statusFor(runEvent({ type: 'message', text: 'hi' })), undefined);
  });
});

describe('UnseenText', () => {
  it('returns only new text as it grows', () => {
    const unseen = new UnseenText();
    assert.equal(unseen.take('Hello'), 'Hello');
    assert.equal(unseen.take('Hello world'), 'world');
    assert.equal(unseen.take('Hello world'), undefined);
  });

  it('ignores empty and whitespace-only additions', () => {
    const unseen = new UnseenText();
    assert.equal(unseen.take(''), undefined);
    unseen.take('a');
    assert.equal(unseen.take('a   '), undefined);
  });

  it('returns the whole text when it was replaced', () => {
    const unseen = new UnseenText();
    unseen.take('first attempt');
    assert.equal(unseen.take('second'), 'second');
  });
});
