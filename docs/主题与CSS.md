# 主题与 CSS

整理日期：2026-09-15

交互见 `UI交互与视觉.md`。本文只写颜色、字体、间距、时长、选择器和主题怎么切。数字以 `web/src/styles/01-tokens.css` 为准，两套主题已经写在文件里，不要再发明第三套主色。

文件：

| 文件 | 管什么 |
| --- | --- |
| `01-tokens.css` | 字号族、圆角、时长、曲线、明暗两套色 |
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
localStorage['agentbot.theme'] = 'light' | 'dark'   // 没有键 = 现在的代码当 dark
html[data-theme='dark'|'light']
html.style.colorScheme = 同上
```

`useTheme()`：

- `preference === 'system'`：听 `prefers-color-scheme`，并 `addEventListener('change')`
- 否则用存下来的值
- `cycle()` 在当前实际主题的 dark/light 之间切，不经过 system
- 默认：没有存过就当 `dark`（`stored()` 的 else）

CSS 入口：

```css
:root, :root[data-theme='dark'] { /* 暗色变量 */ }
:root[data-theme='light'] { /* 亮色变量 */ }
```

组件里**禁止**写死 `#060c13`。一律 `var(--bg)`。新颜色先加 token，再引用。

`color-scheme` 必须跟主题走，否则原生滚动条、表单控件会反色。

---

## 2. 非颜色 token（两套主题共用）

### 2.1 字体

```css
--sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'SF Pro Text',
        'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei',
        'Helvetica Neue', Arial, sans-serif;
--mono: 'JetBrains Mono', SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;
```

中文优先 PingFang / 微软雅黑，不要再引思源、不要网页加载字体文件。

| 用途 | 大小 | 字重 | 行高 | 颜色 |
| --- | --- | --- | --- | --- |
| body | 14px | 400 | 1.55 | `--text` / `--fg` |
| 侧边栏名字 | 13px | 550–600 | 1.3 | `--text` |
| 侧边栏预览 | 12px | 400 | 1.35 | `--text-tertiary` |
| 聊天正文 | 14.5–15px | 400 | 1.55 | `--text` |
| 聊天名字 | 13px | 600 | 1.2 | `--text` |
| 时间戳 | 10.5px | 400 | 1 | `--text-tertiary` |
| 未读角标 | 10.5px | 650 | 1 | `#fff` 底 `--danger` 或 `--accent` |
| `@` 高亮 | inherit | 600 | inherit | `--accent` 底 `color-mix(accent 16%)` |
| 代码块 | 13px `--mono` | 400 | 1.5 | `--text-code` 底 `--bg-code` |
| 行内代码 | 0.92em `--mono` | 500 | — | `--code-inline-fg` 底 `--code-inline-bg` |
| 欢迎标题 | 28px | 700 | 1.3 | `--text`，字距 -0.025em |
| 按钮 | 14px | 600 | 1 | 主按钮白字 |

数字、路径、错误码用 `--mono`。

### 2.2 圆角

```
--r-xs: 4px    骨架条、超小标签
--r-sm: 8px    输入、小按钮、右键行 hover
--r-md: 12px   右键菜单、选项按钮、默认控件
--r-lg: 16px   提示卡片、prompt 卡
--r-xl: 20px   大对话框
--r-2xl: 24px  极少用
--r-full: 9999px  药丸、未读、开关
```

头像跟形状走，不要一律 `border-radius: 50%`。复合群头像底层圆可以切圆，脸上的默认标不要切。

### 2.3 时长与曲线

```
--dur-instant: 80ms     按下去
--dur-fast: 140ms       hover 颜色、边框、小位移
--dur-base: 220ms       淡入、折叠、对话框
--dur-slow: 320ms       抽屉滑入
--ease: cubic-bezier(0.16, 1, 0.3, 1)          默认出场
--ease-standard: cubic-bezier(0.4, 0, 0.2, 1)
--ease-out: cubic-bezier(0.2, 0.8, 0.2, 1)     选项卡边框
--ease-in: cubic-bezier(0.4, 0, 1, 1)
--ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1)  少用，活头像可
```

