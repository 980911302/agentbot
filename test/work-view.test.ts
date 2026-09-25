import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  WORK_STATUS_LABEL,
  countWorks,
  deliverableRefLabel,
  deliverableRefs,
  filterWorks,
  isOpenWorkStatus,
  matchesWorkFilter,
  nextActionOf,
  objectiveOf,
  progressTextOf,
  sortWorksForPanel,
  stepProgressOf,
  waitingTargetOf,
  workSummaryLine,
} from '../web/src/features/work/work-view.js';
import type { WorkItem, WorkStep } from '../src/work/item.js';

/** 造一件工作：只写用例关心的字段，其余给稳定默认值 */
function work(patch: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    ownerAgentId: 'agent-1',
    originMessageId: 'msg-1',
    originChannel: { kind: 'dm', id: 'agent-1' },
    title: '一件工作',
    objective: '把这件事做完',
    acceptance: [],
    status: 'active',
    progressSummary: '做到一半',
    revision: 1,
    artifactIds: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...patch,
  };
}

function step(patch: Partial<WorkStep> & { id: string }): WorkStep {
  return {
    workId: 'w1',
    title: '一步',
    status: 'pending',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...patch,
  };
}

describe('WORK_STATUS_LABEL：状态用词与后端枚举一一对应', () => {
  it('七种状态都有中文短句，且没有多余键', () => {
    assert.deepEqual(Object.keys(WORK_STATUS_LABEL).sort(), [
      'active',
      'cancelled',
      'completed',
      'failed',
      'paused',
      'ready',
      'waiting',
    ]);
    assert.equal(WORK_STATUS_LABEL.waiting, '等待中');
    assert.equal(WORK_STATUS_LABEL.active, '进行中');
  });
});

describe('isOpenWorkStatus：进行中的判定与后端 isOpenWork 同语义', () => {
  it('ready/active/waiting/paused 是未完成', () => {
    for (const status of ['ready', 'active', 'waiting', 'paused'] as const) {
      assert.equal(isOpenWorkStatus(status), true, status);
    }
  });

  it('completed/cancelled/failed 是终态', () => {
    for (const status of ['completed', 'cancelled', 'failed'] as const) {
      assert.equal(isOpenWorkStatus(status), false, status);
    }
  });
});

describe('sortWorksForPanel：未完成的排前面，终态沉底', () => {
  it('进行中 → 等待中 → 已完成，各自按最近更新倒序', () => {
    const items = [
      work({ id: 'done', status: 'completed', updatedAt: 9_000 }),
      work({ id: 'wait', status: 'waiting', updatedAt: 2_000 }),
      work({ id: 'active-old', status: 'active', updatedAt: 1_000 }),
      work({ id: 'active-new', status: 'active', updatedAt: 5_000 }),
    ];
    assert.deepEqual(
      sortWorksForPanel(items).map((item) => item.id),
      ['active-new', 'active-old', 'wait', 'done'],
    );
  });

  it('不改动传入的数组', () => {
    const items = [work({ id: 'a', status: 'completed' }), work({ id: 'b', status: 'active' })];
    sortWorksForPanel(items);
    assert.deepEqual(
      items.map((item) => item.id),
      ['a', 'b'],
    );
  });
});

describe('waitingTargetOf：等待中读「在等什么」', () => {
  it('等待中且 nextAction 有值：直接用后端写下的等待条件', () => {
    const waiting = work({
      id: 'w',
      status: 'waiting',
      nextAction: '等「同事-往来对方」给出核对结论',
    });
    assert.equal(waitingTargetOf(waiting), '等「同事-往来对方」给出核对结论');
  });

  it('等待中但 nextAction 缺失：退到进展快照，不编等待对象', () => {
    const waiting = work({
      id: 'w',
      status: 'waiting',
      nextAction: undefined,
      progressSummary: '已发出请求',
    });
    assert.equal(waitingTargetOf(waiting), '已发出请求');
  });

  it('等待中且两栏都空：返回 undefined，由界面显示空态', () => {
    const waiting = work({ id: 'w', status: 'waiting', nextAction: undefined, progressSummary: '  ' });
    assert.equal(waitingTargetOf(waiting), undefined);
  });

  it('非等待态没有「等待对象」这一栏', () => {
    assert.equal(waitingTargetOf(work({ id: 'a', status: 'active', nextAction: '继续写测试' })), undefined);
  });
});

