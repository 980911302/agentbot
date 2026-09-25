import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  BREAKPOINT_TABLET,
  BREAKPOINT_NARROW,
  layoutTier,
  sidebarAutoMini,
  type LayoutTier,
} from '../web/src/features/chat/layout-view.js';

describe('layoutTier：三档断点', () => {
  it('≥1280 是三栏宽档', () => {
    assert.equal(layoutTier(1440), 'wide');
    assert.equal(layoutTier(1280), 'wide');
  });

  it('1024–1279 是中档两栏', () => {
    assert.equal(layoutTier(1279), 'medium');
    assert.equal(layoutTier(1100), 'medium');
    assert.equal(layoutTier(1024), 'medium');
  });

  it('768–1023 是窄档', () => {
    assert.equal(layoutTier(1023), 'narrow');
    assert.equal(layoutTier(900), 'narrow');
    assert.equal(layoutTier(768), 'narrow');
  });

  it('<768 是单栏抽屉档', () => {
    assert.equal(layoutTier(767), 'compact');
    assert.equal(layoutTier(375), 'compact');
    assert.equal(layoutTier(320), 'compact');
  });

  it('边界值与断点常量一致', () => {
    assert.equal(BREAKPOINT_TABLET, 1280);
    assert.equal(BREAKPOINT_NARROW, 768);
    const tiers: LayoutTier[] = [layoutTier(1280), layoutTier(1279), layoutTier(768), layoutTier(767)];
    assert.deepEqual(tiers, ['wide', 'medium', 'narrow', 'compact']);
  });
});

describe('sidebarAutoMini：窄档自动迷你', () => {
  it('768–1023 侧栏自动迷你 72px', () => {
    assert.equal(sidebarAutoMini(1023), true);
    assert.equal(sidebarAutoMini(900), true);
    assert.equal(sidebarAutoMini(768), true);
  });

  it('≥1024 不自动迷你（用户仍可手动折）', () => {
    assert.equal(sidebarAutoMini(1024), false);
    assert.equal(sidebarAutoMini(1280), false);
    assert.equal(sidebarAutoMini(1440), false);
  });

  it('<768 也不是迷你——是抽屉，迷你是另一回事', () => {
    assert.equal(sidebarAutoMini(767), false);
    assert.equal(sidebarAutoMini(375), false);
  });
});
