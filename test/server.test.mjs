import assert from 'node:assert/strict';
import test from 'node:test';
import { config, modelList, normalizeModelIds } from '../server.mjs';

test('normalizes OpenAI and simple model-list responses', () => {
  assert.deepEqual(normalizeModelIds({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(normalizeModelIds({ models: ['x', 'y'] }), ['x', 'y']);
});

test('keeps the default model available for fallback /v1/models', () => {
  const configured = config({ MODELS: 'model-a,model-b', DEFAULT_MODEL: 'model-a' });
  assert.deepEqual(configured.models, ['model-a', 'model-b']);
  assert.equal(modelList(configured.models).data[0].object, 'model');
});
