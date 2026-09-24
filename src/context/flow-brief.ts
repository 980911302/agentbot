import type { FlowBriefContext } from '../shared/contracts/room-flow.js';

export function renderFlowBrief(context: FlowBriefContext): string {
  const constraints = (context.constraints && context.constraints.length > 0)
    ? context.constraints.map((c) => `- ${c}`).join('\n')
    : [
        '- 不要宣布行动已被接受',
        '- 不要指定下一行动者',
        '- 不要自行改变流程状态',
        '- 发送行动请显式使用 to:"room"，系统将作为候选行动进行权威校验',
      ].join('\n');

  return [
    '=== 受控群流程上下文 ===',
    `流程与协议：${context.protocol}（流程 ID: ${context.flowId}）`,
    `阶段与版本：${context.phase} / v${context.version}`,
    `当前身份：${context.actor.kind}:${context.actor.id}`,
    `授权目的：${context.purpose}`,
    `可见状态：${context.visibleStateSummary}`,
    `允许输出：${context.allowedOutput}`,
    '平台约束：',
    constraints,
    '========================',
  ].join('\n');
}