describe('nextActionOf / progressTextOf：下一步与进展各读各的', () => {
  it('等待中的 nextAction 归「在等什么」，不再重复出现在下一步', () => {
    const waiting = work({ id: 'w', status: 'waiting', nextAction: '等回信' });
    assert.equal(nextActionOf(waiting), undefined);
  });

  it('进行中给出下一步', () => {
    assert.equal(
      nextActionOf(work({ id: 'a', status: 'active', nextAction: '补齐深色断言' })),
      '补齐深色断言',
    );
  });

  it('空白进展如实显示「还没有进展记录」', () => {
    assert.equal(progressTextOf(work({ id: 'a', progressSummary: '   ' })), '还没有进展记录');
  });
});

describe('objectiveOf：目标与标题重复时不重复显示', () => {
  it('短消息里 title 就是 objective：不再列一行', () => {
    const item = work({ id: 'a', title: '修掉保存条', objective: '修掉保存条' });
    assert.equal(objectiveOf(item), undefined);
  });

  it('目标多说了内容才单独列出来', () => {
    const item = work({ id: 'a', title: '修掉保存条', objective: '修掉保存条。断言要卡住底边关系。' });
    assert.equal(objectiveOf(item), '修掉保存条。断言要卡住底边关系。');
  });

  it('目标为空时没有这一栏', () => {
    assert.equal(objectiveOf(work({ id: 'a', title: '标题', objective: '   ' })), undefined);
  });
});

describe('deliverableRefs：交付物引用', () => {
  it('过滤空串，保留真实引用', () => {
    const refs = deliverableRefs(work({ id: 'a', artifactIds: ['art-1', '  ', ''] }));
    assert.deepEqual(refs, ['art-1']);
  });

  it('短标签只截前 8 位，短 id 原样', () => {
    assert.equal(deliverableRefLabel('artifact-f0c1e2d3'), 'artifact');
    assert.equal(deliverableRefLabel('art-1'), 'art-1');
  });
});

describe('stepProgressOf：步骤进度', () => {
  it('数已完成与进行中的步数', () => {
    const steps = [
      step({ id: '1', status: 'completed' }),
      step({ id: '2', status: 'in_progress' }),
      step({ id: '3', status: 'pending' }),
      step({ id: '4', status: 'cancelled' }),
    ];
    assert.deepEqual(stepProgressOf(steps), { total: 4, completed: 1, running: 1 });
  });

  it('没有步骤时全零', () => {
    assert.deepEqual(stepProgressOf([]), { total: 0, completed: 0, running: 0 });
  });
});

describe('筛选 chip：在已取回的列表上筛，不再发请求', () => {
  const items = [
    work({ id: 'a1', status: 'active' }),
    work({ id: 'a2', status: 'active' }),
    work({ id: 'w1', status: 'waiting' }),
    work({ id: 'd1', status: 'completed' }),
  ];

  it('各档条数', () => {
    assert.deepEqual(countWorks(items), { all: 4, active: 2, waiting: 1, finished: 1 });
  });

  it('active / waiting 只留对应状态，finished 留终态', () => {
    assert.deepEqual(
      filterWorks(items, 'active').map((item) => item.id),
      ['a1', 'a2'],
    );
    assert.deepEqual(
      filterWorks(items, 'waiting').map((item) => item.id),
      ['w1'],
    );
    assert.deepEqual(
      filterWorks(items, 'finished').map((item) => item.id),
      ['d1'],
    );
    assert.equal(matchesWorkFilter(items[0]!, 'all'), true);
  });
});

describe('workSummaryLine：标题下的一句话', () => {
  it('没有工作给空态文案', () => {
    assert.equal(workSummaryLine([]), '还没有工作记录');
  });

  it('两件进行中 + 一件等待中', () => {
    const items = [
      work({ id: 'a1', status: 'active' }),
      work({ id: 'a2', status: 'active' }),
      work({ id: 'w1', status: 'waiting' }),
    ];
    assert.equal(workSummaryLine(items), '2 件进行中 · 1 件等待中');
  });

  it('只有终态时说已结束', () => {
    assert.equal(workSummaryLine([work({ id: 'd', status: 'completed' })]), '1 件已结束');
  });
});
