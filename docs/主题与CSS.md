# 主题与 CSS

整理日期：2026-09-25（令牌 v2 落地，UI-01）

交互与组件规格见 `UI交互与视觉.md`。本文只写颜色、字体、间距、时长、选择器和主题怎么切。**数字唯一来源是 `web/src/styles/01-tokens.css`**，深浅两套都写在文件里，不要再发明第三套主色。当前主题为「白泽观智 v2」：浅色米纸底 + 古金强调，深色墨金。

文件：

| 文件 | 管什么 |
| --- | --- |
| `01-tokens.css` | 全部设计令牌（两套主题），唯一定义处 |
| `02-base.css` | reset、body、焦点环、滚动条 |
| `03-layout.css` | `.app` 栅格、欢迎空态、右键菜单、未读、在场环 |
| `04-sidebar.css` | 侧边栏 |
| `05-chat.css` | 时间线、气泡、输入条 |
| `06-panels.css` | 资料抽屉、成员 |
| `07-dialog.css` | 对话框、表单 |
| `08-animations.css` | 进出场、折叠、思考点、选项卡 |
| `theme.ts` | `light` / `dark` / `system`，写到 `html[data-theme]` |

---

## 1. 主题怎么切

三种偏好：`dark` | `light` | `system`。真正画到屏幕上只有 `dark` 和 `light`。

```
localStorage['agentbot.theme'] = 'light' | 'dark' | 'system'   // 没有键或值不认识 = 浅色（theme.ts 的 DEFAULT_THEME_PREFERENCE）
// 'system'：按 prefers-color-scheme 画 dark/light，系统切换时实时跟随
html[data-theme='dark'|'light']
html.style.colorScheme = 同上
```

CSS 入口：

```css
:root, :root[data-theme='light'] { /* 亮色变量 */ }
:root[data-theme='dark'] { /* 暗色变量 */ }
```

组件里**禁止**写死颜色。一律 `var(--token)`。新令牌先加进 `01-tokens.css`（两套同时给值），再引用；本命令由 `scripts/check-ui-tokens.mjs` 在 `npm run ci` 里强制（见 §7）。

`color-scheme` 必须跟主题走，否则原生滚动条、表单控件会反色。

---

## 2. 非颜色 token（两套主题共用）

### 2.1 字体与字号刻度

```css
--sans / --serif / --mono   /* 中文优先 PingFang / 微软雅黑，不引思源、不加载网页字体 */
--fs-xs: 11px    时间戳、徽标计数
--fs-sm: 12px    侧栏预览、辅助说明、标签
--fs-base: 14px  界面正文、按钮、输入
--fs-md: 15px    聊天消息正文
--fs-lg: 16px    面板标题、弹窗小标题
--fs-xl: 18px    弹窗标题、顶栏名字
--fs-2xl: 22px   空态标题、欢迎页
```

`--serif`（Noto Serif SC 等）只用于品牌名、空态标题、首字头像。数字、路径、错误码用 `--mono`。同一视图最多三级字号；名字 600，其余 400/500，不用 700 以上。

### 2.2 圆角、时长、曲线

```
--r-xs: 4px    骨架条、超小标签        --dur-instant: 80ms   按下去
--r-sm: 8px    输入、小按钮            --dur-fast: 140ms     hover 颜色、边框、小位移
--r-md: 12px   右键菜单、选项按钮      --dur-base: 220ms     淡入、折叠、对话框
--r-lg: 16px   提示卡片、prompt 卡     --dur-slow: 320ms     抽屉滑入
--r-xl: 20px   大对话框、输入条        --ease: cubic-bezier(0.4, 0, 0.2, 1)  默认
--r-2xl: 24px  极少用                  --ease-bounce: 少用，活头像可
--r-full: 9999px  药丸、未读、开关
```

允许的循环动画只有：活头像状态、骨架 shimmer、正在输入三点（见 §8）。

### 2.3 间距刻度（4 基数）

```
--sp-1: 2px   图标与文字缝        --sp-6: 20px  对话框头
--sp-2: 4px   小缺口、未读内边    --sp-7: 24px  空态 padding
--sp-3: 8px   行内 gap 默认       --sp-8: 32px  区块
--sp-4: 12px  卡片内边、资料预览  --sp-9: 40px
--sp-5: 16px  表单行              --sp-10: 48px
```

