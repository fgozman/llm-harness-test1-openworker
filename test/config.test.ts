import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chooseModel, demoPaths, providerSettings } from '../src/config.ts';

describe('demoPaths', () => {
  it('lays out files, state and marker under <base>/demo', () => {
    assert.deepEqual(demoPaths('/base'), {
      root: join('/base', 'demo'),
      workspace: join('/base', 'demo', 'files'),
      stateDir: join('/base', 'demo', 'state'),
      marker: join('/base', 'demo', '.openworker-demo'),
    });
  });
});

describe('chooseModel', () => {
  it('fails when no API key is present', () => {
    assert.throws(() => chooseModel({}), /No OPENAI_API_KEY or ANTHROPIC_API_KEY found/);
  });

  it('uses OpenAI when only an OpenAI key is present', () => {
    assert.deepEqual(chooseModel({ OPENAI_API_KEY: 'k' }), {
      provider: 'OpenAI', api: 'responses', apiKeyEnv: 'OPENAI_API_KEY', name: 'gpt-6.1-terra',
    });
  });

  it('uses Anthropic when only an Anthropic key is present', () => {
    assert.deepEqual(chooseModel({ ANTHROPIC_API_KEY: 'k' }), {
      provider: 'Anthropic', api: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', name: 'claude-sonnet-5-5',
    });
  });

  it('prefers OpenAI when both keys are present', () => {
    assert.equal(chooseModel({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }).provider, 'OpenAI');
  });

  it('honors MODEL_API and MODEL_ID', () => {
    const model = chooseModel({ MODEL_API: 'anthropic', MODEL_ID: 'my-model', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' });
    assert.equal(model.provider, 'Anthropic');
    assert.equal(model.name, 'my-model');
  });

  it('treats any MODEL_API other than "anthropic" as OpenAI', () => {
    assert.equal(chooseModel({ MODEL_API: 'something', OPENAI_API_KEY: 'k' }).provider, 'OpenAI');
  });

  it('fails when the forced provider has no key', () => {
    assert.throws(() => chooseModel({ MODEL_API: 'anthropic', OPENAI_API_KEY: 'k' }), /ANTHROPIC_API_KEY is not set/);
  });
});

describe('providerSettings', () => {
  const openai = chooseModel({ OPENAI_API_KEY: 'k' });
  const anthropic = chooseModel({ ANTHROPIC_API_KEY: 'k' });

  it('passes the key by env var name, memory-only, never the key itself', () => {
    assert.deepEqual(providerSettings(openai, {}), {
      name: 'OpenAI', api: 'responses',
      credentials: { apiKeyEnv: 'OPENAI_API_KEY', storage: 'memory' },
    });
  });

  it('uses OPENAI_BASE_URL without credentials for OpenAI', () => {
    assert.deepEqual(providerSettings(openai, { OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' }), {
      name: 'OpenAI', api: 'responses', baseUrl: 'http://127.0.0.1:1/v1',
    });
  });

  it('ignores OPENAI_BASE_URL for Anthropic', () => {
    const settings = providerSettings(anthropic, { OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' });
    assert.equal(settings.baseUrl, undefined);
    assert.deepEqual(settings.credentials, { apiKeyEnv: 'ANTHROPIC_API_KEY', storage: 'memory' });
  });
});
