// The use case: start the harness, set up the agent, run the organize task.
//
// Knows nothing about the terminal. The caller supplies how progress is shown
// (observer, onStatus, onToolActivity) and how approvals are decided (approver).
import { Harness } from '@openworkerai/harness-sdk';
import type { HarnessOptions, ModelProvider, RunResult } from '@openworkerai/harness-sdk';
import { ORGANIZE_TASK, organizerDefinition } from './agent.ts';
import type { DemoPaths, ModelChoice } from './config.ts';
import { createFileTools } from './file-tools.ts';
import type { ActivityListener } from './file-tools.ts';
import { runWithApprovals } from './run-loop.ts';
import type { Approver, RunObserver } from './run-loop.ts';

export interface OrganizerOptions {
  paths: DemoPaths;
  model: ModelChoice;
  provider: ModelProvider;
  observer: RunObserver;
  approver: Approver;
  onToolActivity?: ActivityListener;
  onStatus?: (text: string) => void;
  /** Aborting cancels the run (once the session exists). */
  signal?: AbortSignal;
  /** Override for tests; defaults to starting the real harness. */
  startHarness?: (options: HarnessOptions) => Promise<Harness>;
}

export async function runOrganizer(options: OrganizerOptions): Promise<RunResult> {
  const { paths, model, provider, observer, approver, signal } = options;
  const onStatus = options.onStatus ?? (() => {});
  const startHarness = options.startHarness ?? startRealHarness;

  onStatus('Starting OpenWorker harness');
  // sandbox 'off': the file tools enforce the directory scope themselves.
  const harness = await startHarness({ stateDir: paths.stateDir, sandbox: 'off' });
  try {
    await harness.setModelProvider(provider);
    const fileTools = await createFileTools(paths.workspace, options.onToolActivity);
    await harness.registerTools(fileTools);

    const definition = organizerDefinition({ provider: model.provider, name: model.name });
    const agent = harness.createAgent(definition);
    await agent.ready();
    const session = await agent.newSession({ workspace: paths.workspace, scratch: false });

    const cancel = (): void => {
      // Cancelling is best effort: the run may already be over.
      session.cancel().catch(() => {});
    };
    if (signal?.aborted) cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      onStatus('Sending task to the agent');
      return await runWithApprovals(session, ORGANIZE_TASK, observer, approver);
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  } finally {
    await harness.shutdown();
  }
}

function startRealHarness(options: HarnessOptions): Promise<Harness> {
  return Harness.start(options);
}
