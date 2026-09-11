import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AgentRecord } from './types.js';

const COLORS = ['#8b5cf6', '#f5c33b', '#e5484d', '#30a46c', '#f76b15', '#0091ff', '#12a594', '#e93d82'];

export interface CreateAgentInput {
  name?: string;
  instructions?: string;
  toolNames?: string[];
  color?: string;
  projectIds?: string[];
}

export class AgentRegistry {
  private agents: AgentRecord[] = [];
  private loaded = false;
  private readonly file: string;

  constructor(
    private readonly dataDir: string,
    private readonly defaultToolNames: string[],
  ) {
    this.file = join(dataDir, 'agents.json');
  }

  async list(): Promise<AgentRecord[]> {
    await this.load();
    return [...this.agents].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async get(id: string): Promise<AgentRecord | undefined> {
    await this.load();
    return this.agents.find((agent) => agent.id === id);
  }

  async create(input: CreateAgentInput = {}): Promise<AgentRecord> {
    await this.load();
    const now = Date.now();
    const index = this.agents.length;
    const record: AgentRecord = {
      id: randomUUID(),
      name: (input.name ?? '').trim() || `Agent ${index + 1}`,
      instructions:
        (input.instructions ?? '').trim() ||
        '你是运行在用户本机上的 AI 助手。用用户的语言、以第一人称回复，语气直接简洁。需要更准确时优先调用工具。',
      toolNames: input.toolNames ?? [...this.defaultToolNames],
      color: input.color ?? COLORS[index % COLORS.length] ?? COLORS[0]!,
      projectIds: input.projectIds ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.agents.push(record);
    await this.save();
    return record;
  }

  async update(
    id: string,
    patch: Partial<Pick<AgentRecord, 'name' | 'instructions' | 'toolNames' | 'color' | 'projectIds'>>,
  ): Promise<AgentRecord | undefined> {
    await this.load();
    const record = this.agents.find((agent) => agent.id === id);
    if (!record) return undefined;
    if (patch.name !== undefined) record.name = patch.name.trim() || record.name;
    if (patch.instructions !== undefined) record.instructions = patch.instructions;
    if (patch.toolNames !== undefined) record.toolNames = patch.toolNames;
    if (patch.color !== undefined) record.color = patch.color;
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

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) this.agents = parsed as AgentRecord[];
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
