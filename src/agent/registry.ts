import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentRecord } from './types.js';
import { isMissingFile, writeJsonAtomic } from '../storage/atomic-json.js';

function clone(record: AgentRecord): AgentRecord {
  return { ...record, toolNames: [...record.toolNames], projectIds: [...record.projectIds] };
}

const COLORS = ['#8b5cf6', '#f5c33b', '#e5484d', '#30a46c', '#f76b15', '#0091ff', '#12a594', '#e93d82'];

export interface CreateAgentInput {
  name?: string;
  title?: string;
  description?: string;
  instructions?: string;
  toolNames?: string[];
  color?: string;
  avatar?: string;
  section?: string;
  projectIds?: string[];
}

/**
 * `update` 只接受这几个字段，且遵循「合并写入、禁止空覆盖」。
 *
 * 清理语义（E5.1）三态可区分：undefined = 未传（保持原值）；null = 主动清空（置空串）；
 * 空字符串 = 未传（历史语义，avatar 例外：空串历史上就等于清空，保留）。
 */
export interface AgentPatch {
  name?: string | null;
  title?: string | null;
  description?: string | null;
  instructions?: string | null;
  toolNames?: string[];
  color?: string | null;
  avatar?: string | null;
  section?: string | null;
  hidden?: boolean;
  projectIds?: string[];
}

import type { AgentRegistryPort } from '../storage/ports.js';

export class AgentRegistry implements AgentRegistryPort {
  private agents: AgentRecord[] = [];
  private loaded = false;
  private loading?: Promise<void>;
  private readonly file: string;
  private fileExisted = false;

  private defaultToolNames: string[];

  constructor(dataDir: string, defaultToolNames: string[] = []) {
    this.file = join(dataDir, 'agents.json');
    this.defaultToolNames = defaultToolNames;
  }

  async existed(): Promise<boolean> {
    await this.load();
    return this.fileExisted;
  }

  /** 运行时装配完工具后再补：新同事默认拿到全套 */
  setDefaultToolNames(names: string[]): void {
    this.defaultToolNames = names;
  }

  /** 只升级仍选择默认工具集的智能体，不覆盖用户显式设定的权限。 */
  async syncDefaultTools(): Promise<void> {
    await this.load();
    let changed = false;
    for (const record of this.agents) {
      if (record.toolPolicy !== 'default') continue;
      const missing = this.defaultToolNames.filter(name => !record.toolNames.includes(name));
      if (!missing.length) continue;
      record.toolNames = [...record.toolNames, ...missing];
      record.updatedAt = Date.now();
      changed = true;
    }
    if (changed) await this.save();
  }

  /**
   * 返回快照（拷贝）。
   * 直接把缓存对象交出去，调用方之后看到的「旧值」会跟着 store 一起变。
   */
  async list(): Promise<AgentRecord[]> {
    await this.load();
    return [...this.agents].sort((left, right) => right.updatedAt - left.updatedAt).map(clone);
  }

  async get(id: string): Promise<AgentRecord | undefined> {
    await this.load();
    const record = this.agents.find((agent) => agent.id === id);
    return record ? clone(record) : undefined;
  }

  /** 按名字找（点名、避免重名时用） */
  async findByName(name: string): Promise<AgentRecord | undefined> {
    await this.load();
    const wanted = name.trim().toLowerCase();
    const record = this.agents.find((agent) => agent.name.toLowerCase() === wanted);
    return record ? clone(record) : undefined;
  }

  async listSections(): Promise<string[]> {
    await this.load();
    return [...new Set(this.agents.map((agent) => agent.section).filter((id): id is string => Boolean(id)))];
  }

