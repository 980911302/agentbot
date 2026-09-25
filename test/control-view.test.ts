import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  controlNoticeState,
  controlStatusText,
  repairOutcomeMessage,
  resumeOutcomeMessage,
  retryOutcomeMessage,
  type ControlNoticeInput,
} from '../web/src/features/chat/control-view.js';

const base: ControlNoticeInput = {
  autoActivation: 'enabled',
  held: 0,
  faulted: false,
  pendingMail: 0,
  failedMail: 0,
  stopInFlight: false,
};

describe('controlNoticeState：控制状态条', () => {
  it('全部正常时不显示', () => {
    assert.equal(controlNoticeState(base), null);
  });

  it('控制存储损坏优先：这是最要命的状态', () => {
    const state = controlNoticeState({ ...base, faulted: true, autoActivation: 'paused', held: 3 });
    assert.equal(state?.kind, 'faulted');
    assert.deepEqual(state?.actions, ['repair'], '损坏态要给出修复入口（OPT-06）');
    assert.match(state?.detail ?? '', /保护模式/);
    assert.equal(state?.actions.includes('resume'), false, '存储损坏时不让点恢复——恢复也无从谈起');
  });

  it('停止中：正在停，还不能当成已暂停', () => {
    const state = controlNoticeState({ ...base, stopInFlight: true, autoActivation: 'paused' });
    assert.equal(state?.kind, 'stopping');
    assert.match(state?.detail ?? '', /正在停止/);
  });

  it('已暂停：带出待处理来信数', () => {
    const state = controlNoticeState({ ...base, autoActivation: 'paused', held: 2, pendingMail: 5 });
    assert.equal(state?.kind, 'paused');
    assert.match(state?.detail ?? '', /5/);
    assert.equal(state?.actions.includes('resume'), true);
  });

  it('已暂停且有失败来信时，恢复与重试都给', () => {
    const state = controlNoticeState({ ...base, autoActivation: 'paused', held: 1, failedMail: 4 });
    assert.deepEqual(state?.actions, ['resume', 'retry']);
  });

  it('没有待处理来信时不给「重试失败来信」', () => {
    const state = controlNoticeState({ ...base, autoActivation: 'paused', held: 1, pendingMail: 0 });
    assert.deepEqual(state?.actions, ['resume']);
  });

  it('有失败来信但没暂停：也能看到重试入口', () => {
    const state = controlNoticeState({ ...base, failedMail: 2 });
    assert.equal(state?.kind, 'failed');
    assert.deepEqual(state?.actions, ['retry']);
    assert.equal(state?.actions.includes('resume'), false, '没暂停就不该出现恢复');
  });

  it('有来信积压但没暂停：只提示不打断', () => {
    const state = controlNoticeState({ ...base, pendingMail: 3 });
    assert.equal(state?.kind, 'pending');
    assert.deepEqual(state?.actions, []);
  });

  it('held（持平常驻信）与 pendingMail 取大者展示', () => {
    const state = controlNoticeState({ ...base, autoActivation: 'paused', held: 1, pendingMail: 7 });
    assert.match(state?.detail ?? '', /7/);
  });
});

describe('controlStatusText：顶栏状态文字', () => {
  it('正常时顶栏不显示状态', () => {
    assert.equal(controlStatusText(base), null);
  });

  it('停止中显示「正在停止」', () => {
    assert.equal(controlStatusText({ ...base, stopInFlight: true })?.text, '正在停止');
  });

  it('已暂停显示「已暂停」', () => {
    assert.equal(controlStatusText({ ...base, autoActivation: 'paused' })?.text, '已暂停');
  });

  it('存储损坏显示「控制存储损坏」', () => {
    assert.equal(controlStatusText({ ...base, faulted: true })?.text, '控制存储损坏');
  });

  it('失败的来信也给出文字，不静默', () => {
    assert.equal(controlStatusText({ ...base, failedMail: 1 })?.text, '有来信失败');
  });

  it('顶栏优先级与状态条一致：停止中盖过已暂停', () => {
    assert.equal(controlStatusText({ ...base, stopInFlight: true, autoActivation: 'paused' })?.text, '正在停止');
  });
});

describe('操作结果反馈', () => {
  it('恢复成功说清恢复了什么', () => {
    assert.match(resumeOutcomeMessage(true), /已恢复/);
    assert.match(resumeOutcomeMessage(false), /没成功/);
  });

  it('重试成功带回条数，失败不含糊', () => {
    assert.match(retryOutcomeMessage(true, 3), /3/);
    assert.match(retryOutcomeMessage(false, 0), /没成功/);
  });
});

describe('修复控制数据的结果文案（OPT-06）', () => {
  it('成功时说明修好并要核对，失败时给下一步', () => {
    assert.match(repairOutcomeMessage(true, 3), /3 位同事/);
    assert.match(repairOutcomeMessage(true, 3), /已暂停/);
    assert.match(repairOutcomeMessage(false), /备份数据目录/);
  });
});