侧边栏拖宽用 `180ms ease`，拖的过程中 `.app.resizing { transition: none }`。

### 2.4 间距（建议用 4 的倍数，现码已大致如此）

```
4   图标与文字缝
6   小缺口、未读内边
8   行内 gap 默认
10  表单行
12  卡片内边、资料预览
14  选项卡内边
16  区块
20  对话框头
24  空态 padding
```

聊天列最大阅读宽约 820px（欢迎区已是），消息区左右 padding 24–32。

---

## 3. 暗色（默认）

气质：深夜底 `#060c13`，侧栏更暗 `#020408`，强调钴钢蓝 `#4f8dcc`。冷、克制，不要霓虹紫当主色（旧代码里 `@` 高亮还留着 `#a855f7` 兜底，应改成 `var(--accent)`）。

### 3.1 背景（越上越亮一档）

| token | 值 | 用在 |
| --- | --- | --- |
| `--bg` | `#060c13` | 聊天底、`.app` |
| `--bg-sidebar` | `#020408` | 侧栏 |
| `--bg-subtle` | `#0a1017` | 弱分区 |
| `--bg-elevated` | `#0d141c` | 输入条、卡片 |
| `--bg-card` | `#0d141c` | 卡片、对话框体 |
| `--bg-raised` | `#121a23` | 菜单、抬起的条 |
| `--bg-hover` | `#131c26` | 行 hover |
| `--bg-active` | `#192737` | 当前频道 |
| `--bg-input` | `#04080e` | 输入底（比聊天更凹） |
| `--bg-code` | `#080e16` | 代码块 |
| `--bg-code-header` | `#111a24` | 代码头 |

兼容旧名：`--panel`=`--bg`，`--raised`=`--bg-raised`，`--sunken`=`--bg-input`，`--hover`=`--bg-hover`，`--active`=`--bg-active`。新代码用新名。

### 3.2 线

| token | 值 |
| --- | --- |
| `--border` / `--line` | `#1d2731` |
| `--border-strong` / `--line-strong` | `#303c49` |
| `--divider` | `#18222b` |

分割用 1px `--border`。需要咬住边缘时才 `--border-strong`（输入条、右键菜单、选项卡）。

### 3.3 字

| token | 值 | 用在 |
| --- | --- | --- |
| `--text` / `--fg` | `#dce2e9` | 正文 |
| `--text-secondary` / `--fg-muted` | `#929ba6` | 次要 |
| `--text-tertiary` / `--fg-faint` | `#66717d` | 时间、提示 |
| `--text-think` | `#bdc7d2` | 思考过程（若展示） |
| `--text-code` | `#dce8f7` | 代码 |

不要 `opacity: 0.5` 当次要字，对比度会随底漂。用 token。

### 3.4 强调与语义

| token | 值 |
| --- | --- |
| `--accent` | `#4f8dcc` |
| `--accent-hover` | `#62a0df` |
| `--accent-weak` | `#0b2035` |
| `--accent-border` | `#214564` |
| `--accent-gradient` | `linear-gradient(135deg, #5d9bda, #367dbc)` |
| `--danger` / `--bad` | `#f87171` |
| `--danger-weak` | `rgba(248,113,113,.14)` |
| `--danger-border` | `rgba(248,113,113,.28)` |
| `--danger-text` | `#fca5a5` |
| `--ok` | `#34d399` |
| `--ok-weak` | `rgba(52,211,153,.14)` |
| `--ok-text` | `#6ee7b7` |
| `--warn` | `#fbbf24` |
| `--warn-weak` | `rgba(251,191,36,.14)` |
| `--warn-text` | `#fde68a` |

主按钮：底 `--accent`，字 `#fff`，hover `--accent-hover`。危险按钮：底 `--danger`，字 `#fff`。不要红字红底。

