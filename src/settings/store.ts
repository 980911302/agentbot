import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingFile, writeJsonAtomic } from '../storage/atomic-json.js';

/**
 * 主人级设置（E5.7）：主人名、时区、语言、通知偏好。
 *
 * 为什么要有它：主人名原先只活在前端 localStorage 里，每次群发送随请求体带上来，
 * 于是 CLI、定时运行、后台回合拿不到它——同一个用户在不同入口有不同的显示名。
 * 这里把这份配置落在数据目录，三个入口读同一份；密钥仍走 SecretStore，不放这里。
 *
 * 浏览器里剩下的只该是纯界面偏好（面板宽度、侧栏宽度、主题）。
 */

export type NotificationKey = 'done' | 'blocked' | 'needsAction';

export interface OwnerPreferences {
  /** 主人的显示名；群里和对话里都用它 */
  ownerName: string;
  /** IANA 时区，例如 Asia/Shanghai；空串表示跟随系统 */
  timezone: string;
  /** BCP 47 语言标签，例如 zh-CN；只存值，界面文案暂不翻译 */
  language: string;
  /** 通知开关：完成 / 阻塞 / 需要用户行动 */
  notifications: Record<NotificationKey, boolean>;
  updatedAt?: number;
}

export const DEFAULT_NOTIFICATIONS: Record<NotificationKey, boolean> = {
  done: true,
  blocked: true,
  needsAction: true,
};

export interface SettingsDefaults {
  ownerName: string;
  timezone?: string;
  language?: string;
}

const MAX_NAME_CHARS = 60;
const MAX_CODE_CHARS = 40;

/** 时区校验：能构造出 Intl 的就算合法（避免把 "Asia/Shangai" 这种拼写错误存进去） */
export function isValidTimezone(value: string): boolean {
  if (!value) return true; // 空 = 跟随系统
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

export class SettingsStore {
  private preferences: OwnerPreferences;

  constructor(
    private readonly dataDir: string,
    private readonly defaults: SettingsDefaults,
  ) {
    this.preferences = SettingsStore.fromDefaults(defaults);
  }

  private static fromDefaults(defaults: SettingsDefaults): OwnerPreferences {
    return {
      ownerName: defaults.ownerName,
      timezone: defaults.timezone ?? '',
      language: defaults.language ?? '',
      notifications: { ...DEFAULT_NOTIFICATIONS },
    };
  }

  private get file(): string {
    return join(this.dataDir, 'settings', 'preferences.json');
  }

  /** 当前值（拷贝，调用方改不到内部状态） */
  current(): OwnerPreferences {
    return { ...this.preferences, notifications: { ...this.preferences.notifications } };
  }

  /** 生效的主人名；永远非空（空的存不进来） */
  get ownerName(): string {
    return this.preferences.ownerName;
  }

  /**
   * 读盘。文件不存在用默认值（不写盘）；损坏则抛 SettingsError——
   * 静默用默认值会让用户以为设置被重置了（与 [E8.2] 的「不静默丢数据」一致）。
   */
  async load(): Promise<OwnerPreferences> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<OwnerPreferences>;
      this.preferences = SettingsStore.normalize(parsed, this.defaults);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new SettingsError(
          `主人设置读取失败：${this.file} 无法解析。去设置 → 通用偏好重新保存一次，或先备份数据目录。`,
          'SETTINGS_UNREADABLE',
        );
      }
      this.preferences = SettingsStore.fromDefaults(this.defaults);
    }
    return this.current();
  }

  /** 局部更新并落盘；只改传入的字段 */
  async update(patch: Partial<Omit<OwnerPreferences, 'updatedAt'>>): Promise<OwnerPreferences> {
    const next = SettingsStore.normalize(
      { ...this.preferences, ...patch, updatedAt: Date.now() },
      this.defaults,
    );
    await writeJsonAtomic(this.file, next, { mode: 0o600 });
    this.preferences = next;
    return this.current();
  }

  /** 校验 + 补默认；非法值一律报错，不做静默兜底 */
  private static normalize(input: Partial<OwnerPreferences>, defaults: SettingsDefaults): OwnerPreferences {
    const base = SettingsStore.fromDefaults(defaults);
    const ownerName = (input.ownerName ?? base.ownerName).trim();
    if (!ownerName) throw new SettingsError('主人名不能为空', 'INVALID_OWNER_NAME');
    if (ownerName.length > MAX_NAME_CHARS) {
      throw new SettingsError(`主人名最多 ${MAX_NAME_CHARS} 个字符`, 'INVALID_OWNER_NAME');
    }
    const timezone = (input.timezone ?? base.timezone).trim();
    if (timezone.length > MAX_CODE_CHARS || !isValidTimezone(timezone)) {
      throw new SettingsError(
        `时区无法识别：${timezone}（要用 IANA 名字，例如 Asia/Shanghai）`,
        'INVALID_TIMEZONE',
      );
    }
    const language = (input.language ?? base.language).trim();
    if (language.length > MAX_CODE_CHARS) {
      throw new SettingsError(`语言标签最多 ${MAX_CODE_CHARS} 个字符`, 'INVALID_LANGUAGE');
    }
    const notifications = { ...DEFAULT_NOTIFICATIONS };
    for (const key of Object.keys(DEFAULT_NOTIFICATIONS) as NotificationKey[]) {
      if (typeof input.notifications?.[key] === 'boolean') notifications[key] = input.notifications[key]!;
    }
    return {
      ownerName,
      timezone,
      language,
      notifications,
      ...(typeof input.updatedAt === 'number' ? { updatedAt: input.updatedAt } : {}),
    };
  }
}
