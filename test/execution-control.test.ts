import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  CHAIN_BUDGET_DEFAULTS,
  CONTROL_SCHEMA_VERSION,
  mayAutoActivate,
  type AgentControl,
  type ActivationGrant,
} from '../src/shared/contracts/execution-control.js';

function control(partial: Partial<AgentControl> = {}): AgentControl {
  return {
    agentId: 'agent-a',
    generation: 1,
    autoActivation: 'enabled',
    revision: 1,
    ...partial,
  };
}

describe('执行控制契约', () => {
  it('暴露控制存储 schema 版本与可配置链预算默认值', () => {
    assert.equal(CONTROL_SCHEMA_VERSION, 1);
    assert.equal(CHAIN_BUDGET_DEFAULTS.maxAutomaticRunsPerChain, 24);
    assert.equal(CHAIN_BUDGET_DEFAULTS.maxDeliveryActionsPerChain, 24);
    assert.equal(CHAIN_BUDGET_DEFAULTS.maxRecipientDeliveriesPerChain, 48);
    assert.equal(CHAIN_BUDGET_DEFAULTS.maxRepeatedNoProgress, 3);
  });

  it('paused 主体即使根链较新也不自动准入', () => {
    assert.equal(
      mayAutoActivate({
        control: control({ autoActivation: 'paused', blockedAutoRootsThroughSeq: 10 }),
        rootCreatedSeq: 11,
      }),
      false,
    );
  });

  it('仅 enabled 不够：旧根链序号仍拒绝自动准入', () => {
    assert.equal(
      mayAutoActivate({
        control: control({ blockedAutoRootsThroughSeq: 10 }),
        rootCreatedSeq: 10,
      }),
      false,
    );
    assert.equal(
      mayAutoActivate({
        control: control({ blockedAutoRootsThroughSeq: 10 }),
        rootCreatedSeq: 9,
      }),
      false,
    );
  });

  it('enabled 且根链序号晚于停止边界才允许自动准入', () => {
    assert.equal(
      mayAutoActivate({
        control: control({ blockedAutoRootsThroughSeq: 10 }),
        rootCreatedSeq: 11,
      }),
      true,
    );
  });

  it('缺少可信根序号的旧链，在曾经停止后不自动准入', () => {
    assert.equal(
      mayAutoActivate({
        control: control({ autoActivation: 'enabled', blockedAutoRootsThroughSeq: 10 }),
      }),
      false,
    );
  });

  it('从未停止的主体允许自动准入', () => {
    assert.equal(
      mayAutoActivate({
        control: control({ autoActivation: 'enabled' }),
      }),
      true,
    );
  });

  it('覆盖该主体及本项输入的有效 grant 允许准入，即使根链较旧', () => {
    const grant: ActivationGrant = {
      grantId: 'g1',
      agentId: 'agent-a',
      generation: 1,
      issuedByCommandId: 'cmd-1',
      issuedSeq: 20,
      scope: { kind: 'chain', chainId: 'chain-old' },
      state: 'active',
    };
    assert.equal(
      mayAutoActivate({
        control: control({ autoActivation: 'paused', generation: 1, blockedAutoRootsThroughSeq: 99 }),
        rootCreatedSeq: 1,
        chainId: 'chain-old',
        grant,
      }),
      true,
    );
  });

  it('grant 不能跨主体或已撤销后继续准入', () => {
    assert.equal(
      mayAutoActivate({
        control: control({ autoActivation: 'paused' }),
        chainId: 'chain-old',
        grant: {
          grantId: 'g1',
          agentId: 'agent-b',
          generation: 1,
          issuedByCommandId: 'cmd-1',
          issuedSeq: 20,
          scope: { kind: 'chain', chainId: 'chain-old' },
          state: 'active',
        },
      }),
      false,
    );
    assert.equal(
      mayAutoActivate({
        control: control({ autoActivation: 'paused', generation: 2 }),
        chainId: 'chain-old',
        grant: {
          grantId: 'g1',
          agentId: 'agent-a',
          generation: 1,
          issuedByCommandId: 'cmd-1',
          issuedSeq: 20,
          scope: { kind: 'chain', chainId: 'chain-old' },
          state: 'active',
        },
      }),
      false,
    );
  });

  it('held 或 cancelled 处置即使满足其它条件也不自动准入', () => {
    assert.equal(
      mayAutoActivate({
        control: control({ blockedAutoRootsThroughSeq: 1 }),
        rootCreatedSeq: 2,
        disposition: 'held',
      }),
      false,
    );
    assert.equal(
      mayAutoActivate({
        control: control({ blockedAutoRootsThroughSeq: 1 }),
        rootCreatedSeq: 2,
        disposition: 'cancelled',
      }),
      false,
    );
  });
});
