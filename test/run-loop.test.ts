import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Interruption } from '@openworkerai/harness-sdk';
import { runWithApprovals } from '../src/run-loop.ts';
import {
  FakeSession, RecordingObserver, ScriptedApprover, approvalRequest, attemptFinished, delta, runEvent, runResult,
} from './support/fakes.ts';

const createDir = approvalRequest('files__create_directory', { path: 'travel' }, 'i1');
const moveFile = approvalRequest('files__move_file', { from: 'a.txt', to: 'travel' }, 'i2');
const interrupted = (...interruptions: Interruption[]) => runResult({ status: 'interrupted', interruptions });

describe('runWithApprovals', () => {
  it('streams a run that completes without approvals', async () => {
    const session = new FakeSession([{
      events: [delta('Hello'), attemptFinished()],
      result: runResult({ finalOutput: 'Hello, final' }),
    }]);
    const observer = new RecordingObserver();

    const result = await runWithApprovals(session, 'do it', observer, new ScriptedApprover([]));

    assert.equal(result.status, 'completed');
    assert.deepEqual(session.sent, ['do it']);
    assert.deepEqual(observer.calls, ['event:assistant_delta', 'event:model_attempt_finished', 'finished:completed']);
    assert.equal(observer.finishedWith?.text, 'Hello, final');
  });

  it('falls back to the streamed text when there is no final output', async () => {
    const session = new FakeSession([{ events: [delta('streamed'), attemptFinished()], result: runResult() }]);
    const observer = new RecordingObserver();
    await runWithApprovals(session, 'x', observer, new ScriptedApprover([]));
    assert.equal(observer.finishedWith?.text, 'streamed');
  });

  it('asks about each pending operation, sends decisions, and resumes from the checkpoint', async () => {
    const session = new FakeSession([
      { events: [], result: interrupted(createDir, moveFile) },
      { events: [], result: runResult({ finalOutput: 'done' }) },
    ]);
    const observer = new RecordingObserver();
    const approver = new ScriptedApprover([true, false]);

    const result = await runWithApprovals(session, 'x', observer, approver);

    assert.equal(result.status, 'completed');
    assert.deepEqual(approver.requests.map(r => r.id), ['i1', 'i2']);
    assert.deepEqual(session.responses.map(r => [r.interruption.id, r.response]), [
      ['i1', { decision: 'once' }],
      ['i2', { decision: 'deny' }],
    ]);
    assert.deepEqual(session.resumedWith, [{ cursors: { s1: 0 } }]);
    assert.deepEqual(observer.calls, ['paused:2', 'resumed', 'finished:completed']);
  });

  it('handles several pauses in one run', async () => {
    const session = new FakeSession([
      { events: [], result: interrupted(createDir) },
      { events: [], result: interrupted(moveFile) },
      { events: [], result: runResult() },
    ]);
    const approver = new ScriptedApprover([true, true]);
    await runWithApprovals(session, 'x', new RecordingObserver(), approver);
    assert.equal(approver.requests.length, 2);
    assert.deepEqual(session.resumedWith, [{ cursors: { s1: 0 } }, { cursors: { s1: 1 } }]);
  });

  it('stops (without resuming) on an interruption it cannot handle', async () => {
    const question: Interruption = { id: 'q', session_id: 's1', agent: 'a', kind: 'question', question: '?', options: [] };
    const session = new FakeSession([{ events: [], result: interrupted(question) }]);

    const result = await runWithApprovals(session, 'x', new RecordingObserver(), new ScriptedApprover([]));

    assert.equal(result.status, 'interrupted');
    assert.equal(session.resumedWith.length, 0);
  });

  it('throws if interrupted with nothing pending', async () => {
    const session = new FakeSession([{ events: [], result: interrupted() }]);
    await assert.rejects(
      runWithApprovals(session, 'x', new RecordingObserver(), new ScriptedApprover([])),
      /Interrupted without a pending interaction/);
  });

  it('discards half-written text when a run fails', async () => {
    const session = new FakeSession([{
      events: [runEvent({ type: 'model_attempt_started', attemptId: 'a1', attempt: 1 }), delta('partial')],
      result: runResult({ status: 'failed', failure: 'boom', finalOutput: 'ignored' }),
    }]);
    const observer = new RecordingObserver();

    const result = await runWithApprovals(session, 'x', observer, new ScriptedApprover([]));

    assert.equal(result.status, 'failed');
    assert.equal(observer.finishedWith?.text, '');
  });
});
