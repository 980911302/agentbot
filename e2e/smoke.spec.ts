import { spawn } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

/**
 * 前端冒烟（OPT-05）：四条必测流程 + 一条响应式回归。
 *
 * 约定（playwright.dev/docs/best-practices）：
 *   - 选择器优先 user-facing 属性（role / 文案），不用 CSS class 定位业务元素；
 *   - 一律用 Playwright 的自动等待断言，不写固定 sleep；
 *   - 每个用例自己的 context（localStorage 隔离），服务端数据由 webServer 统一提供。
 */

const AGENT = '普通私聊';
const PAUSED = '已暂停·停止之后';
const REPLY = '收到，我先看一遍上下文再动手。';

test('打开 → 选同事 → 发消息 → 看到回复，用户消息只留一条', async ({ page }) => {
  await page.goto('/');

  const agent = page.locator('.channel-item', { hasText: AGENT }).first();
  await expect(agent).toBeVisible();
  await agent.click();

  const timeline = page.locator('.chat-message-list');
  await expect(timeline).toBeVisible();

  await page.locator('.capsule-input').fill('冒烟：请回一句');
  await page.getByRole('button', { name: '发送消息' }).click();

  // 乐观占位立刻可见；拿到回执后换成正式消息，时间线上仍然只有一条
  await expect(timeline).toContainText('冒烟：请回一句');
  await expect(page.locator('.msg-row', { hasText: '冒烟：请回一句' })).toHaveCount(1);
  await expect(page.locator('.msg-bubble-box.error')).toHaveCount(0);

  // 假模型（FakeProvider）回一句，不调用真实模型
  await expect(timeline).toContainText(REPLY, { timeout: 20_000 });
});

test('设置弹窗：Esc 关闭，焦点回到触发元素', async ({ page }) => {
  await page.goto('/');
  const trigger = page.locator('.sidebar-user-row');
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: '设置' });
  await expect(dialog).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('侧栏选中即时生效：点击后标题与选中态都跟着走', async ({ page }) => {
  await page.goto('/');

  const target = page.locator('.channel-item').nth(2);
  const name = (await target.locator('.channel-name, .channel-info-wrapper').first().innerText()).trim();
  await target.click();

  await expect(target).toHaveClass(/active/);
  await expect(page.locator('.channel-item.active')).toHaveCount(1);
  await expect(page.locator('.chat-top-header')).toContainText(name.split('\n')[0]!);
});

test('已暂停同事：控制状态条能恢复自动处理', async ({ page }) => {
  await page.goto('/');
  await page.locator('.channel-item', { hasText: PAUSED }).first().click();

  const notice = page.locator('.control-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('已暂停');

  await notice.getByRole('button', { name: '恢复自动处理' }).click();
  await expect(notice).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('.ui-toast-message')).toContainText('恢复');
});

test('响应式回归：1024 右侧面板是覆盖层，<768 侧栏抽屉可开关且 Esc 可关', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await page.locator('.channel-item').first().click();

  await page.getByRole('button', { name: '侧边栏与屏幕' }).click();
  await expect(page.locator('.drawer')).toHaveCSS('position', 'absolute');
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).toBeHidden();

  await page.setViewportSize({ width: 375, height: 812 });
  const toggle = page.getByRole('button', { name: '打开侧边栏' });
  await expect(toggle).toBeVisible();
  await expect(page.locator('.app-sidebar')).toHaveCSS('visibility', 'hidden');

  await toggle.click();
  await expect(page.locator('.app')).toHaveClass(/drawer-open/);
  await expect(page.locator('.app-sidebar')).toHaveCSS('visibility', 'visible');
  await page.keyboard.press('Escape');
  await expect(page.locator('.app')).not.toHaveClass(/drawer-open/);
});

/**
 * OPT-06：控制数据损坏 → 状态条给出修复入口 → 修复后同事置为已暂停。
 * 这条链路要在**写坏控制存储**的环境里跑，不能污染共享的 webServer，
 * 所以自带一个临时预览进程（端口从 AGENT_PREVIEW_PORT 派生，跑完杀掉）。
 */
