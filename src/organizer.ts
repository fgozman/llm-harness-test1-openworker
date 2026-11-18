// OpenWorker file-organizing agent — terminal demo.
//
//   node src/organizer.ts      (or: npm start)
//
// Reads OPENAI_API_KEY or ANTHROPIC_API_KEY from ~/.env or the environment.
// Optional: MODEL_API=openai|anthropic, MODEL_ID=<exact model id>.
//
// Each run recreates ./demo/files with 10 sample text files, lets the agent
// sort them into category folders (you approve every change), and keeps the
// harness state in ./demo/state, outside the agent's directory.
//
// This file only wires the real pieces together (terminal, env, harness).
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runOrganizer } from './app.ts';
import { PROJECT_DIR, chooseModel, demoPaths, loadHomeEnvFile, providerSettings } from './config.ts';
import type { DemoPaths, ModelChoice } from './config.ts';
import { resetDemoDirectory } from './demo-files.ts';
import { errorMessage } from './errors.ts';
import { terminalStyle } from './style.ts';
import type { Style } from './style.ts';
import { StatusLine, TerminalApprover, TerminalRunObserver, printToolActivity, printTree } from './terminal.ts';
import type { Output } from './terminal.ts';

async function main(output: Output, style: Style): Promise<void> {
  loadHomeEnvFile();
  const model = chooseModel();
  const paths = demoPaths(PROJECT_DIR);
  const sampleFiles = await resetDemoDirectory(paths);
  await printIntro(output, style, paths, model, sampleFiles.length);

  const status = new StatusLine(output, style);
  const provider = providerSettings(model);
  const prompt = createInterface({ input: stdin, output: stdout });

  // First Ctrl-C cancels the run gracefully; a second one quits immediately.
  const cancellation = new AbortController();
  const onCtrlC = (): void => {
    if (cancellation.signal.aborted) process.exit(130);
    status.show(style.red('Cancelling (Ctrl-C again to force quit)…'));
    cancellation.abort();
  };
  process.on('SIGINT', onCtrlC);
  prompt.on('SIGINT', onCtrlC); // readline captures Ctrl-C while waiting for an answer

  try {
    const result = await runOrganizer({
      paths,
      model,
      provider,
      observer: new TerminalRunObserver(status, output, style),
      approver: new TerminalApprover(prompt, output, style),
      onToolActivity: activity => printToolActivity(activity, output, style),
      onStatus: text => status.show(text),
      signal: cancellation.signal,
    });

    output.log(`\n${style.bold('Final layout of')} ${paths.workspace}:`);
    await printTree(paths.workspace, output, style, '    ');
    if (result.status !== 'completed') process.exitCode = 1;
  } finally {
    process.off('SIGINT', onCtrlC);
    prompt.close();
  }
}

async function printIntro(
  output: Output, style: Style, paths: DemoPaths, model: ModelChoice, fileCount: number,
): Promise<void> {
  const { bold, dim } = style;
  output.log(bold('OpenWorker file organizer demo'));
  output.log(`${dim('demo directory:')} ${paths.workspace}`);
  output.log(`${dim('harness state: ')} ${paths.stateDir}`);
  output.log(`${dim('model:         ')} ${model.provider} / ${model.name}`);
  output.log(`${dim('created')} ${fileCount} sample files:`);
  await printTree(paths.workspace, output, style, '    ');
  output.log();
}

const isTerminal = Boolean(stdout.isTTY);
const style = terminalStyle(isTerminal);
main(console, style).catch((error: unknown) => {
  console.error(style.red(errorMessage(error)));
  process.exitCode = 1;
});