  async create(input: CreateAgentInput = {}): Promise<AgentRecord> {
    await this.load();
    const now = Date.now();
    const index = this.agents.length;
    const record: AgentRecord = {
      id: randomUUID(),
      name: (input.name ?? '').trim() || `Agent ${index + 1}`,
      title: (input.title ?? '').trim(),
      description: (input.description ?? '').trim(),
      instructions:
        (input.instructions ?? '').trim() ||
        '通用助手，先按当前话意自然交流；用户明确交办任务时，使用可用能力推进并交付可验证的结果。',
      toolNames: input.toolNames ?? [...this.defaultToolNames],
      toolPolicy: input.toolNames === undefined ? 'default' : 'explicit',
      color: input.color ?? COLORS[index % COLORS.length] ?? COLORS[0]!,
      avatar: input.avatar,
      section: input.section,
      projectIds: input.projectIds ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.agents.push(record);
    await this.save();
    return record;
  }

  async createIfAbsent(id: string, input: CreateAgentInput = {}): Promise<AgentRecord> {
    await this.load();
    const existing = this.agents.find((agent) => agent.id === id);
    if (existing) {
      const name = (input.name ?? '').trim();
      if (name && existing.name !== name) throw new Error('AGENT_ID_CONFLICT');
      return clone(existing);
    }
    const now = Date.now();
    const record: AgentRecord = {
      id,
      name: (input.name ?? '').trim() || `Agent ${this.agents.length + 1}`,
      title: (input.title ?? '').trim(),
      description: (input.description ?? '').trim(),
      instructions:
        (input.instructions ?? '').trim() ||
        '通用助手，先按当前话意自然交流；用户明确交办任务时，使用可用能力推进并交付可验证的结果。',
      toolNames: input.toolNames ?? [...this.defaultToolNames],
      toolPolicy: input.toolNames === undefined ? 'default' : 'explicit',
      color: input.color ?? COLORS[this.agents.length % COLORS.length] ?? COLORS[0]!,
      avatar: input.avatar,
      section: input.section,
      projectIds: input.projectIds ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.agents.push(record);
    await this.save();
    return clone(record);
  }

  /**
   * 合并写入：未传的字段保持原值。
   * 空字符串等同「没传」，避免把资料抹空（规格：禁止空覆盖）；null 是显式的「清空」。
   */
  async update(id: string, patch: AgentPatch): Promise<AgentRecord | undefined> {
    await this.load();
    const record = this.agents.find((agent) => agent.id === id);
    if (!record) return undefined;

    const text = (value: string | null | undefined): string | undefined => {
      if (value === undefined) return undefined;
      if (value === null) return ''; // 主动清空
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    };

    const name = text(patch.name);
    if (name !== undefined) record.name = name;
    const title = text(patch.title);
    if (title !== undefined) record.title = title;
    const description = text(patch.description);
    if (description !== undefined) record.description = description;
    const instructions = text(patch.instructions);
    if (instructions !== undefined) record.instructions = instructions;
    // avatar：null 与空串都表示「清空」（空串是历史语义，保留）；未传则不动
    const avatar =
      patch.avatar === undefined
        ? undefined
        : patch.avatar === null || patch.avatar.trim() === ''
          ? ''
          : patch.avatar.trim();
    if (avatar !== undefined) record.avatar = avatar;
    const section = text(patch.section);
    if (section !== undefined) record.section = section;
    const color = text(patch.color);
    if (color !== undefined) record.color = color;
    if (patch.toolNames !== undefined) {
      record.toolNames = [...patch.toolNames];
      record.toolPolicy = 'explicit';
    }
    if (patch.hidden !== undefined) record.hidden = patch.hidden;
    if (patch.projectIds !== undefined) record.projectIds = patch.projectIds;

    record.updatedAt = Date.now();
    await this.save();
    return record;
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    const before = this.agents.length;
    this.agents = this.agents.filter((agent) => agent.id !== id);
    if (this.agents.length === before) return false;
    await this.save();
    return true;
  }

  /** 读旧格式（可能没有 title/description）时的兜底 */
  private static normalize(record: Partial<AgentRecord> & { id: string; name: string }): AgentRecord {
    return {
      id: record.id,
      name: record.name,
      title: record.title ?? '',
      description: record.description ?? '',
      instructions: record.instructions ?? '',
      toolNames: record.toolNames ?? [],
      toolPolicy: record.toolPolicy ?? (record.toolNames === undefined ? 'default' : 'explicit'),
      color: record.color ?? COLORS[0]!,
      avatar: record.avatar,
      section: record.section,
      hidden: record.hidden,
      projectIds: record.projectIds ?? [],
      createdAt: record.createdAt ?? Date.now(),
      updatedAt: record.updatedAt ?? Date.now(),
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const raw = await readFile(this.file, 'utf8');
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            this.agents = parsed.map((item) =>
              AgentRegistry.normalize(item as Partial<AgentRecord> & { id: string; name: string }),
            );
          }
          this.fileExisted = true;
        } catch (error) {
          if (!isMissingFile(error)) throw error;
          this.agents = [];
          this.fileExisted = false;
        }
        this.loaded = true;
      })();
    }
    try {
      await this.loading;
    } finally {
      if (this.loaded) this.loading = undefined;
    }
  }

  private async save(): Promise<void> {
    await writeJsonAtomic(this.file, this.agents);
  }
}

export { COLORS as AGENT_COLORS };
