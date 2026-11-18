// The agent's filesystem tools.
//
// Each tool is a self-contained spec (`FileToolSpec`). To add a tool, add a spec
// to FILE_TOOLS: registration, approval policy and the tool list given to the
// agent all derive from that list. Paths are always resolved through a
// `PathScope`, so no tool can reach outside the demo directory.
//
// Adapted from the openworker-harness-builder bundled sample.
import { readdir, readFile, mkdir, rmdir, link, unlink, lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ApplicationTool, ApplicationTools, Json, ToolContext } from '@openworkerai/harness-sdk';
import { errorMessage } from './errors.ts';
import { PathScope } from './path-scope.ts';

// ---------- types shared with the UI ----------

/** Identifies one tool call. Callbacks can arrive before the matching journal event. */
export interface CallIds {
  sessionId: string;
  turnId: string;
  callId: string;
}

/** Reported to the UI as each tool call starts, succeeds or fails. */
export type ToolActivity = CallIds & (
  | { phase: 'callback'; name: string; args: Record<string, Json> }
  | { phase: 'result'; name: string; result: Json }
  | { phase: 'error'; name: string; error: string }
);

export type ActivityListener = (activity: ToolActivity) => void;

// Result shapes are type aliases (not interfaces) so they stay assignable to Json.

/** One entry returned by files.list_files. */
export type FileEntry = { name: string; directory: boolean };

/** Returned by files.read_file. */
export type ReadFileResult = { text: string };

// ---------- tool specs ----------

export type ToolArgs = Record<string, Json>;

export interface FileToolSpec {
  /** Short name; the agent sees it as `files.<name>`. */
  name: string;
  description: string;
  inputSchema: Json;
  /** True if the tool changes the disk. Such tools need the user's approval. */
  mutating: boolean;
  run(args: ToolArgs, scope: PathScope): Promise<Json>;
}

export const FILE_TOOL_NAMESPACE = 'files';

export const MAX_LISTED_ENTRIES = 100;
export const MAX_READ_BYTES = 64 * 1024;

/** JSON Schema for an object whose listed properties are all required. */
const objectSchema = (properties: Record<string, Json>): Json => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const STRING: Json = { type: 'string' };
const PATH_ARGS = objectSchema({ path: STRING });
const MOVE_ARGS = objectSchema({ from: STRING, to: STRING });

const listFiles: FileToolSpec = {
  name: 'list_files',
  description: 'List one directory inside the demo directory. Use "." for its root.',
  inputSchema: PATH_ARGS,
  mutating: false,
  async run({ path }, scope) {
    const directory = await scope.resolve(path);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_LISTED_ENTRIES) throw Error('Demo directory has too many entries');

    const result: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      result.push({ name: entry.name, directory: entry.isDirectory() });
    }
    return result;
  },
};

const readTextFile: FileToolSpec = {
  name: 'read_file',
  description: 'Read a UTF-8 text file inside the demo directory (max 64 KiB).',
  inputSchema: PATH_ARGS,
  mutating: false,
  async run({ path }, scope) {
    const file = await scope.resolve(path);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) throw Error('Expected a small regular file');

    const text = await readFile(file, 'utf8');
    const result: ReadFileResult = { text };
    return result;
  },
};

const createDirectory: FileToolSpec = {
  name: 'create_directory',
  description: 'Create one subdirectory inside the demo directory. Requires user approval.',
  inputSchema: PATH_ARGS,
  mutating: true,
  async run({ path }, scope) {
    const directory = await scope.resolve(path, { allowMissing: true });
    await mkdir(directory);
    return { created: path ?? null };
  },
};

const deleteEmptyDirectory: FileToolSpec = {
  name: 'delete_directory',
  description: 'Remove an EMPTY subdirectory inside the demo directory. Requires user approval.',
  inputSchema: PATH_ARGS,
  mutating: true,
  async run({ path }, scope) {
    const target = await scope.resolve(path);
    if (target === scope.root) throw Error('Cannot remove the demo root');
    await rmdir(target); // fails unless the directory is empty
    return { removed: path ?? null };
  },
};

const moveFile: FileToolSpec = {
  name: 'move_file',
  description:
    'Move one file to a new path inside the demo directory (e.g. from "a.txt" to "notes/a.txt"). ' +
    'Never overwrites. Requires user approval.',
  inputSchema: MOVE_ARGS,
  mutating: true,
  async run({ from, to }, scope): Promise<Json> {
    const source = await scope.resolve(from);
    let destination = await scope.resolve(to, { allowMissing: true });

    // Moving into an existing directory keeps the file name.
    if (await isDirectory(destination)) {
      const inside = join(destination, basename(source));
      const insideRelative = scope.toRelative(inside);
      destination = await scope.resolve(insideRelative, { allowMissing: true });
    }

    const sourceStat = await lstat(source);
    if (!sourceStat.isFile()) throw Error('Expected a regular file');

    // link() fails if the destination exists, so a move never overwrites a file.
    await link(source, destination);
    try {
      await unlink(source);
    } catch {
      return {
        completed: false,
        destinationCreated: true,
        sourceRetained: true,
        message: 'Both paths may exist. Inspect them before any retry.',
      };
    }
    const moved = { from: from ?? null, to: scope.toRelative(destination) };
    return { moved };
  },
};

/** True if `path` exists and is a directory (symlinks are not followed). */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/** All file tools, in the order they are registered. */
export const FILE_TOOLS: readonly FileToolSpec[] = [
  listFiles, readTextFile, createDirectory, deleteEmptyDirectory, moveFile,
];

/** "list_files" -> "files.list_files", the name used in agent definitions. */
export const qualifiedName = (spec: FileToolSpec): string => `${FILE_TOOL_NAMESPACE}.${spec.name}`;

// ---------- registration ----------

/**
 * Builds the tool registration for the harness. Every call checks the
 * session's workspace, reports activity, and hides host paths from errors.
 */
export async function createFileTools(
  directory: string,
  onActivity: ActivityListener = () => {},
  specs: readonly FileToolSpec[] = FILE_TOOLS,
): Promise<ApplicationTools> {
  const scope = await PathScope.open(directory);
  const tools: Record<string, ApplicationTool> = {};
  for (const spec of specs) {
    tools[spec.name] = wrapTool(spec, scope, onActivity);
  }
  return { namespace: FILE_TOOL_NAMESPACE, tools };
}

function wrapTool(spec: FileToolSpec, scope: PathScope, onActivity: ActivityListener): ApplicationTool {
  const name = qualifiedName(spec);
  return {
    description: spec.description,
    inputSchema: spec.inputSchema,
    async execute(args: ToolArgs, context: ToolContext): Promise<Json> {
      context.signal.throwIfAborted();
      const inScope = await scope.contains(context.workspace);
      if (!inScope) throw Error('Wrong workspace');

      const ids: CallIds = {
        sessionId: context.sessionId,
        turnId: context.turnId,
        callId: context.callId,
      };
      onActivity({ phase: 'callback', name, args, ...ids });
      await context.progress(`Running ${name}`);

      try {
        const result = await spec.run(args, scope);
        onActivity({ phase: 'result', name, result, ...ids });
        return result;
      } catch (error) {
        const message = scope.redact(errorMessage(error));
        onActivity({ phase: 'error', name, error: message, ...ids });
        throw Error(message);
      }
    },
  };
}