组件内边距只取刻度值。

### 2.4 层级与布局尺寸

```
--z-sidebar: 10   左侧栏
--z-header: 20    聊天顶栏簇（吸顶头、流程条、输入条容器）
--z-panel: 30     右侧面板、迷你抽屉
--z-dropdown: 40  菜单、@ 弹出、浮层
--z-modal: 50     对话框遮罩
--z-nested: 55    二级弹窗覆盖层（设置里的供应商窗口）
--z-toast: 60     Toast、离线条
--z-tooltip: 70   右键菜单、最上层浮层

--sidebar-w: 260px   侧栏宽（可拖 200–360；<160 吸附迷你 72px），App.tsx 内联覆盖
--panel-w: 380px     右侧面板宽（可拖 320–480）
--header-h: 52px     聊天顶栏、侧栏顶栏、面板顶栏统一
--read-w: 768px      聊天阅读列与输入条最大宽度
--row-h: 60px        侧栏同事/群行高
```

`z-index: 0/1` 只允许做组件内局部堆叠；浮层级一律用上面的令牌，禁止 9999。

---

## 3. 颜色令牌

### 3.1 语义命名（唯一一套，兼容别名已全部删除）

| 类别 | 令牌 | 浅色 | 深色 |
| --- | --- | --- | --- |
| 页面 | `--bg` | `#f7f3ec` | `#0c0e12` |
| 侧栏 | `--bg-sidebar` | `#ffffff` | `#12141a` |
| 卡片 | `--bg-card` | `#ffffff` | `#181b24` |
| 浮层 | `--bg-elevated` | `#ffffff` | `#1d2130`（比卡片高一级） |
| 弱底 | `--bg-subtle` | `#faf8f5` | `#14161f` |
| 悬停 | `--bg-hover` | `#f3eee2` | `#222634` |
| 选中 | `--bg-active` | `#ede4d0` | `rgba(212,167,106,.16)` |
| 输入 | `--bg-input` | `#ffffff` | `#14161f` |
| 代码 | `--bg-code` / `--bg-code-header` / `--text-code` | `#faf8f5` / `#f0eadd` / `#4a4033` | `#0f1218` / `#1a1d26` / `#d8dbe2` |
| 边框 | `--border` / `--border-strong` / `--divider` | `#ececec` / `#d5d5d5` / `#f0ece3` | 8% / 16% / 6% 白 |
| 主文字 | `--text` | `#1a1a1a` | `#f4f6fb` |
| 次文字 | `--text-secondary` | `#666666` | `#c3cad6` |
| 弱文字 | `--text-tertiary` | `#6f6f6f`（旧 `#999` 仅 2.6:1，已修） | `#8b93a3` |
| 思考 | `--text-think` | `#5c564b` | `#aab2c0` |
| 强调 | `--accent` | `#b8924e`（图标、描边、选中指示、焦点） | `#d4a76a` |
| 强调文字 | `--accent-text` | `#8a6a32`（5.0:1，旧金字 2.9:1 已修） | `#d4a76a` |
| 强调填充 | `--accent-strong` | `#8a6a32`（主按钮底） | `#d4a76a` |
| 强调上的字 | `--on-accent` | `#ffffff`（5.0:1） | `#0c0e12` |
| 强调弱底 | `--accent-weak` / `--accent-border` | `#fdf8ee` / `#e8dbbe` | 14% / 32% 金 |
| 成功 | `--ok` / `--ok-weak` / `--ok-text` | `#34c759` / 12% / `#1a7f36` | `#34d399` / 14% / `#6ee7b7` |
| 警告 | `--warn` / `--warn-weak` / `--warn-text` | `#ff9500` / 12% / `#a35a00` | `#fbbf24` / 14% / `#fde68a` |
| 危险 | `--danger` / `--danger-weak` / `--danger-text` | `#ff3b30` / 10% / `#c22e21` | `#f87171` / 14% / `#fca5a5` |
| 信息 | `--info` / `--info-weak` / `--info-text` | `#4a90e2` / 10% / `#2f6fb8` | `#60a5fa` / 14% / `#93c5fd` |
| 实底按钮填充 | `--danger-strong` / `--ok-strong` / `--info-strong` | `#d93229` / `#1a7f36` / `#2f6fb8` | 同基色 |
| 实底上的字 | `--on-danger` / `--on-ok` / `--on-info` | `#ffffff` | `#0c0e12` |
| 遮罩 | `--scrim` / `--scrim-strong` | `rgba(0,0,0,.32)` / `.48` | `rgba(0,0,0,.56)` / `.6` |
| 轻遮罩 | `--veil` | `rgba(0,0,0,.15)` | `rgba(0,0,0,.25)` |
| 焦点环 | `--ring` | `0 0 0 3px rgba(184,146,78,.22)` | `0 0 0 3px rgba(212,167,106,.25)` |
| 骨架 | `--skeleton-sheen` | `rgba(26,26,26,.05)` | `rgba(255,255,255,.08)` |

