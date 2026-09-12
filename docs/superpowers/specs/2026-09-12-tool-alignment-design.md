# 工具面对齐《内置工具清单.md》—— 设计

日期：2026-09-12
目标：AgentBot 的工具面换成 Grok Bot 的名字与语义（46 个清单为基准），旧工具名全部退场。
范围裁定：按清单 §3 分组 —— 云电脑组不做、连接器族不做（无插件基础设施）、其余对齐。

## 已实现映射

### 常驻层（8 / 10）

| Grok 工具 | 实现 | 说明 |
| --- | --- | --- |
| SendToUser | 新建 send-to-user.ts | type: text / attachment / widget / secret-request；群回合默认进群、`to:"dm"` 私发主人；end_turn 接受并忽略；widget/secret-request 走 InteractionBroker（复用现有选项卡/密钥卡 UI） |
| RecallMemory | memory.ts 改造 | `scope: agent\|user\|all` → self/user/all；limit |
| update_state | 新建 update-state.ts | memory write/forget（forget 按原文精确匹配）、profile set、settings.hidden_from_sidebar、avatar set/clear、project join/leave；routine/skill/channel → 报"暂不支持" |
| Shell | 新建 shell.ts | command / working_directory / block_until_ms（默认 30000，0=转后台）/ description；超时的进程转后台并返回 shell_id |
| AwaitShell | shell.ts | shell_id / block_until_ms / pattern（输出正则） |
| Read | files.ts 改造 | path / offset（负数从尾）/ limit，带行号 |
| ListSections | workbench.ts | 返回 `[]`（侧边栏分组未上线，占位保持面齐） |
| ReactToMessage / Screenshot / GetDynamicTools / CallDynamicTool | **跳过** | 无消息寻址 / 无云电脑 / 平台工具已原生（动态层随连接器上线） |

### cursor 层（11 / 36）

| Grok 工具 | 实现 |
| --- | --- |
| CreateAgent / UpdateAgent | workbench.ts 改名；语义已对齐（无删除工具 ✓） |
| CreateChannel / UpdateChannel | workbench.ts 改名；UpdateChannel 改 add_member_ids / remove_member_ids 增减式 |
| SendToAgent | room.ts 改造：`target_id` 支持同事 id 或所在群 id；priority=true 紧急插队；images 接受并注明"暂不支持附件"；两条路都写任务树记账 |
| WebSearch / WebFetch | web.ts 改名（search_term / explanation） |
| Task / CheckSubagent / MessageSubagent / StopSubagent | 新建 task.ts：executor 后台工人（自足 prompt、无用户上下文、输出=收尾文本）；Check 只读、Message 塞话、Stop 杀工人（进树 jobs） |
| TodoWrite | task.ts：按智能体内存的待办板（无 UI） |

### 跳过（理由）

- 云电脑组：Screenshot / request_box_help / ListMachines / CopyToBox / CopyFromBox / Task(computerUse|videoReview|watchVideo) —— 契约明确不要
- CloudAgent / request_scm_connect：无 SCM 基础设施
- 插件/MCP 生命周期 12 个：无插件系统
- DraftExternalMessage：无邮件/Slack 连接器
- GenerateImage：无生图模型
- request_user_form / request_secret 独立工具：密钥卡已并入 SendToUser(secret-request)

## 旧工具全部退场

calculator、read_file、write_file、list_files、deliver_file、remember、recall、ask_user、request_secret、list_secrets、list_workspace、create_agent、update_agent、update_self、create_room、update_room、post_to_room、say、stay_silent、send_to_agent —— 名字与语义由上表替代；写文件/列目录走 Shell；投递走 SendToUser(attachment)。

## 刻意的语义分岔（记录在案）

1. **私聊不采用"SendToUser 唯一出口"**：私聊直出保留（防止模型忘调工具造成黑洞），SendToUser(text) 在私聊=追加一条显式消息。群回合维持纪律：**沉默 = 不调 SendToUser**，`stay_silent` 删除；被点名必须调用，收尾文本兜底保留。
2. **send_to_agent.priority 只表达紧急**；停止传播永远由运行时按任务树下发（与《停止与插话.md》口径一致）。
3. Shell 直接跑在本机（AgentBot 无云电脑）：description 里明示风险，working_directory 必须是已存在目录；smart-mode 批准卡留待后续。

## 测试

- 新增：SendToUser 三形态路由、update_state memory/profile、Shell 超时转后台、Task 工人生命周期（后台/查看/停止）、UpdateChannel 增减
- 回归：全量单测 + typecheck + 双端 build
