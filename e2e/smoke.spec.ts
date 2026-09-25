import { expect, test } from '@playwright/test';

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
