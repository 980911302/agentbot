/**
 * 敏感路径拒绝名单（OPT-07）：数据目录里的明文密钥与项目根的 `.env` 家族，
 * 本机文件工具默认不读不写；Shell 只能做保守的字面检查。
 *
 * 判定按**真实路径**（realpath，含数据目录自身是软链的情况），文件本身是软链
 * 或父目录是软链都挡得住；文件还不存在（Write）时回落到解析后的路径。
 *
 * 边界（不是沙箱）：命令里用变量、命令替换、编码后的文件名拼出来的路径挡不住。
 * 完整沙箱不在本任务范围（见 docs/工具参考.md「文件、网络与数据边界」）。
 */

import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/** 默认数据目录名（与 src/config.ts 的 DEFAULT_DATA_DIR 一致；这里不反向依赖 config） */
export const DEFAULT_DATA_DIR_NAME = '.agentbot';

/** 数据目录下按密钥对待的文件（相对 dataDir） */
export const SENSITIVE_DATA_FILES = ['secrets.json', 'model-config.json', 'room-flows/secret.key'] as const;

/** 项目根的 `.env` 家族里唯一允许读的：模板文件，不含密钥 */
export const ENV_EXAMPLE_FILE = '.env.example';

export interface SensitivePaths {
  rootDir: string;
  dataDir: string;
}

/** 统一的构造入口：调用方只给 rootDir 与真实数据目录 */
export function sensitivePaths(rootDir: string, dataDir?: string): SensitivePaths {
  const root = resolve(rootDir);
  return { rootDir: root, dataDir: resolve(dataDir ?? join(root, DEFAULT_DATA_DIR_NAME)) };
}

/** 给用户看的拒绝原因（要求里指定要说清「不是不能给，是不该由工具给」） */
export function secretRefusalMessage(path: string): string {
  return `拒绝访问密钥文件：${path}。本机工具默认不读写密钥；需要密钥请让用户在界面的密钥框里提供，并用 secretName 引用，不要直接读文件。`;
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path; // 文件还不存在 / 权限不足：按解析后的路径判断
  }
}

/** 项目根那一层的 `.env` 家族（`.env.example` 放行） */
function isEnvSecret(candidate: string, rootDir: string): boolean {
  if (dirname(candidate) !== rootDir) return false;
  const name = basename(candidate);
  if (name === ENV_EXAMPLE_FILE) return false;
  return name === '.env' || name.startsWith('.env.');
}

/**
 * 命中的敏感文件路径，没命中返回 undefined。
 * 两侧都做 realpath：数据目录自己可能是软链，只比一边会漏。
 */
export async function sensitivePathHit(
  candidate: string,
  paths: SensitivePaths,
): Promise<string | undefined> {
  const probes = [resolve(candidate)];
  const real = await realOrSelf(probes[0]!);
  if (real !== probes[0]) probes.push(real);
  const roots = [paths.rootDir];
  const realRoot = await realOrSelf(paths.rootDir);
  if (realRoot !== paths.rootDir) roots.push(realRoot);
  const dataDirs = [paths.dataDir];
  const realData = await realOrSelf(paths.dataDir);
  if (realData !== paths.dataDir) dataDirs.push(realData);

  for (const probe of probes) {
    for (const dataDir of dataDirs) {
      for (const rel of SENSITIVE_DATA_FILES) {
        if (probe === resolve(dataDir, rel)) return probe;
      }
    }
    for (const root of roots) {
      if (isEnvSecret(probe, root)) return probe;
    }
  }
  return undefined;
}

/** Read / Write / Edit / SearchFiles 的进门检查：命中即抛，错误信息面向用户 */
export async function assertNotSensitivePath(candidate: string, paths: SensitivePaths): Promise<void> {
  const hit = await sensitivePathHit(candidate, paths);
  if (hit) throw new Error(secretRefusalMessage(hit));
}

/** 目录扫描时用：命中的条目直接跳过（拿不到就不列举、不搜索） */
export async function isSensitivePath(candidate: string, paths: SensitivePaths): Promise<boolean> {
  return (await sensitivePathHit(candidate, paths)) !== undefined;
}

/** 命令里按分隔符切出来的路径 token（引号与 `process.env` 这类点号连写的都不算路径） */
const SHELL_TOKEN = /[^\s;|&()<>"'`]+/g;

/**
 * Shell 的保守字面检查：命令里出现敏感路径就拒绝，返回命中的片段。
 * 只认「能被 resolve 出来的字面路径」与「<数据目录名>/<密钥文件> 这样的片段」，
 * 因此 `$HOME/.agentbot/secrets.json` 挡得住，而 `process.env.PORT` 不会误伤。
 */
export function shellCommandSensitiveHit(command: string, paths: SensitivePaths): string | undefined {
  const dataDirName = basename(paths.dataDir);
  const fragments = SENSITIVE_DATA_FILES.flatMap((rel) => [
    join(DEFAULT_DATA_DIR_NAME, rel),
    join(dataDirName, rel),
  ]);
  for (const raw of command.match(SHELL_TOKEN) ?? []) {
    const token = raw.replace(/^[=:,]+/, '');
    if (!token || token.startsWith('-')) continue;
    const absolute = resolve(paths.rootDir, token);
    for (const candidate of [absolute, resolve(paths.dataDir, token)]) {
      if (isEnvSecret(candidate, paths.rootDir)) return raw;
      for (const rel of SENSITIVE_DATA_FILES) {
        if (candidate === resolve(paths.dataDir, rel)) return raw;
      }
    }
    for (const fragment of fragments) {
      if (token === fragment || token.endsWith('/' + fragment)) return raw;
    }
  }
  return undefined;
}

/** Shell 拒绝时的错误信息（工具层直接抛这个） */
export function shellRefusalMessage(command: string, hit: string): string {
  return `拒绝执行：命令里出现密钥文件「${hit}」。本机工具默认不读写密钥；需要密钥请让用户在界面的密钥框里提供，并用 secretName 引用。命令：${command.slice(0, 200)}`;
}