派生令牌（描边/渐变/光效/阴影）见 `01-tokens.css`：`--accent-soft`/`--accent-faint`/`--accent-glow`/`--accent-gradient`/`--glow`/`--aura-glow`、`--shadow`/`--shadow-soft`/`--shadow-card` 及 `--shadow-sm`/`--shadow-md`/`--shadow-lg`、`--shadow-gold`/`--shadow-gold-soft`/`--shadow-info`/`--shadow-panel`/`--shadow-panel-lg`/`--danger-glow`、`--danger-strong`、`--warn-border`、`--accent-edge`、`--ai-user-bubble`/`--ai-user-bubble-text`、`--scrim-bottom`（输入条上缘渐隐）。

**身份色不是主题**：11 种头像色（black/brown/red/orange/yellow/green/cyan/blue/violet/magenta/gray）由 `LivingAvatar.tsx` 的 `AVATAR_COLOR_HEX` 提供，只用于头像、名字、群发言者标记；组件里引用这些十六进制是规范认可的例外（检查器白名单）。

### 3.2 对比度要求（实测值）

正文、按钮文字 ≥ 4.5:1；18px 以上大字与图标、输入框边框、焦点指示 ≥ 3:1。以下为 2026-09-25 按令牌实算的 WCAG 比值（现行 27 个组合全部 ≥4.5:1）：

| 组合 | 比值 |
| --- | --- |
| 浅 `--text` / `--bg` | 15.74 |
| 浅 `--text-secondary` / `--bg` | 5.19 |
| 浅 `--text-tertiary` / `--bg` | 4.54 |
| 浅 `--text-tertiary` / `--bg-card` | 5.02 |
| 浅 `--accent-text` / `--bg-card` | 5.01 |
| 浅 `--accent-text` / `--bg` | 4.53 |
| 浅 `--on-accent` / `--accent-strong` | 5.01 |
| 浅 `--on-danger` / `--danger-strong` | 4.73 |
| 浅 `--on-ok` / `--ok-strong` | 5.08 |
| 浅 `--on-info` / `--info-strong` | 5.14 |
| 浅 `--ok-text` / `--bg-card` | 5.08 |
| 浅 `--warn-text` / `--bg-card` | 5.22 |
| 浅 `--danger-text` / `--bg-card` | 5.67 |
| 浅 `--info-text` / `--bg-card` | 5.14 |
| 深 `--text` / `--bg` | 17.86 |
| 深 `--text-secondary` / `--bg` | 11.72 |
| 深 `--text-tertiary` / `--bg-card` | 5.57 |
| 深 `--accent-text` / `--bg` | 8.77 |
| 深 `--accent-text` / `--bg-card` | 7.81 |
| 深 `--on-accent` / `--accent-strong` | 8.77 |
| 深 `--on-danger` / `--danger-strong` | 5.16 |
| 深 `--on-ok` / `--ok-strong` | 10.05 |
| 深 `--on-info` / `--info-strong` | 7.60 |
| 深 `--ok-text` / `--bg-card` | 11.28 |
| 深 `--warn-text` / `--bg-card` | 13.81 |
| 深 `--danger-text` / `--bg-card` | 9.06 |
| 深 `--info-text` / `--bg-card` | 9.54 |

