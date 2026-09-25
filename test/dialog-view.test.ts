import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DEFAULT_DRAWER_TAB,
  deleteConfirmCopy,
  drawerTabOnChannelChange,
  infoToggleIntent,
  membersToggleIntent,
  panelToggleIntent,
  profileToggleIntent,
  topmostOverlay,
  type OverlayLayer,
  type OverlayStackState,
} from '../web/src/features/workspace/dialog-view.js';

const ALL_OPEN: OverlayStackState = {
  sidebarDrawer: true,
  confirmDelete: true,
  rename: true,
  profileEdit: true,
  create: true,
  settings: true,
  drawer: true,
};

describe('topmostOverlay：Esc 关最上层的顺序', () => {
  it('从上往下依次是 侧栏抽屉 → 确认框 → 改名 → 资料编辑 → 新建 → 设置 → 抽屉', () => {
    const state: OverlayStackState = { ...ALL_OPEN };
    const order: (OverlayLayer | null)[] = [];
    for (let step = 0; step < 8; step += 1) {
      const layer = topmostOverlay(state);
      order.push(layer);
      if (!layer) break;
      state[layer] = false;
    }
    assert.deepEqual(order, [
      'sidebarDrawer',
      'confirmDelete',
      'rename',
      'profileEdit',
      'create',
      'settings',
      'drawer',
      null,
    ]);
  });

  it('都没开就是 null', () => {
    assert.equal(
      topmostOverlay({
        sidebarDrawer: false,
        confirmDelete: false,
        rename: false,
        profileEdit: false,
        create: false,
        settings: false,
        drawer: false,
      }),
      null,
    );
  });
});

describe('infoToggleIntent：顶栏「右侧面板」', () => {
  it('关着时打开，保留上次的页签', () => {
    assert.deepEqual(infoToggleIntent(false, 'memory'), { action: 'showTab', tab: 'memory' });
    assert.deepEqual(infoToggleIntent(false, 'work'), { action: 'showTab', tab: 'work' });
  });

  it('关着且上次在资料页：打开默认的工作页（资料由标题入口负责）', () => {
    assert.deepEqual(infoToggleIntent(false, 'profile'), { action: 'showTab', tab: DEFAULT_DRAWER_TAB });
  });

  it('开着且在资料页时切回默认页，不关闭', () => {
    assert.deepEqual(infoToggleIntent(true, 'profile'), { action: 'setTab', tab: 'work' });
  });

  it('开着其它页时直接关闭', () => {
    assert.deepEqual(infoToggleIntent(true, 'work'), { action: 'close' });
    assert.deepEqual(infoToggleIntent(true, 'memory'), { action: 'close' });
  });
});

describe('membersToggleIntent：群成员叠放', () => {
  it('关着时打开成员页', () => {
    assert.deepEqual(membersToggleIntent(false, 'work'), { action: 'showTab', tab: 'members' });
  });

  it('已开成员页时关闭并回到默认页', () => {
    assert.deepEqual(membersToggleIntent(true, 'members'), { action: 'close', tab: 'work' });
  });

  it('开着别的页时切到成员页', () => {
    assert.deepEqual(membersToggleIntent(true, 'memory'), { action: 'showTab', tab: 'members' });
  });
});

describe('profileToggleIntent：私聊标题与 ⌘⇧I', () => {
  it('已开资料页就关掉（不动页签）', () => {
    assert.deepEqual(profileToggleIntent(true, 'profile'), { action: 'close' });
  });

  it('否则打开资料页', () => {
    assert.deepEqual(profileToggleIntent(false, 'work'), { action: 'showTab', tab: 'profile' });
    assert.deepEqual(profileToggleIntent(true, 'memory'), { action: 'showTab', tab: 'profile' });
  });
});

describe('panelToggleIntent：⌘\\', () => {
  it('开合抽屉且不换页签', () => {
    assert.deepEqual(panelToggleIntent(false), { action: 'setOpen', open: true });
    assert.deepEqual(panelToggleIntent(true), { action: 'setOpen', open: false });
  });
});

describe('默认页签：不再有「屏幕」页', () => {
  it('默认落在工作页', () => {
    assert.equal(DEFAULT_DRAWER_TAB, 'work');
  });
});

describe('deleteConfirmCopy：删除确认文案', () => {
  it('群是解散，名字带在文案里', () => {
    const copy = deleteConfirmCopy({ name: '发布小组', isGroup: true }, false);
    assert.equal(copy.title, '解散这个群？');
    assert.equal(copy.confirmLabel, '解散');
    assert.match(copy.message, /「发布小组」的成员表与群时间线会一起删掉/);
  });

  it('智能体是删除（连带对话与记忆）', () => {
    const copy = deleteConfirmCopy({ name: '小助手' }, false);
    assert.equal(copy.title, '删除这个智能体？');
    assert.equal(copy.confirmLabel, '删除');
    assert.match(copy.message, /「小助手」的对话记录和它的长期记忆会一起删掉/);
  });

  it('删除中按钮文案变成「删除中…」；目标为空时给智能体兜底文案', () => {
    assert.equal(deleteConfirmCopy({ name: '小助手' }, true).confirmLabel, '删除中…');
    assert.equal(deleteConfirmCopy(null, false).title, '删除这个智能体？');
    assert.equal(
      deleteConfirmCopy(null, false).message,
      '「」的对话记录和它的长期记忆会一起删掉，无法恢复。',
    );
  });
});

describe('drawerTabOnChannelChange：切频道时的页签', () => {
  it('从群切到私聊时成员页回到默认页', () => {
    assert.equal(drawerTabOnChannelChange('agent', 'members'), 'work');
  });

  it('其它情况不动页签', () => {
    assert.equal(drawerTabOnChannelChange('room', 'members'), 'members');
    assert.equal(drawerTabOnChannelChange('agent', 'profile'), 'profile');
    assert.equal(drawerTabOnChannelChange(undefined, 'memory'), 'memory');
  });
});
