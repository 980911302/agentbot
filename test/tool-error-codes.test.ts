import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { toolError } from '../src/tools/result.js';

describe('统一工具拒绝码', () => {
  it('结构化错误保留 code', () => {
    const result = toolError('CHAIN_DEPTH_EXCEEDED', '传话链已达上限');
    assert.equal(result.status, 'error');
    assert.equal(result.error?.code, 'CHAIN_DEPTH_EXCEEDED');
    assert.match(result.content, /传话链已达上限/);
  });
});
