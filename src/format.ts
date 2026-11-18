// Pure presentation logic: turns tool calls, results and run events into text.
// Nothing here prints; terminal.ts decides where the text goes.
import type { Json, RunEvent } from '@openworkerai/harness-sdk';
import type { FileEntry } from './file-tools.ts';
import type { Style } from './style.ts';

// ---------- small helpers ----------

/** "files__move_file" (wire name) -> "files.move_file" (display name). */
export function toolName(name: unknown): string {
  const wireName = String(name ?? '?');
  return wireName.replace('__', '.');
}

/** Shortens text to at most `max` characters. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/** Reads a JSON value as an object; anything else becomes {}. */
export function asObject(value: Json | undefined): Record<string, Json> {
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  return isObject ? value : {};
}

/** The first line of `text`. */
function firstLine(text: string): string {
  const [line = ''] = text.split('\n');
  return line;
}

// ---------- approvals: what is the agent asking to do? ----------

type Describer = (args: Record<string, Json>, style: Style) => string;

/** How to describe each operation that needs approval. Add an entry for a new tool. */
const OPERATION_DESCRIBERS: Record<string, Describer> = {
  'files.create_directory': ({ path }, { bold }) => `CREATE DIRECTORY  ${bold(path + '/')}`,
  'files.delete_directory': ({ path }, { bold }) => `DELETE EMPTY DIRECTORY  ${bold(path + '/')}`,
  'files.move_file': ({ from, to }, { bold }) => `MOVE FILE  ${bold(from)}  →  ${bold(to)}`,
};

/** Human-readable description of an operation waiting for approval. */
export function describeOperation(tool: string, args: Json, style: Style): string {
  const name = toolName(tool);
  const describe = OPERATION_DESCRIBERS[name];
  if (!describe) return `${name} ${JSON.stringify(args)}`;
  return describe(asObject(args), style);
}

// ---------- tool results: one-line summaries ----------

/** Returns a summary, or undefined to fall back to the raw JSON. */
type Summarizer = (result: Json) => string | undefined;

/** How to summarize each tool's result. Add an entry for a new tool. */
const RESULT_SUMMARIZERS: Record<string, Summarizer> = {
  'files.list_files': (result) => {
    if (!Array.isArray(result)) return undefined;
    const entries = result as unknown as FileEntry[];
    const names = entries.map(entryLabel).join(', ');
    return `${entries.length} entries: ${clip(names, 120)}`;
  },
  'files.read_file': (result) => {
    const text = asObject(result).text;
    if (typeof text !== 'string') return undefined;
    const preview = clip(firstLine(text), 60);
    return `${text.length} chars — "${preview}"`;
  },
};

/** "notes" for a file, "notes/" for a directory. */
function entryLabel(entry: FileEntry): string {
  return entry.directory ? entry.name + '/' : entry.name;
}

/** One-line summary of a tool result. */
export function summarizeResult(tool: string, result: Json): string {
  const summary = RESULT_SUMMARIZERS[tool]?.(result);
  if (summary !== undefined) return summary;
  return clip(JSON.stringify(result), 120);
}

// ---------- run progress: status lines from the event stream ----------

export interface Status {
  text: string;
  /** Something went wrong; show it prominently. */
  alert?: boolean;
}

/** Turns run events into status lines. Keeps count of model calls. */
export class RunProgress {
  #modelCalls = 0;
  #announcedWriting = false; // "Agent is writing" shown for the current model call

  get modelCalls(): number {
    return this.#modelCalls;
  }

  /** The status line for an event, or undefined if the event isn't worth showing. */
  statusFor(item: RunEvent): Status | undefined {
    const summary = item.summary;

    // Events without a summary: only tool starts are interesting.
    if (!summary) {
      if (item.event.type !== 'tool_started') return undefined;
      const tool = asObject(item.event.data).name;
      return { text: `Running tool ${toolName(tool)}` };
    }

    switch (summary.type) {
      case 'model_attempt_started': {
        this.#modelCalls++;
        this.#announcedWriting = false;
        const retry = summary.attempt > 1 ? ` (retry ${summary.attempt})` : '';
        return { text: `Model call #${this.#modelCalls}${retry} — agent is deciding the next step` };
      }
      case 'model_activity': {
        const seconds = Math.round(summary.elapsedMs / 1000);
        return { text: `Waiting on model call #${this.#modelCalls} (${seconds}s)` };
      }
      case 'assistant_delta':
        if (this.#announcedWriting) return undefined;
        this.#announcedWriting = true;
        return { text: 'Agent is writing a message' };
      case 'model_attempt_finished': {
        if (summary.status !== 'failed') return { text: `Model call #${this.#modelCalls} finished` };
        const reason = summary.failure ?? 'unknown';
        return { text: `Model call #${this.#modelCalls} failed (${reason})`, alert: true };
      }
      case 'provider_error': {
        const { category, httpStatus } = summary.diagnostic;
        const httpPart = httpStatus ? ` HTTP ${httpStatus}` : '';
        return { text: `Provider error: ${category}${httpPart}`, alert: true };
      }
      case 'auto_approved':
        return { text: `${toolName(summary.tool)} allowed by policy (read-only, no approval needed)` };
      case 'tool_started':
        return { text: `Running tool ${toolName(summary.tool)}` };
      case 'tool_finished':
        return { text: `Tool ${toolName(summary.tool)} finished — returning result to the model` };
      default:
        return undefined;
    }
  }
}

// ---------- agent text: print each part once ----------

/**
 * Tracks which part of the agent's text has been shown. The text grows as the
 * agent writes; if it stops being an extension of what was shown (e.g. a failed
 * attempt was discarded), the whole text is shown again on a new line.
 */
export class UnseenText {
  #shown = '';

  /** Returns the part of `text` not shown yet (trimmed), or undefined if nothing new. */
  take(text: string): string | undefined {
    if (!text || text === this.#shown) return undefined;
    const continuesShownText = text.startsWith(this.#shown);
    const unseen = continuesShownText ? text.slice(this.#shown.length) : '\n' + text;
    this.#shown = text;

    const trimmed = unseen.trim();
    return trimmed === '' ? undefined : trimmed;
  }
}