test('控制数据损坏：状态条给出修复入口，修复后同事变为已暂停', async ({ page }) => {
  // 不写死端口：多个代理并行跑 e2e 时，固定端口会互撞（后起的进程 EADDRINUSE，
  // 或连上别人那个已被写脏的数据目录）。+1 与被测 webServer 的端口错开。
  const port = Number(process.env.AGENT_PREVIEW_PORT ?? 4599) + 1;
  const child = spawn('node', ['--import', 'tsx', 'test/fixtures/ui-preview.ts'], {
    env: { ...process.env, AGENT_PREVIEW_PORT: String(port), AGENT_PREVIEW_CORRUPT_CONTROL: '1' },
    stdio: 'ignore',
  });
  try {
    const base = `http://127.0.0.1:${port}/`;
    await expect
      .poll(async () => (await fetch(`${base}api/health`).catch(() => null))?.ok ?? false, {
        timeout: 30_000,
      })
      .toBe(true);

    await page.goto(base);
    await page.locator('.channel-item', { hasText: '普通私聊' }).first().click();

    const notice = page.locator('.control-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('保护模式');
    await expect(notice).toHaveClass(/faulted/);

    // 二次确认：先弹确认框，确认后才真的修复
    await notice.getByRole('button', { name: '修复控制数据' }).click();
    const dialog = page.getByRole('dialog', { name: '修复控制数据？' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '修复' }).click();

    await expect(page.locator('.ui-toast-message')).toContainText('控制数据已修复');
    // 修复后不再是「损坏」态，而是需要核对的「已暂停」
    await expect(page.locator('.control-notice.faulted')).toBeHidden({ timeout: 15_000 });
    await expect(notice).toContainText('已暂停');
  } finally {
    child.kill('SIGTERM');
  }
});

/**
 * UI-06 打回点：资料「保存 / 撤销」条必须吸底。
 * 上一轮只断言了「条子存在」，没断言「在视口内」，于是条子被父级滚动容器带出视口也过关了。
 * 这里改断几何：条子底边要贴住抽屉底边、整体在视口内、且内容滚动后位置不变。
 */
test('资料吸底保存条：在视口内且恒贴抽屉底边，内容滚动不影响它', async ({ page }) => {
  await page.goto('/');
  await page.locator('.channel-item', { hasText: '普通私聊' }).first().click();
  await page.getByRole('button', { name: '侧边栏与屏幕' }).click();
  await page.locator('.drawer-tab', { hasText: '资料' }).first().click();

  await page.locator('#bot-profile-title').fill('吸底断言');
  const bar = page.locator('.profile-save-bar');
  await expect(bar).toBeVisible();

  const geometry = async () =>
    page.evaluate(() => {
      const barEl = document.querySelector('.profile-save-bar')!;
      const drawer = document.querySelector('.bot-profile-drawer')!;
      const body = document.querySelector('.profile-drawer-body')!;
      const rb = barEl.getBoundingClientRect();
      const rd = drawer.getBoundingClientRect();
      const rbody = body.getBoundingClientRect();
      return {
        barTop: rb.top,
        barBottom: rb.bottom,
        drawerBottom: rd.bottom,
        viewportH: window.innerHeight,
        canScroll: body.scrollHeight > body.clientHeight + 1,
        // 抽屉自身的溢出量：>0 说明滚动落在了抽屉上（正是打回前的结构）
        drawerOverflow: drawer.scrollHeight - drawer.clientHeight,
        bodyBottom: rbody.bottom,
      };
    });

  const before = await geometry();
  expect(before.barBottom).toBeLessThanOrEqual(before.viewportH + 1);
  expect(Math.abs(before.barBottom - before.drawerBottom)).toBeLessThanOrEqual(1);
  // 滚动必须收在内容区：抽屉自己不该有可滚动的溢出，内容区底边也不该压到条子上
  expect(before.drawerOverflow).toBeLessThanOrEqual(1);
  expect(before.bodyBottom).toBeLessThanOrEqual(before.barTop + 1);

  if (before.canScroll) {
    await page.evaluate(() => {
      document.querySelector('.profile-drawer-body')!.scrollTop = 1e6;
    });
    const after = await geometry();
    expect(Math.abs(after.barBottom - before.barBottom)).toBeLessThanOrEqual(1);
  }

  await page.getByRole('button', { name: '保存' }).click();
  await expect(bar).toBeHidden();
});

/**
 * E5.7：主人名以后端设置为准——改完刷新还在，且不是 localStorage 在起作用。
 * 先清掉 localStorage 再刷新，验证名字来自后端（这条正是「CLI 与界面同一个名字」的界面侧）。
 */
test('主人名持久在后端：改完刷新仍在（localStorage 清空也不丢）', async ({ page }) => {
  await page.goto('/');
  // 侧栏账号行（title 不是可访问名，按类选更稳）
  await page.locator('.sidebar-user-row').click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  const nameInput = dialog.getByLabel('主人显示名');
  await expect(nameInput).toBeVisible();

  await nameInput.fill('端到端主人名');
  await nameInput.blur();
  await expect(page.locator('.ui-toast-message')).toHaveCount(0); // 保存成功不发错误 Toast

  // 清掉本地缓存再刷新：名字仍应出现，说明事实源在后端
  await page.evaluate(() => localStorage.removeItem('agentbot.ownerName'));
  await page.reload();
  await page.locator('.sidebar-user-row').click();
  await expect(page.getByRole('dialog', { name: '设置' }).getByLabel('主人显示名')).toHaveValue(
    '端到端主人名',
  );

  // 复位，避免影响同一 webServer 上的其它用例
  await page.getByRole('dialog', { name: '设置' }).getByLabel('主人显示名').fill('linlin zhang');
  await page.getByRole('dialog', { name: '设置' }).getByLabel('主人显示名').blur();
});

/**
 * E4.7「工作」标签：浅/深 × 1280/1024/768 共 6 组，每组都断几何而不是「元素存在」。
 *
 * 断的是：面板整体在视口内且右/下缘贴住视口与抽屉、面板与整页都没有横向滚动、
 * 高亮标签与显示内容一致（只有一个 active，且就是「工作」）；另外确认预览夹具里
 * 是 2 件进行中 + 1 件等待中，等待对象指名了那位同事。
 *
 * 想顺带出图（截图不进仓库）：
 *   AGENT_PREVIEW_PORT=4620 E47_SHOT_DIR=/tmp/e47-shots npx playwright test -g 工作面板几何
 */
const WORK_SCENE = '手头工作·三件在办';
const WORK_PEER = '同事-手头工作的等待对象';
const WORK_CASES = [
  { theme: 'light', width: 1280, height: 900 },
  { theme: 'dark', width: 1280, height: 900 },
  { theme: 'light', width: 1024, height: 900 },
  { theme: 'dark', width: 1024, height: 900 },
  { theme: 'light', width: 768, height: 900 },
  { theme: 'dark', width: 768, height: 900 },
] as const;

/**
 * 等布局稳定：连续两次取样一致才算定下来。
 *
 * 光等 `transform === 'none'` 不够——抽屉有 320ms 进场位移，.app 的
 * `grid-template-columns` 还有 180ms 过渡，改视口宽度后 React 的档位状态也要下一帧才跟上，
 * 期间量到的是中间态（768 档就曾在 x=776 处量到一次）。
 */
async function waitForStableBox(page: Page, selector: string) {
  let previous: { left: number; right: number; top: number; bottom: number } | null = null;
  await expect
    .poll(async () => {
      const box = await page.locator(selector).evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      const settled =
        previous !== null &&
        Math.abs(box.left - previous.left) <= 0.5 &&
        Math.abs(box.right - previous.right) <= 0.5 &&
        Math.abs(box.top - previous.top) <= 0.5 &&
        Math.abs(box.bottom - previous.bottom) <= 0.5;
      previous = box;
      return settled;
    })
    .toBe(true);
}

for (const item of WORK_CASES) {
  test(`工作面板几何（${item.theme} × ${item.width}）：在视口内、无横向滚动、标签与内容同步`, async ({
    page,
  }) => {
    await page.addInitScript((theme: string) => localStorage.setItem('agentbot.theme', theme), item.theme);
    await page.goto('/');
    // 先在宽档选同事：768 档侧栏会收成迷你，名字不显示
    await page.locator('.channel-item', { hasText: WORK_SCENE }).first().click();
    await page.setViewportSize({ width: item.width, height: item.height });
    await page.getByRole('button', { name: '侧边栏与屏幕' }).click();
    // <1280 时面板是覆盖层：这条 class 由 App 按「已量到的视口宽度」加，等它出现
    // 说明改视口后的档位状态已经跟上（否则会量到面板还挂在网格里那一帧）
    if (item.width < 1280) await expect(page.locator('.app')).toHaveClass(/panel-overlay/);

    // 按需展开：没点之前，步骤根本不在 DOM 里
    expect(await page.locator('.work-step-list').count()).toBe(0);

    await page.locator('[data-drawer-tab="work"]').click();
    await expect(page.locator('.work-panel')).toBeVisible();
    await expect(page.locator('.work-card[data-status="active"]')).toHaveCount(2);
    await expect(page.locator('.work-card[data-status="waiting"]')).toHaveCount(1);
    await expect(page.locator('.work-card[data-status="waiting"] .work-field.waiting dd')).toContainText(
      WORK_PEER,
    );

    // 标签高亮与内容同步：只有一个高亮标签，且就是「工作」
    await expect(page.locator('.drawer-tab.active')).toHaveCount(1);
    await expect(page.locator('.drawer-tab.active')).toHaveText('工作');
    await expect(page.locator('[data-drawer-tab="work"]')).toHaveClass(/active/);

    await waitForStableBox(page, '.drawer');
    await waitForStableBox(page, '.work-panel');

    // 第一张工作卡整张都在面板可视区里（内容没被面板上/下缘切掉）
    const band = await page.evaluate(() => {
      const body = document.querySelector('.work-body')!.getBoundingClientRect();
      const card = document.querySelector('.work-card')!.getBoundingClientRect();
      return { bodyTop: body.top, bodyBottom: body.bottom, cardTop: card.top, cardBottom: card.bottom };
    });
    expect(band.cardTop).toBeGreaterThanOrEqual(band.bodyTop - 1);
    expect(band.cardBottom).toBeLessThanOrEqual(band.bodyBottom + 1);

    const geometry = await page.evaluate(() => {
      const panel = document.querySelector('.work-panel')!.getBoundingClientRect();
      const drawer = document.querySelector('.drawer')!.getBoundingClientRect();
      const body = document.querySelector('.work-body')!;
      return {
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
        panelLeft: panel.left,
        panelRight: panel.right,
        panelTop: panel.top,
        panelBottom: panel.bottom,
        drawerTop: drawer.top,
        drawerBottom: drawer.bottom,
        panelScrollW: body.scrollWidth,
        panelClientW: body.clientWidth,
        docScrollW: document.documentElement.scrollWidth,
        docClientW: document.documentElement.clientWidth,
        bodyScrollW: document.body.scrollWidth,
      };
    });

    expect(geometry.panelLeft).toBeGreaterThanOrEqual(-1);
    expect(geometry.panelTop).toBeGreaterThanOrEqual(-1);
    expect(geometry.panelBottom).toBeLessThanOrEqual(geometry.viewportH + 1);
    expect(geometry.panelRight).toBeLessThanOrEqual(geometry.viewportW + 1);
    // 面板右缘贴住视口右缘：留出空隙说明网格列宽与抽屉宽度不同源
    expect(Math.abs(geometry.panelRight - geometry.viewportW)).toBeLessThanOrEqual(1);
    // 面板不越出抽屉
    expect(geometry.panelBottom).toBeLessThanOrEqual(geometry.drawerBottom + 1);
    expect(geometry.panelTop).toBeGreaterThanOrEqual(geometry.drawerTop - 1);
    // 横向滚动：面板内容、整页、body 都不许溢出
    expect(geometry.panelScrollW).toBeLessThanOrEqual(geometry.panelClientW + 1);
    expect(geometry.docScrollW).toBeLessThanOrEqual(geometry.docClientW + 1);
    expect(geometry.bodyScrollW).toBeLessThanOrEqual(geometry.viewportW + 1);

    const shotDir = process.env.E47_SHOT_DIR;
    if (shotDir) {
      await page.screenshot({ path: `${shotDir}/e47-work-${item.theme}-${item.width}x${item.height}.png` });
    }
  });
}

test('工作面板：步骤按需展开；没有工作的同事给空态', async ({ page }) => {
  await page.goto('/');
  await page.locator('.channel-item', { hasText: WORK_SCENE }).first().click();
  await page.getByRole('button', { name: '侧边栏与屏幕' }).click();
  await page.locator('[data-drawer-tab="work"]').click();

  const waitingCard = page.locator('.work-card[data-status="waiting"]');
  await expect(waitingCard).toBeVisible();
  await expect(waitingCard.locator('.work-step')).toHaveCount(0);

  await waitingCard.locator('.work-act').click();
  await expect(waitingCard.locator('.work-step')).toHaveCount(3);
  await expect(waitingCard.locator('.work-step[data-step-status="pending"]')).toHaveCount(1);
  // 收起后 DOM 还在（折叠动画要有内容可播），但内容被收到 0 高
  await waitingCard.locator('.work-act').click();
  await expect(waitingCard.locator('.work-act')).toHaveAttribute('aria-expanded', 'false');
  await expect(waitingCard.locator('.collapsible')).not.toHaveClass(/open/);
  // 折叠是几何事实：子元素还在 DOM 里，但 .collapsible-inner 被收到 0 高
  await expect
    .poll(() => waitingCard.locator('.collapsible-inner').evaluate((el) => el.getBoundingClientRect().height))
    .toBeLessThan(1);

  // 换一位没有工作的同事：空态一句，不转圈、不编进度
  await page.locator('.channel-item', { hasText: '普通私聊' }).first().click();
  await expect(page.locator('.work-panel')).toContainText('手头没有工作');
  await expect(page.locator('.work-card')).toHaveCount(0);
});