缺一个现码已经在用的变量：**`--accent-soft`**。`08-animations.css` 里 `.interaction-option:hover` 写了它，tokens 里没有。补：

```css
/* dark */
--accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
/* light */
--accent-soft: color-mix(in srgb, var(--accent) 10%, transparent);
```

### 3.5 阴影与光

```
--shadow-card: 0 1px 3px rgba(0,0,0,.48), 0 0 0 1px rgba(255,255,255,.015);
--shadow-soft: 0 10px 28px -10px rgba(0,0,0,.58);
--shadow:      0 24px 56px -12px rgba(0,0,0,.72);
--ring:        0 0 0 3px rgba(79,141,204,.22);
--glow:        0 0 0 1px rgba(79,141,204,.20), 0 9px 26px rgba(0,52,112,.14);
--aura-glow:   radial-gradient(circle at 50% 36%,
                 rgba(79,141,204,.11) 0%,
                 rgba(54,125,188,.04) 42%,
                 transparent 72%);
```

`--glow` 给焦点/主按钮。`--aura-glow` 只给欢迎空态光晕，聊天时间线不要铺一层。

### 3.6 气泡

```
--bubble-user: #102943
--bubble-user-border: var(--accent-border)
--bubble-user-fg: #dce7f3
--bubble-assistant: transparent
--bubble-assistant-border: transparent
--bubble-assistant-fg: var(--text)
--composer-bg: var(--bg-elevated)
--composer-border: var(--border-strong)
--composer-fade: linear-gradient(to top, var(--bg) 70%, transparent)
```

智能体气泡无底，群里尤其不要给每人一块彩泡。主人右侧，它左侧。

---

## 4. 亮色

底 `#f7faff`，侧栏 `#f2f7ff`，强调 `#2563eb`。线用蓝的低透明度，不要纯灰。

| token | light |
| --- | --- |
| `--bg` | `#f7faff` |
| `--bg-sidebar` | `#f2f7ff` |
| `--bg-raised` / elevated / card / input | `#ffffff` |
| `--bg-hover` | `#eaf2ff` |
| `--bg-active` | `#dbeafe` |
| `--bg-code` | `#eff6ff` |
| `--border` | `rgba(30,64,175,.10)` |
| `--border-strong` | `rgba(30,64,175,.18)` |
| `--text` | `#172033` |
| `--text-secondary` | `#4b5d78` |
| `--text-tertiary` | `#8291a8` |
| `--accent` | `#2563eb` |
| `--accent-hover` | `#1d4ed8` |
| `--accent-weak` | `rgba(37,99,235,.10)` |
| `--danger` | `#ef4444` |
| `--ok` | `#10b981` |
| `--warn` | `#f59e0b` |
| `--bubble-user` | `#eaf2ff` |
| `--bubble-user-fg` | `#172554` |
| `--shadow` | `0 12px 32px -8px rgba(30,64,175,.14), 0 4px 12px -4px rgba(30,64,175,.08)` |
| `--sunken`（兼容） | `--bg-hover`（亮色不要用纯白凹槽，会看不见） |

骨架 shimmer 的白色高光在亮色下改成 `rgba(37,99,235,.08)`，不要死写 `rgba(255,255,255,.08)`。

---

## 5. 焦点、滚动条、选区

```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* 输入框可改用 box-shadow: var(--ring); 并 outline: none; */

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border-radius: var(--r-full);
}
::-webkit-scrollbar-track { background: transparent; }
```

鼠标点按不要出现焦点环（靠 `:focus-visible`）。键盘 Tab 必须有。

选区：`::selection { background: color-mix(in srgb, var(--accent) 35%, transparent); color: inherit; }` 建议补上。

---

## 6. 布局配方

