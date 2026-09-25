/**
 * 工作对象（E4.1，模型见 docs/架构设计.md §4.2 WorkItem）。
 *
 * 「同事手头有哪些工作」以前只存在于对话线和任务进度快照里，重启即丢、也无法回答
 * 「这件事做到哪了」。这里把承诺与进展落成持久对象：一个同事可以同时负责多件工作，
 * 一件工作可以经历多次执行（Run）。
 *
 * 本文件只放类型与**纯判定**，不碰存储、不认识运行时。
 */

export type WorkStatus = 'ready' | 'active' | 'waiting' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface WorkOriginChannel {
  kind: 'dm' | 'room';
  id: string;
}

export interface WorkItem {
  id: string;
  ownerAgentId: string;
  originMessageId: string;
  originChannel: WorkOriginChannel;
  projectId?: string;
  title: string;
  objective: string;
  acceptance: string[];
  status: WorkStatus;
  progressSummary: string;
  nextAction?: string;
  /** 每次修改 +1；调用方可用它做条件更新（架构 §7） */
  revision: number;
  artifactIds: string[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export type WorkStepStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface WorkStep {
  id: string;
  workId: string;
  /** 来自哪次执行（Run）；没有关联执行时省略 */
  runId?: string;
  title: string;
  status: WorkStepStatus;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

/** 还在进行中的状态：只有这些能被「继续」接到 */
const OPEN_STATUSES: WorkStatus[] = ['ready', 'active', 'waiting', 'paused'];
const TERMINAL_STATUSES: WorkStatus[] = ['completed', 'cancelled', 'failed'];

export function isOpenWork(status: WorkStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function isTerminalWork(status: WorkStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * 是不是「可以接着做」的工作：ready/active/waiting/paused 都算。
 * 最近更新的排前面——新消息优先接最近那件，与用户说话的习惯一致。
 */
export function pickOpenWork<T extends { status: WorkStatus; updatedAt: number }>(items: T[]): T | undefined {
  return mostRecent(items.filter((item) => isOpenWork(item.status)));
}

/** 最近更新的一件（调用方已经筛过状态时用这个） */
export function mostRecent<T extends { updatedAt: number }>(items: T[]): T | undefined {
  return [...items].sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

// ── 任务 / 闲聊判定 ────────────────────────────────────────────────

/** 出现这些词基本可以认为用户在托付一件事 */
const TASK_VERBS = [
  '做',
  '干',
  '写',
  '改',
  '修',
  '实现',
  '排查',
  '查一下',
  '调研',
  '整理',
  '跟进',
  '部署',
  '发布',
  '测',
  '验证',
  '重构',
  '优化',
  '清理',
  '加一个',
  '加个',
  '去掉',
  '删掉',
  '升级',
  '迁移',
  '接入',
  '补',
  '设计',
  '评审',
  '核对',
  'review',
  'fix',
  'implement',
  'refactor',
  'add',
  'remove',
  'update',
  'migrate',
  'test',
  'check',
  'investigate',
];

/** 明显只是打招呼/道谢/情绪，不该建工作 */
const CHITCHAT = [
  /^(你?好|您好|哈喽|hi|hello|hey|早|晚上好|在吗|在不在)[!！。~～\s]*$/i,
  /^(谢谢|多谢|感谢|辛苦了|thx|thanks)[!！。~～\s]*$/i,
  /^(嗯|哦|好|好的|收到|行|可以|对|是的|ok|okay|got it)[!！。~～\s]*$/i,
  /^(哈哈|嘿嘿|笑死|😂|🤣|\s)+$/,
];

/**
 * 多步意图的迹象：先说一件再补一件，或明确排期/顺序。
 * 「先…再…」「然后」「接着」「之后」「另外」这类连接词说明这事不止一步。
 */
const MULTI_STEP = /(先.{0,20}(再|然后|接着)|然后|接着|之后|另外|顺便|下一步)/;

/** 长度门槛：太短的一律当闲聊（「好」「嗯」「帮我看看」不足以建工作） */
const MIN_WORK_CHARS = 8;

/**
 * 判定一句用户消息是「托付一件事」还是「闲聊」。
 *
 * 只决定要不要建 WorkItem，**不改变发送、执行、分流**；宁可漏建也不误建——
 * 误建会让「手头工作」列表充满噪声，漏建只是少记一条（后续消息仍可建）。
 */
export function classifyUserMessage(text: string): 'work' | 'chat' {
  const trimmed = text.trim();
  if (!trimmed) return 'chat';
  if (CHITCHAT.some((pattern) => pattern.test(trimmed))) return 'chat';
  // 纯提问（以问号结尾且没有任务动词）当闲聊：那是在问事，不是托付
  const hasTaskVerb = TASK_VERBS.some((verb) => trimmed.toLowerCase().includes(verb));
  const tooShort = trimmed.length < MIN_WORK_CHARS;
  if (tooShort && !hasTaskVerb) return 'chat';
  if (hasTaskVerb) return 'work';
  if (MULTI_STEP.test(trimmed) && trimmed.length >= MIN_WORK_CHARS * 2) return 'work';
  return 'chat';
}

/** 工作标题：取第一句话，截到 60 字（列表与通知都靠它认人） */
export function titleFrom(text: string): string {
  const firstLine =
    text
      .trim()
      .split(/[\n。！？!?]/)[0]
      ?.trim() ?? '';
  const base = firstLine || text.trim();
  return base.length > 60 ? `${base.slice(0, 59)}…` : base;
}

// ── 新消息与已有工作的关联判定（E4.2，设计见 docs/架构设计.md §5） ──────────

export type WorkRelation = 'continue' | 'revise' | 'new_work' | 'chat' | 'ambiguous';

export interface WorkCandidate {
  id: string;
  title: string;
}

export interface WorkLinkDecision {
  relation: WorkRelation;
  /** continue / revise 指向哪件工作 */
  workId?: string;
  /** ambiguous 时的候选（交给模型短问用户） */
  candidates?: WorkCandidate[];
  /** 判定依据，写进日志/交付记录便于复盘 */
  reason: string;
}

/** 明确「这是另一件事」的措辞 */
const NEW_WORK_MARKERS = ['另外', '顺便', '还有个', '再一个', '新任务', '再帮我', '另一件', '换个事'];
/** 修订：在原有目标上收窄/改口 */
const REVISE_MARKERS = [
  '只测',
  '只做',
  '只跑',
  '只改',
  '先把',
  '改成',
  '改为',
  '换成',
  '调整为',
  '修订',
  '缩小到',
  '限定',
  '别再',
  '不要做',
  '不做',
  '先只',
  '范围改',
  '改成只',
];
/** 继续：指向已经开着的那件 */
const CONTINUE_MARKERS = ['继续', '接着', '然后', '下一步', '刚才', '上次', '进展', '怎么样了', '做到哪'];
/** 模糊指代：有多件工作时不足以判断指哪件 */
const VAGUE_REFERENCES = ['它', '那个', '这件', '那件', '这个', '刚才说的'];

function hasAny(text: string, markers: string[]): boolean {
  const lowered = text.toLowerCase();
  return markers.some((marker) => lowered.includes(marker.toLowerCase()));
}

/**
 * 把一条用户消息关联到工作（E4.2）。
 *
 * 优先级（设计文档 §5 第 3、5 条）：闲聊 → 全新 → 明确新事 → 修订 → 继续 →
 * 「多件且含糊」则交给人 → 默认接着最近那件（E4.1 行为）。
 * 含糊时不猜：返回候选，由调用方在回合里短问用户。
 */
export function linkUserMessage(
  text: string,
  openWorks: Array<{ id: string; title: string; updatedAt: number }>,
): WorkLinkDecision {
  // 顺序要紧：含糊的指代句往往很短（「继续弄那个」只有 5 个字），
  // 若先过 classifyUserMessage 的长度门槛就会被判成闲聊，再也走不到关联判定。
  // 所以「明确指向已有工作」的标志词优先，闲聊只在没有任何标志词时才认。
  const hasLinkMarker =
    hasAny(text, CONTINUE_MARKERS) || hasAny(text, REVISE_MARKERS) || hasAny(text, NEW_WORK_MARKERS);
  if (classifyUserMessage(text) === 'chat' && !hasLinkMarker) {
    return { relation: 'chat', reason: '问候/致谢/应答/纯提问，不涉及工作' };
  }
  if (openWorks.length === 0) {
    return { relation: 'new_work', reason: '当前没有未完成的工作' };
  }

  const recent = mostRecent(openWorks)!;
  if (hasAny(text, NEW_WORK_MARKERS)) {
    return { relation: 'new_work', reason: '出现「另外/顺便」这类新事标志词' };
  }

  const candidates: WorkCandidate[] = openWorks.map((item) => ({ id: item.id, title: item.title }));

  if (hasAny(text, REVISE_MARKERS)) {
    // 多件且只说「它/那个」：可能改错对象，交给用户确认
    if (openWorks.length > 1 && hasAny(text, VAGUE_REFERENCES)) {
      return { relation: 'ambiguous', candidates, reason: '有修订意图但指代不明，且有多件未完成工作' };
    }
    return { relation: 'revise', workId: recent.id, reason: '在已有目标上收窄或改口' };
  }

  if (hasAny(text, CONTINUE_MARKERS)) {
    if (openWorks.length > 1 && hasAny(text, VAGUE_REFERENCES)) {
      return { relation: 'ambiguous', candidates, reason: '有继续意图但指代不明，且有多件未完成工作' };
    }
    return { relation: 'continue', workId: recent.id, reason: '接着已有工作说' };
  }

  // 没给任何线索，但有多件未完成工作：不瞎猜
  if (openWorks.length > 1) {
    return { relation: 'ambiguous', candidates, reason: '有多件未完成工作，这条消息看不出接哪件' };
  }
  return { relation: 'continue', workId: recent.id, reason: '只有一件未完成工作，默认接着它' };
}

/** 含糊时给模型的问句（进 brief，让模型用 SendToUser widget 短问） */
export function clarificationQuestion(candidates: WorkCandidate[], text: string): string {
  const list = candidates.map((item, index) => `${index + 1}. ${item.title}`).join('；');
  return `这条消息（「${titleFrom(text)}」）可能接着下面某件工作，但看不太出来是哪件：${list}。先用 SendToUser 的 widget 问用户一句「这条是接着哪件」，选项用各件工作的标题，别自己猜。`;
}