被替换掉的旧值（不达标，本次修复的原因）：浅 `#999`/`--bg` 2.58；浅金字 `#b8924e`/卡片 2.89；浅白字/旧金底 `#b8924e` 2.89。

实底按钮一律用 `*-strong` 填充（浅色更深、深色同基色），文字用对应 `--on-*`；`--danger`/`--ok`/`--info` 基色只做描边、圆点、图标。不要 `opacity` 当次要字，对比度会随底漂。

---

## 4. 气泡与输入条

```
用户气泡：底 --ai-user-bubble、边 --accent-border、字 --ai-user-bubble-text
智能体消息：中性卡片 底 --bg-card、边 --border、圆角 --r-lg；头像 28 + 名字（身份色）+ 正文
消息正文：两边同一套 --fs-md / 行高 1.6（.msg-bubble-box），各变体只管底色、边框与内边距
输入条：底 --bg-card、边 --border、圆角 --r-xl，外缘 --scrim-bottom 渐隐托住时间线
```

智能体用中性表面卡片（ed0af41 起，与 UI交互与视觉.md §7「消息卡片」一致）；群里尤其不要给每人一块彩泡，只用头像和名字颜色区分。主人右侧，它左侧；群里主人的消息靠右、不重复头像和名字。

---

## 5. 焦点、滚动条、选区

```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* 输入框可改用 box-shadow: var(--ring); 并 outline: none; */

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: var(--r-full); }
::-webkit-scrollbar-track { background: transparent; }
```

鼠标点按不要出现焦点环（靠 `:focus-visible`）。键盘 Tab 必须有。

---

## 6. 布局配方

```css
.app {
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  height: 100%;
  overflow: hidden;
  background: var(--bg);
}
.app.with-screen {
  grid-template-columns: var(--sidebar-w) minmax(360px, 1fr) var(--panel-w);
}
```

`--sidebar-w` 的实际值由 `App.tsx` 内联覆盖（拖动宽度），令牌里的是默认 260px。

### 响应式断点（UI-09 统一，唯一出处）

断点判定在 `web/src/features/chat/layout-view.ts`（纯函数 + `node:test` 覆盖）；
CSS 里不能 `var(--x) @media`，各 `@media (max-width: …)` 用字面量并注释指向这里。

| 档位 | 视口 | 布局 |
| --- | --- | --- |
| `wide` | ≥1280 | 三栏：侧栏 + 聊天 + 资料 |
| `medium` | 1024–1279 | 两栏 + 右侧面板覆盖层（带遮罩，Esc 可关） |
| `narrow` | 768–1023 | 两栏 + 侧栏自动迷你 72px + 面板覆盖层 |
| `compact` | <768 | 单栏，侧栏为左侧抽屉（顶栏出菜单按钮），弹窗全屏 |

对应 CSS 断点值：`max-width: 1279px`（中档起：面板转覆盖层）、`max-width: 767px`（单栏：侧栏抽屉 + 弹窗全屏）。
历史上的 1120 / 920 / 720 等旧断点已删除（UI-09 范围第 1 项）。

宽度档位里只有「面板转覆盖层」和「单栏抽屉」需要媒体查询；窄档的侧栏自动迷你 72px
不再是媒体查询，而是 `App.tsx` 用 `sidebarAutoMini()` 算出渲染宽度交给 `.app-sidebar.mini`，
免得多写一份迷你外观。抽屉宽度 280 同理由 `App.tsx` 给，`.drawer-open` 由状态控制。

侧栏拖宽范围 200–360，低于 160 吸附迷你 72px；迷你档与抽屉档不写拖拽宽度（窗口变宽会还原）。

### 输入条高度（UI-07）

`.capsule-input` 的 1~8 行自适应与 `max-height: 200px` 由
`web/src/features/chat/composer-view.ts` 的 `composerAreaSize()` 决定
（一行 = `--fs-md` 15px × 1.5 = 24px，加上下内边距 8px；8 行 = 200px，超出转文本域内部滚动）。
CSS 里写不了这个常量，改一处要同步另一处，两边都有注释指向对方。

---

## 7. 令牌检查（CI 强制）

