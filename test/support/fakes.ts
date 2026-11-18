// Small test doubles shared by the unit tests.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type {
  Interruption, Json, ResumeOptions, Response, RunEvent, RunResult, ToolContext,
} from '@openworkerai/harness-sdk';
import type { ApprovalRequest, ApprovalSession, Approver, EventStream, RunObserver } from '../../src/run-loop.ts';
import type { Output, Prompter } from '../../src/terminal.ts';

/** A fresh temporary directory (symlinks resolved), deleted after the test. */
export async function tempDir(t: TestContext): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'organizer-test-'));
  const dir = await realpath(created);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Records every line written. */
export class CapturingOutput implements Output {
  lines: string[] = [];
  errors: string[] = [];
  log(line = ''): void { this.lines.push(line); }
  error(line: string): void { this.errors.push(line); }
}

/** Answers questions from a script, recording what was asked. */
export class ScriptedPrompter implements Prompter {
  asked: string[] = [];
  #answers: string[];
  constructor(answers: string[]) { this.#answers = [...answers]; }
  async question(query: string): Promise<string> {
    this.asked.push(query);
    return this.#answers.shift() ?? '';
  }
}

/** Approves or denies from a script, recording each request. */
export class ScriptedApprover implements Approver {
  requests: ApprovalRequest[] = [];
  #decisions: boolean[];
  constructor(decisions: boolean[]) { this.#decisions = [...decisions]; }
  async approve(request: ApprovalRequest): Promise<boolean> {
    this.requests.push(request);
    return this.#decisions.shift() ?? false;
  }
}

/** Records every observer call, in order. */
export class RecordingObserver implements RunObserver {
  calls: string[] = [];
  finishedWith?: { result: RunResult; text: string };
  event(item: RunEvent): void { this.calls.push(`event:${item.summary?.type ?? item.event.type}`); }
  paused(count: number): void { this.calls.push(`paused:${count}`); }
  resumed(): void { this.calls.push('resumed'); }
  finished(result: RunResult, text: string): void {
    this.calls.push(`finished:${result.status}`);
    this.finishedWith = { result, text };
  }
}

// ---------- run events ----------

let nextEventId = 1;

/** Builds a RunEvent with a summary (or a raw journal event when summary is null). */
export function runEvent(
  summary: RunEvent['summary'],
  journal: { type?: string; data?: Json } = {},
): RunEvent {
  return {
    agent: 'test-agent',
    sessionId: 's1',
    event: {
      event_id: nextEventId++,
      session_id: 's1',
      turn_id: 't1',
      type: journal.type ?? summary?.type ?? 'other',
      data: journal.data ?? null,
    },
    summary,
  };
}

export const delta = (text: string, attemptId = 'a1'): RunEvent =>
  runEvent({ type: 'assistant_delta', attemptId, text });

export const attemptFinished = (attemptId = 'a1', status: 'completed' | 'failed' = 'completed'): RunEvent =>
  runEvent({ type: 'model_attempt_finished', attemptId, status });

export function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    status: 'completed',
    finalOutput: null,
    interruptions: [],
    submissionId: null,
    cursor: 0,
    board: null,
    ...overrides,
  };
}

export function approvalRequest(tool: string, args: Json, id = 'i1'): ApprovalRequest {
  return { id, session_id: 's1', agent: 'test-agent', kind: 'approval', tool, arguments: args };
}

// ---------- session ----------

/** One scripted stream segment: the events it yields, then its result. */
export interface Segment {
  events: RunEvent[];
  result: RunResult;
}

/** A session that plays back scripted segments: send() starts the first, each resume the next. */
export class FakeSession implements ApprovalSession {
  sent: string[] = [];
  responses: { interruption: Interruption; response: Response }[] = [];
  resumedWith: ResumeOptions[] = [];
  #segments: Segment[];
  #index = 0;

  constructor(segments: Segment[]) { this.#segments = segments; }

  async send(message: string): Promise<{ events(): EventStream }> {
    this.sent.push(message);
    const stream = this.#nextStream();
    return { events: () => stream };
  }

  async respond(interruption: Interruption, response: Response): Promise<void> {
    this.responses.push({ interruption, response });
  }

  async resumeStreamed(options: ResumeOptions): Promise<EventStream> {
    this.resumedWith.push(options);
    return this.#nextStream();
  }

  #nextStream(): EventStream {
    const index = this.#index++;
    const segment = this.#segments[index];
    if (!segment) throw Error(`No scripted segment #${index}`);
    return {
      async *[Symbol.asyncIterator]() { yield* segment.events; },
      result: async () => segment.result,
      checkpoint: () => ({ cursors: { s1: index } }),
    };
  }
}

// ---------- tool context ----------

export function toolContext(workspace: string, overrides: Partial<ToolContext> = {}): ToolContext & { progressMessages: string[] } {
  const progressMessages: string[] = [];
  return {
    sessionId: 's1',
    turnId: 't1',
    callId: 'c1',
    workspace,
    signal: new AbortController().signal,
    progress: async (message: string) => { progressMessages.push(message); },
    progressMessages,
    ...overrides,
  };
}
