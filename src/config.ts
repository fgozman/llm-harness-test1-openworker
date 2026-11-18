// Where the demo keeps its files, and which model it talks to.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelProvider } from '@openworkerai/harness-sdk';

// ---------- paths ----------

/** The project root (one level above src/). */
export const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface DemoPaths {
  /** Everything the demo writes lives here. */
  root: string;
  /** The only directory the agent can see or change. */
  workspace: string;
  /** Harness state, kept outside the agent's directory. */
  stateDir: string;
  /** Marks `root` as created by this app, and therefore safe to delete. */
  marker: string;
}

/** The demo layout under `baseDir`: ./demo/files, ./demo/state, ./demo/.openworker-demo */
export function demoPaths(baseDir: string): DemoPaths {
  const root = join(baseDir, 'demo');
  return {
    root,
    workspace: join(root, 'files'),
    stateDir: join(root, 'state'),
    marker: join(root, '.openworker-demo'),
  };
}

// ---------- environment ----------

/** Loads ~/.env into process.env, if the file exists. */
export function loadHomeEnvFile(home = homedir()): void {
  const file = join(home, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

// ---------- model ----------

export interface ModelChoice {
  provider: 'OpenAI' | 'Anthropic';
  api: 'responses' | 'anthropic';
  apiKeyEnv: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY';
  name: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const OPENAI = {
  provider: 'OpenAI',
  api: 'responses',
  apiKeyEnv: 'OPENAI_API_KEY',
  defaultName: 'gpt-6.1-terra',
} as const;

const ANTHROPIC = {
  provider: 'Anthropic',
  api: 'anthropic',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  defaultName: 'claude-sonnet-5-5',
} as const;

/**
 * Picks the model from the environment:
 * - MODEL_API=anthropic|openai forces a provider; otherwise the first API key found wins.
 * - MODEL_ID overrides the default model name.
 * Throws if the chosen provider's API key is missing.
 */
export function chooseModel(env: Env = process.env): ModelChoice {
  const api = env.MODEL_API || guessApiFromKeys(env);
  if (!api) throw Error('No OPENAI_API_KEY or ANTHROPIC_API_KEY found in ~/.env or the environment');

  // Any value other than "anthropic" means OpenAI.
  const preset = api === 'anthropic' ? ANTHROPIC : OPENAI;
  if (!env[preset.apiKeyEnv]) throw Error(`${preset.apiKeyEnv} is not set`);

  return {
    provider: preset.provider,
    api: preset.api,
    apiKeyEnv: preset.apiKeyEnv,
    name: env.MODEL_ID || preset.defaultName,
  };
}

function guessApiFromKeys(env: Env): 'openai' | 'anthropic' | undefined {
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return undefined;
}

/**
 * Provider settings for the harness. The API key stays in this process's
 * environment and is held in memory only.
 *
 * Testing only: OPENAI_BASE_URL points OpenAI at a keyless loopback Responses
 * endpoint (e.g. a deterministic mock). The harness refuses to send
 * credentials over plain HTTP, so no key is sent in that case.
 */
export function providerSettings(model: ModelChoice, env: Env = process.env): ModelProvider {
  const testUrl = env.OPENAI_BASE_URL;
  if (model.api === 'responses' && testUrl) return { name: model.provider, api: model.api, baseUrl: testUrl };

  return {
    name: model.provider,
    api: model.api,
    credentials: { apiKeyEnv: model.apiKeyEnv, storage: 'memory' },
  };
}
