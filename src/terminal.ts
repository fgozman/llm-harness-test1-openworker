// Terminal output: status lines, tool activity, approval prompts, directory trees.
// Writes through an `Output` and reads through a `Prompter`, so tests can capture both.
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttemptOutput, RunEvent, RunResult } from '@openworkerai/harness-sdk';
import type { ToolActivity } from './file-tools.ts';
import { RunProgress, UnseenText, describeOperation, summarizeResult, toolName } from './format.ts';
import type { ApprovalRequest, Approver, RunObserver } from './run-loop.ts';
import type { Style } from './style.ts';

/** Where lines go. `console` satisfies this. */
export interface Output {
  log(line?: string): void;
  error(line: string): void;
}

/** Asks the user a question. A readline Interface satisfies this. */
export interface Prompter {
  question(query: string): Promise<string>;
}

// ---------- status line ----------

/** Prints "◆ status …" lines, skipping exact repeats. */
export class StatusLine {
  #output: Output;
  #style: Style;
  #last = '';

  constructor(output: Output, style: Style) {
    this.#output = output;
    this.#style = style;
  }

  show(text: string): void {
    if (text === this.#last) return;
    this.#last = text;
    this.#output.log(`${this.#style.magenta('◆ status')} ${text}`);
  }
}

// ---------- tool activity (from the tool callbacks) ----------

export function printToolActivity(activity: ToolActivity, output: Output, style: Style): void {
  const { cyan, green, red, dim } = style;
  switch (activity.phase) {
    case 'callback':
      output.log(`  ${cyan('▶ tool')} ${activity.name} ${dim(JSON.stringify(activity.args))}`);
      break;
    case 'result': {
      const summary = summarizeResult(activity.name, activity.result);
      output.log(`  ${green('✔ done')} ${activity.name} ${dim(summary)}`);
      break;
    }
    case 'error':
      output.log(`  ${red('✖ error')} ${activity.name} ${dim(activity.error)}`);
      break;
  }
}

// ---------- directory tree ----------

export async function printTree(dir: string, output: Output, style: Style, indent = ''): Promise<void> {
  const names = await readdir(dir);
  names.sort();
  for (const name of names) {
    const path = join(dir, name);
    const stat = await lstat(path);
    if (!stat.isDirectory()) {
      output.log(indent + name);
      continue;
    }
    output.log(indent + style.bold(name + '/'));
    await printTree(path, output, style, indent + '    ');
  }
}

// ---------- run observer (from the event stream) ----------

/** Shows a run's progress as status lines and prints the agent's text as it arrives. */
export class TerminalRunObserver implements RunObserver {
  #status: StatusLine;
  #output: Output;
  #style: Style;
  #progress = new RunProgress();
  #agentText = new UnseenText();

  constructor(status: StatusLine, output: Output, style: Style) {
    this.#status = status;
    this.#output = output;
    this.#style = style;
  }

  event(item: RunEvent, output: AttemptOutput): void {
    // A finished model call may have written text: print it before its status line.
    if (item.summary?.type === 'model_attempt_finished') this.#printAgentText(output.text);

    const status = this.#progress.statusFor(item);
    if (!status) return;
    const text = status.alert ? this.#style.red(status.text) : status.text;
    this.#status.show(text);
  }

  paused(approvalCount: number): void {
    const text = `Paused — ${approvalCount} proposed operation(s) awaiting your approval`;
    this.#status.show(this.#style.yellow(text));
  }

  resumed(): void {
    this.#status.show('Resuming agent loop with your decision(s)');
  }

  finished(result: RunResult, text: string): void {
    this.#printAgentText(text);
    const paint = result.status === 'completed' ? this.#style.green : this.#style.red;
    const summary = `Agent loop ${result.status} after ${this.#progress.modelCalls} model call(s)`;
    this.#status.show(paint(summary));
    if (result.providerError) {
      const details = JSON.stringify(result.providerError);
      this.#output.error(this.#style.dim(details));
    }
    if (result.failure) this.#output.error(this.#style.dim(`failure: ${result.failure}`));
  }

  #printAgentText(text: string): void {
    const unseen = this.#agentText.take(text);
    if (unseen) this.#output.log(`${this.#style.bold('agent:')} ${unseen}`);
  }
}

// ---------- approver (y/N prompt) ----------

/** Shows each proposed operation in a box and asks "Allow this operation? [y/N]". */
export class TerminalApprover implements Approver {
  #prompter: Prompter;
  #output: Output;
  #style: Style;

  constructor(prompter: Prompter, output: Output, style: Style) {
    this.#prompter = prompter;
    this.#output = output;
    this.#style = style;
  }

  async approve(request: ApprovalRequest): Promise<boolean> {
    const { yellow, dim, green, red } = this.#style;
    const out = this.#output;

    const border = yellow('│');
    const operation = describeOperation(request.tool, request.arguments, this.#style);
    const details = `tool: ${toolName(request.tool)}  args: ${JSON.stringify(request.arguments)}`;

    out.log();
    out.log(yellow('┌─ Approval required ───────────────────────────────'));
    out.log(`${border} ${operation}`);
    out.log(`${border} ${dim(details)}`);
    out.log(yellow('└───────────────────────────────────────────────────'));

    const answer = await this.#prompter.question('Allow this operation? [y/N] ');
    const allowed = answer.trim().toLowerCase().startsWith('y');
    out.log(allowed ? green('  approved') : red('  denied'));
    return allowed;
  }
}
