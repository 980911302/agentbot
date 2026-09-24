import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pickerOptionsFromProviders } from '../src/shared/contracts/model-catalog.js';

describe('pickerOptionsFromProviders', () => {
  it('lists enabled-provider models and does not inject Chat/Reasoner catalog', () => {
    const options = pickerOptionsFromProviders([
      {
        id: 'p-local',
        name: '本地',
        enabled: true,
        models: [{ id: 'm-glm', model: 'glm-5.2', name: 'glm-5.2' }],
      },
      {
        id: 'p-go',
        name: 'go套餐',
        enabled: true,
        models: [{ id: 'm-flash', model: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }],
      },
      {
        id: 'p-off',
        name: 'BigModel',
        enabled: false,
        models: [{ id: 'm-plus', model: 'glm-4-plus', name: 'glm-4-plus' }],
      },
    ]);

    const ids = options.map((item) => item.id);
    const labels = options.map((item) => item.label);
    assert.ok(ids.includes('glm-5.2'));
    assert.ok(ids.includes('deepseek-v4-flash'));
    assert.equal(ids.includes('glm-4-plus'), false);
    assert.equal(
      options.some((item) => item.id === 'deepseek-chat' && item.label === 'Chat'),
      false,
    );
    assert.equal(
      options.some((item) => item.id === 'deepseek-reasoner' && item.label === 'Reasoner'),
      false,
    );
    assert.equal(labels.includes('Chat'), false);
    assert.equal(labels.includes('Reasoner'), false);

    const glm = options.find((item) => item.id === 'glm-5.2');
    assert.equal(glm?.hint, '本地');
    assert.equal(glm?.providerId, 'p-local');
    assert.equal(glm?.modelConfigId, 'm-glm');
  });
});