```css
.app {
  display: grid;
  grid-template-columns: var(--sidebar-width, 260px) minmax(0, 1fr);
  height: 100%;
  overflow: hidden;
  background: var(--bg);
  transition: grid-template-columns 180ms ease;
}
.app.with-screen {
  grid-template-columns: var(--sidebar-width, 260px) minmax(360px, 1fr) var(--drawer-width, 380px);
}
```

断点（已写在 `03-layout.css`）：

- `≤1120` 抽屉 `min(340px, 34vw)`
- `≤920` 侧栏可到 70
- `≤740` 抽屉改 `position:fixed; right:0; z-index:100`

侧栏拖宽范围建议 200–360，低于 90 进入 mini（只头像）。`--sidebar-width` 写在 `.app` 的 style 上。

z-index 约定：

```
10   输入条渐隐
25   跳到底部按钮
100  抽屉（窄屏）、离线条
200  右键菜单
300  scrim 对话框
```

不要每个组件自己加 9999。

---

## 7. 组件配方（对着抄）

### 7.1 侧栏行

```
高 52–56
padding 8 10
gap 10
hover  background: var(--bg-hover)
active background: var(--bg-active)
当前   左侧 2px 条 var(--accent) 可选，不要整行描边
```

未读 `.channel-unread`：底 `--danger`（你们现在是 `--bad`），白字，最小宽 18，药丸。不要和 accent 未读混用两套。建议：未读用 `--accent`，失败才红。二选一写死。

工作中：`.channel-avatar-wrapper.working::after` 脉冲环，色 `color-mix(warn 70%)`，1.6s。有活头像 `working` 状态后，这圈可以去掉，避免脸+圈双动画。

### 7.2 聊天标题

高 52–56，底透明，底边 1px `--border`。头像 28–32。名字可点，hover 下划线 `--fg-faint`。不要在这里放全局齿轮。

### 7.3 气泡

主人：`max-width: 72%`；`background: var(--bubble-user)`；`color: var(--bubble-user-fg)`；圆角 16，朝右下略小。padding 10 14。

智能体：无背景；头像 28 + 名字 13/600 + 正文。群里名字用该 bot 的 `--` 自定义色只能用在名字或瞳，不要整泡染色。

`@`：`.mention` 背景 `color-mix(accent 16%)`，字 `--accent`，圆角 8，左右 4px。兜底色从紫改蓝。

消息操作条默认 `opacity: 0`，行 hover 才 1。

### 7.4 输入条

底 `--composer-bg`，边 1px `--composer-border`，圆角 16–20。外圈用 `--composer-fade` 把时间线托住。textarea 无边、透明底、min-height 44、max 约 160。发送按钮圆，accent 底。

没有停止键。占位符 `--text-tertiary`：「发给 {名字}」或「在 {群} 里说，用 @ 点名」。

### 7.5 对话框

scrim：`rgba(0,0,0,.55)` 暗色 / 亮色可用 `rgba(23,32,51,.35)`。`.dialog` 宽 `min(480px, 92vw)`，圆角 20，`box-shadow: var(--shadow)`，底 `--bg-raised`。

进出：`usePresence`。scrim 只改 opacity 220ms。dialog `scale(.96) translateY(8px)` → 原位。退出略回收 `scale(.98) translateY(6px)`。

### 7.6 抽屉

从右 `translateX(14px)` + opacity，320ms `--ease`。底 `--bg`，左边 1px `--border`。

### 7.7 右键菜单

`min-width: 190`，padding 5，圆角 12，边 `--border-strong`，`animation: pop 140ms`。危险行字 `--danger`，hover `color-mix(danger 14%)`。

### 7.8 选项卡 / 密钥

`.interaction-card` 边 `--border-strong`，圆角 16，padding 14 16。选项 hover：边 `--accent`，底 `--accent-soft`。密钥输入 `--mono` + letter-spacing .08em。群时间线**不要渲染**这种卡。

### 7.9 欢迎空态

