// Runs one agent turn, pausing whenever the agent needs the user's approval.
//
// Depends only on the small interfaces below, not on the SDK's Session class
// or on any UI, so it can be driven by the real harness or by test fakes.
import { AttemptOutput } from '@openworkerai/harness-sdk';
import type { Interruption, ResumeOptions, Response, RunEvent, RunResult } from '@openworkerai/harness-sdk';

export type ApprovalRequest = Extract<Interruption, { kind: 'approval' }>;

/** A stream of run events that can report its outcome and be resumed. */
export interface EventStream extends AsyncIterable<RunEvent> {
  /** Resolves once the stream ends: completed, failed, cancelled or interrupted. */
  result(): Promise<RunResult>;
  /** Where to resume reading from after an interruption. */
  checkpoint(): ResumeOptions;
}

/** The part of an SDK Session this loop needs. */
export interface ApprovalSession {
  send(message: string): Promise<{ events(): EventStream }>;
  respond(interruption: Interruption, response: Response): Promise<void>;
  resumeStreamed(options: ResumeOptions): Promise<EventStream>;
}

/** Watches a run. All methods are notifications; none can change the run. */
export interface RunObserver {
  /** Every streamed event. `output` holds the agent's text so far. */
  event(item: RunEvent, output: AttemptOutput): void;
  /** The run paused with `approvalCount` operations awaiting approval. */
  paused(approvalCount: number): void;
  /** The run continues after the user answered. */
  resumed(): void;
  /** The run ended. `text` is the agent's final message. */
  finished(result: RunResult, text: string): void;
}

/** Decides whether a proposed operation may run. */
export interface Approver {
  approve(request: ApprovalRequest): Promise<boolean>;
}

/**
 * Sends `message` and streams the run. Whenever the agent pauses for approval,
 * asks `approver`, sends the decision, and resumes the same run.
 */
export async function runWithApprovals(
  session: ApprovalSession,
  message: string,
  observer: RunObserver,
  approver: Approver,
): Promise<RunResult> {
  const output = new AttemptOutput();
  const run = await session.send(message);
  let stream = run.events();

  while (true) {
    for await (const item of stream) {
      output.apply(item);
      observer.event(item, output);
    }
    const result = await stream.result();

    // Finished (completed, cancelled or failed).
    if (result.status !== 'interrupted') {
      if (result.status !== 'completed') output.interrupt();
      observer.finished(result, finalText(result, output));
      return result;
    }

    // Paused: ask about each pending operation.
    if (result.interruptions.length === 0) throw Error('Interrupted without a pending interaction');
    const approvals = result.interruptions.filter(interruption => interruption.kind === 'approval');
    observer.paused(approvals.length);

    for (const interruption of result.interruptions) {
      // This demo only handles approvals (askUser is off). Stop on anything else.
      if (interruption.kind !== 'approval') return result;
      const allowed = await approver.approve(interruption);
      const decision = allowed ? 'once' : 'deny';
      await session.respond(interruption, { decision });
    }

    observer.resumed();
    const checkpoint = stream.checkpoint();
    stream = await session.resumeStreamed(checkpoint);
  }
}

/** The agent's final message for a run that ended (did not pause). */
function finalText(result: RunResult, output: AttemptOutput): string {
  if (result.status !== 'completed') return output.text;
  return result.finalOutput ?? output.text;
}
