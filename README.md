# OpenWorker file organizer (terminal demo)

A small agent built on `@openworkerai/harness-sdk@0.1.0-beta.4`. It organizes ten
sample text files into category subdirectories and asks you to approve every
directory creation and every file move.

## Run

```sh
npm install
# ~/.env must contain OPENAI_API_KEY=...  (or ANTHROPIC_API_KEY=...)
npm start          # node src/organizer.ts
npm test           # node --test: unit + integration tests
npm run typecheck  # tsc --noEmit, strict
npm run check      # typecheck, then test
```

The app is TypeScript, run directly by Node ≥ 22.18 through its built-in type
stripping, so there is no build step and no emitted JavaScript. `tsc` is used
only for type-checking, against the SDK's bundled `.d.ts` types. Because Node
only strips types, code must use erasable syntax: no `enum`, `namespace` or
parameter properties, `import type` for type-only imports, and `.ts` extensions
in relative imports. `tsconfig.json` enforces all of this.

- OpenAI key → model `gpt-6.1-terra` (Responses API)
- Anthropic key only → model `claude-sonnet-5-5`
- Overrides: `MODEL_API=anthropic|openai`, `MODEL_ID=<exact model id>`

Each run recreates `./demo/files` with 10 sample files with vague names
(the agent must read them to classify them). Harness state lives in `./demo/state`,
outside the agent's directory. Answer `y` to approve an operation, anything else
denies it. Ctrl-C cancels the run.

## Layout

```
src/
  organizer.ts   entry point: creates the real terminal, env and harness pieces and connects them; Ctrl-C
  app.ts         runOrganizer(): start harness, register tools, create agent, run the task
  run-loop.ts    runWithApprovals(): stream a run, pause for approvals, resume
  agent.ts       agent definition, instructions and task prompt (pure data)
  file-tools.ts  the five files.* tools, each a self-contained FileToolSpec
  path-scope.ts  PathScope: confines model-supplied paths to the demo directory
  config.ts      demo paths, ~/.env loading, model choice, provider settings
  demo-files.ts  the 10 sample files and the safe demo reset
  format.ts      pure text formatting: operation descriptions, result summaries, run progress
  terminal.ts    terminal I/O: status line, tool activity, observer, y/N approver, tree
  style.ts       ANSI colors (or plain text when not a TTY)
test/
  *.test.ts                      unit tests, one file per module
  organizer.integration.test.ts  real harness binary + mock Responses API, no key needed
  support/                       fakes and the mock model server
```

### Design

- **Single responsibility.** Each module does one job: path safety (`PathScope`)
  is separate from the tools, pure formatting (`format.ts`) from terminal I/O
  (`terminal.ts`), and the use case (`app.ts`) from the entry point that
  connects the real pieces (`organizer.ts`).
- **Open for extension.** A tool is one `FileToolSpec` entry in `FILE_TOOLS`. Its
  `mutating` flag decides whether it needs approval. The agent's tool list and
  approval policy are derived from it, never listed twice. Display text for a
  new tool is one entry in `format.ts`'s describer/summarizer tables.
- **Small interfaces.** The run loop depends on `ApprovalSession`, `RunObserver`
  and `Approver`; the terminal code on `Output` and `Prompter`. The real SDK
  `Session`, `console` and readline satisfy them; tests use fakes.
- **Dependencies passed in.** Paths, environment, output, prompts, styling and
  even the harness factory are parameters, so every module is testable in
  isolation and nothing reads globals except `organizer.ts`.

## Scope and approvals

- Every tool path goes through `PathScope.resolve()`. It accepts only relative paths, rejects
  `..`, absolute paths and symlinks, checks both ends of a move, and verifies that
  the session workspace is the demo directory. Moves never overwrite files. The
  agent has no shell tool.
- `approvals: { mode: 'only', tools: [create_directory, delete_directory, move_file] }`:
  reads and listings run without asking. Each change is approved `once`, so you
  get a separate prompt for every operation.
- This scope is enforced by the app, not by the OS (`sandbox: 'off'`).