`--aura-glow` 模糊 52px，7s 呼吸。徽章 46，圆角 14，渐变 `#2e7cf6 → #4f8dcc → #367dbc`。标题 28/700。三列 prompt 卡，≤768 一列。`prefers-reduced-motion` 下徽章和光晕停。

### 7.10 活头像 CSS

状态用 `data-state`，动画写在组件内（见 `LivingAvatar.tsx`）。全局不要再给 `.bot-avatar` 套旋转。缩小到 20px 时关掉眨眼，只留颜色块。

`prefers-reduced-motion`：冻结 `idle` 第一帧。

---

## 8. 动画清单（只准这些循环）

| 名字 | 时长 | 用在 | 循环？ |
| --- | --- | --- | --- |
| `fade` | 220ms | 切频道 `.swap` | 否 |
| `pop` | 140ms | 菜单、跳转按钮 | 否 |
| `welcome-in` | 450ms | 空态 | 否 |
| `dot-bounce` | 1.15s stagger 140ms | 思考三点 | 是 |
| `caret-blink` | 0.9s steps | 流式光标 | 是 |
| `pulse-ring` | 1.6s | 侧栏 working 圈 | 是 |
| `done-pop` | 2.5s forwards | 完成勾 | 否 |
| `shimmer` | 1.5s | 骨架 | 是 |
| `aura-ambient` | 7s alternate | 空态光 | 是 |
| `badge-float` | 4.5s alternate | 空态徽章 | 是 |
| 活头像 breathe/blink/work | 见组件 | 脸 | 是 |

禁止：整页左右滑、消息列表每条飞入、弹性放大超过 1.08、工具调用每步闪一次。

折叠：`.collapsible` `grid-template-rows: 0fr → 1fr`，220ms `--ease`。

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

已写在 `08-animations.css`。再加：

- 对比：正文对底 ≥ 4.5:1。暗色 `#dce2e9` on `#060c13` 过关；`--text-tertiary` `#66717d` 只给时间戳，不给正文。
- 未读不要只靠颜色，要有数字或点。
- 点击区域 ≥ 28px（侧栏行已经够高）。

---

## 10. 主题扩展（以后要第三套时）

不要复制整份组件 CSS。只加一块：

```css
:root[data-theme='sepia'] { /* 只覆盖色 token，圆角时长不动 */ }
```

智能体个人色（资料里的 swatch）**不是**主题。它只进头像 fill 和名字，不改变 `--bg` / `--accent`。

swatch 现有：`#a855f7 #38bdf8 #30d158 #f97316 #f472b6 #facc15 #5eead4 #60a5fa`。应对齐活头像 11 色（black/brown/red/…）。选中：`border: 2px solid var(--fg)` + `box-shadow: 0 0 0 2px var(--panel)`。

---

## 11. 现码要修的洞

1. `--accent-soft` 未定义，补上。  
2. `.mention` 和若干 `var(--accent, #a855f7)` 兜底改成蓝色系，去掉紫。  
3. 骨架 `rgba(255,255,255,.08)` 亮色无效，改 token。  
4. `stored()` 把缺省当 dark，但类型里有 `system`；设置页若提供「跟随系统」，`stored()` 的 else 应能返回 `system`（现在 `system` 存的是删 key，读时却落到 dark）。要跟随系统：没 key 当 `system`，或另存 `agentbot.theme=system`。  
5. 未读角标 `--bad` 与跳转钮未读 `--accent` 两套，统一。  
6. 新选择器继续进现有 8 个文件，不要再开 `09-vibe.css`。

---

## 12. 完成标准

- 切 `data-theme` 时没有任何写死的暗色/亮色残留（搜 `#060c13`、`#fff` 作为大面积底应只出现在 tokens）。  
- 未开第三套主题。  
- `prefers-reduced-motion` 下欢迎光晕、徽章漂浮、头像呼吸、思考点都停。  
- 主按钮、焦点环、`@` 高亮都走 `--accent`，暗蓝亮蓝随主题变。  
- 智能体气泡背景始终 `transparent`。
