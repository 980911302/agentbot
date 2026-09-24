import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { thinkingLevelsForModel } from '../src/shared/contracts/model-catalog.js';

describe('thinkingLevelsForModel', () => {
  it('offers levels from the current model, including models with no thinking', () => {
    const o3 = thinkingLevelsForModel('o3-mini');
    assert.equal(o3.supportsThinking, true);
    assert.deepEqual(
      o3.levels.map((level) => level.id),
      ['low', 'medium', 'high'],
    );
    assert.equal(o3.defaultLevel, 'medium');

    const reasoner = thinkingLevelsForModel('deepseek-reasoner');
    assert.equal(reasoner.supportsThinking, true);
    assert.ok(reasoner.levels.length >= 1);

    const chat = thinkingLevelsForModel('deepseek-chat');
    assert.equal(chat.supportsThinking, false);
    assert.equal(chat.levels.length, 0);

    const gpt = thinkingLevelsForModel('gpt-4o');
    assert.equal(gpt.supportsThinking, false);
    assert.equal(gpt.levels.length, 0);
  });
});
