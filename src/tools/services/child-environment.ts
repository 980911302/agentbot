/**
 * 子进程环境变量白名单（bug_cge6m9yewecs）。
 *
 * .env 里的 AGENT_API_KEY 等密钥会被 loadEnvFile 写进 process.env，spawn 不传 env
 * 时子进程原样继承——智能体一句 `env` 就能把密钥读进模型上下文和落盘日志，
 * 网页内容注入也能诱导它外发。所以命令执行的环境必须显式给出，只留必要的部分。
 */

/** 子进程必须有的东西：路径解析、locale、临时目录、终端描述 */
const ALLOWED_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'npm_config_cache',
  'NODE_OPTIONS',
]);

/**
 * 前缀放行：版本管理与工具链。这里刻意不含 AGENT_/OPENAI_——
 * 那正是密钥和运行配置的来源，任何以它们开头的变量都不给子进程。
 */
const ALLOWED_PREFIXES = ['npm_config_', 'NODE_', 'NPM_'];

/**
 * 从当前进程环境里挑出允许继承的部分。
 *
 * 白名单而不是黑名单：blacklist 漏一个变量名就是一次密钥泄露，
 * 而白名单默认拒绝，新加的密钥变量（AGENT_SECRET_* 之类）自动被挡住。
 */
export function childEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ALLOWED_EXACT.has(name) || ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      env[name] = value;
    }
  }

  // Windows 的 PATH 之外还需要这两个，否则 npm/node 都起不来
  if (platform === 'win32') {
    for (const name of ['SystemRoot', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'WINDIR']) {
      if (source[name] !== undefined) env[name] = source[name];
    }
  }
  return env;
}
