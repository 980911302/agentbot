import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AgentRecord } from './types.js';

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

/** `update` 只接受这几个字段，且遵循「合并写入、禁止空覆盖」 */
export type AgentPatch = Partial<
  Pick<
    AgentRecord,
    'name' | 'title' | 'description' | 'instructions' | 'toolNames' | 'color' | 'avatar' | 'section' | 'hidden' | 'projectIds'
  >
>;

export class AgentRegistry {
  private agents: AgentRecord[] = [];
  private loaded = false;
  private readonly file: string;

  private defaultToolNames: string[];

  constructor(dataDir: string, defaultToolNames: string[] = []) {
    this.file = join(dataDir, 'agents.json');
    this.defaultToolNames = defaultToolNames;
  }

  /** 运行时装配完工具后再补：新同事默认拿到全套 */
  setDefaultToolNames(names: string[]): void {
    this.defaultToolNames = names;
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
        '用用户的语言、以第一人称回复，语气直接简洁。需要更准确时优先调用工具。',
      toolNames: input.toolNames ?? [...this.defaultToolNames],
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

  /**
   * 合并写入：未传的字段保持原值。
   * 空字符串等同「没传」，避免把资料抹空（规格：禁止空覆盖）。
   */
  async update(id: string, patch: AgentPatch): Promise<AgentRecord | undefined> {
    await this.load();
    const record = this.agents.find((agent) => agent.id === id);
    if (!record) return undefined;

    const text = (value: string | undefined): string | undefined => {
      if (value === undefined) return undefined;
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
    const avatar = text(patch.avatar);
    if (avatar !== undefined) record.avatar = avatar;
    const section = text(patch.section);
    if (section !== undefined) record.section = section;
    if (patch.color !== undefined && patch.color.trim() !== '') record.color = patch.color.trim();
    if (patch.toolNames !== undefined && patch.toolNames.length > 0) {
      record.toolNames = patch.toolNames;
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
    this.loaded = true;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        this.agents = parsed.map((item) =>
          AgentRegistry.normalize(item as Partial<AgentRecord> & { id: string; name: string }),
        );
      }
    } catch {
      this.agents = [];
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.agents, null, 2), 'utf8');
  }
}

export { COLORS as AGENT_COLORS };
