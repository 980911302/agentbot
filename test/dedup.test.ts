import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { contentTokens, judgeDuplicate, memoryKey } from '../src/memory/dedup.js';

/** 去重的两个方向都要测：该合并的合并，不该合并的绝不能合并 */
describe('记忆去重', () => {
  describe('应该合并（同一件事的改写）', () => {
    const cases: Array<[string, string, string]> = [
      ['用户叫张林，称呼他为张林。', '我叫张林，以后都这么叫我', '同义改写'],
      ['用户叫张林，称呼他为张林。', '用户叫张林', '缩短'],
      ['用户的名字是张林', '用户的名字是张林。', '仅标点差异'],
      ['白泽的 Redis 用 171:6379 的 db1', '白泽 Redis 统一使用 171:6379 的 db1', '微调措辞'],
    ];

    for (const [a, b, label] of cases) {
      it(label, () => {
        const verdict = judgeDuplicate(a, b);
        assert.equal(verdict.duplicate, true, `${a} ≈ ${b} 应判定为重复`);
      });
    }
  });

  describe('绝不能合并（会被误伤的对抗样本）', () => {
    it('端口不同不合并', () => {
      const verdict = judgeDuplicate('Redis 端口是 8080', 'Redis 端口是 9090');
      assert.equal(verdict.duplicate, false);
      assert.equal(verdict.reason, 'digits-conflict');
    });

    it('编号不同的压测条目不合并', () => {
      const verdict = judgeDuplicate(
        '画像压测条目第 1 号，内容各不相同 7919',
        '画像压测条目第 2 号，内容各不相同 15838',
      );
      assert.equal(verdict.duplicate, false);
    });

    it('同一主体的不同事实不合并', () => {
      const verdict = judgeDuplicate('白泽的 Redis 用 171:6379 的 db1', '白泽的 Redis 禁止回落 memory');
      assert.equal(verdict.duplicate, false);
    });

    it('同一角色的不同职责不合并', () => {
      const verdict = judgeDuplicate('测试运维负责 yaml 核对', '测试运维负责 Redis 配置');
      assert.equal(verdict.duplicate, false);
    });

    it('无关事实不合并', () => {
      const verdict = judgeDuplicate('知识库 API 走 9621', '前端开发端口 5173');
      assert.equal(verdict.duplicate, false);
    });
  });

  it('归一化键忽略标点与全角差异', () => {
    assert.equal(memoryKey('用户的名字是张林。'), memoryKey('用户的名字是张林'));
    assert.equal(memoryKey('ＡＢＣ'), memoryKey('abc'));
  });

  it('实词提取会滤掉虚词', () => {
    const tokens = contentTokens('我叫张林，以后都这么叫我');
    const joined = [...tokens].join('');
    assert.ok(!joined.includes('我'), '虚词「我」不该留在实词里');
  });
});