`scripts/check-ui-tokens.mjs`（已接入 `scripts/ci.mjs`）扫描：

- `web/src/styles/02~09` 全部样式表（含 `09-ui.css`）；
- `web/src` 下 tsx/ts 的内联样式。

报错规则：十六进制颜色、`rgba()/hsla()` 字面量、数字 z-index（0/1 除外）、已废除的兼容别名（`--panel`/`--raised`/`--sunken`/`--fg*`/`--line*`/`--bubble-*`/`--composer-*`/`--card*`/`--surface`/`--pill-blue`/`--code-*` 等，UI-01 起全仓清除）、未定义令牌；样式表里字重不在 400/500/600（§2.1）。

字号 / 圆角（渐进落地）：样式表里写死 `font-size: Npx` 或 `border-radius: Npx`（3px 以上）要换成 `--fs-*` / `--r-*`。消息区、侧栏、顶栏、输入条、交互卡（02/03/04/05/08/09）已清零，再写死就报错；右侧面板与弹窗（`06-panels.css`、`07-dialog.css`）还没迁完，在脚本的 `TYPE_WARN_ONLY_FILES` 里只打印警告和剩余数量。迁完一个文件就把它从名单删掉。

白名单：身份色 11 色 + 默认身份色 `#b89b6a` 的十六进制（以及 `LivingAvatar.tsx` 里的旧默认古金取值）；`BotFace.tsx` 等头像插画的固定墨色；`z-index: 0/1` 的组件内局部堆叠；行内写了 `/* ui-tokens-allow: 理由 */` 的字号/圆角（必须写理由，目前只有群头像「+N」角标的 9px）。

新写法只引用语义令牌；确需新令牌时先改本规范与 `01-tokens.css`（深浅两套），再引用。

---

## 8. 动画清单（只准这些循环）

| 名字 | 时长 | 用在 | 循环？ |
| --- | --- | --- | --- |
| `fade` | 220ms | 切频道 `.swap` | 否 |
| `pop` | 140ms | 菜单、跳转按钮 | 否 |
| `welcome-in` | 450ms | 空态 | 否 |
| `dot-bounce` | 1.15s stagger 140ms | 思考三点 | 是 |
| `caret-blink` | 0.9s steps | 流式光标 | 是 |
| `done-pop` | 2.5s forwards | 完成勾 | 否 |
| `shimmer` | 1.5s | 骨架 | 是 |
| `aura-ambient` | 7s alternate | 空态光 | 是 |
| `badge-float` | 4.5s alternate | 空态徽章 | 是 |
| 活头像 breathe/blink/work | 见组件 | 脸 | 是 |

禁止：整页左右滑、消息列表每条飞入、弹性放大超过 1.08、工具调用每步闪一次。侧栏「在干活」只看脸（UI交互与视觉.md §9），不再叠 `pulse-ring` 圈或忙碌状态点。

---

## 9. 无障碍

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- 对比：正文对底 ≥ 4.5:1（§3.2 有实测表）。
- 未读不要只靠颜色，要有数字或点。
- 点击区域 ≥ 28px（侧栏行已经够高）。
- `prefers-reduced-motion` 下欢迎光晕、徽章漂浮、头像呼吸、思考点都停。

---

## 10. 主题扩展（以后要第三套时）

不要复制整份组件 CSS。只加一块：

```css
:root[data-theme='sepia'] { /* 只覆盖色 token，圆角时长不动 */ }
```

智能体个人色（资料里的 swatch）**不是**主题。它只进头像 fill 和名字，不改变 `--bg` / `--accent`。swatch 与活头像 11 色对齐。

---

## 11. 完成标准

- 切 `data-theme` 时没有任何写死的颜色残留（搜 `#` 十六进制应只出现在 `01-tokens.css` 与身份色/插画白名单）。
- 未开第三套主题。
- `prefers-reduced-motion` 下欢迎光晕、徽章漂浮、头像呼吸、思考点都停。
- 主按钮、焦点环、`@` 高亮都走令牌，深浅两套随主题变。
- 智能体气泡背景始终透明。
- `npm run ci` 的 UI 令牌检查通过（别名 0、字面量 0、数字 z-index 0）。
