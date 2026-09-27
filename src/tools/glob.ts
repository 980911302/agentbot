/**
 * ListFiles / SearchFiles 的 glob 过滤（纯函数，不碰文件系统）。
 *
 * 语法：`*` 不跨目录、`**` 跨目录、`?` 单个字符、`{a,b}` 任选其一、`[abc]` / `[!abc]` 字符集。
 * 不含 `/` 的模式只看文件名（`*.ts` 能匹配任意深度的 ts 文件），含 `/` 的按相对搜索根的路径整体匹配。
 * 大小写敏感；路径分隔符统一按 `/` 比较。
 */
export function globMatcher(pattern: string): (relativePath: string) => boolean {
  const normalized = pattern
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    // 连续的 `**/` 与 `***` 语义相同，先合并，避免生成层层嵌套、回溯爆炸的正则
    .replace(/(\*\*\/)+/g, '**/')
    .replace(/\*{3,}/g, '**');
  if (!normalized) throw new Error('glob 不能为空');
  if ((normalized.match(/\*/g)?.length ?? 0) > 12) throw new Error('glob 通配符太多，请简化后再试');
  const byName = !normalized.includes('/');
  const regex = new RegExp(`^${globSource(normalized)}$`);
  return (relativePath) => {
    const path = relativePath.replace(/\\/g, '/');
    return regex.test(byName ? path.slice(path.lastIndexOf('/') + 1) : path);
  };
}

function globSource(pattern: string): string {
  let source = '';
  let braces = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        const slashAfter = pattern[index + 2] === '/';
        // `**/` 可以是零层或多层目录；结尾的 `**` 匹配剩下的一切
        source += slashAfter ? '(?:.*/)?' : '.*';
        index += slashAfter ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const close = pattern.indexOf(']', index + 2);
      if (close < 0) {
        source += '\\[';
        continue;
      }
      let body = pattern.slice(index + 1, close).replace(/\\/g, '\\\\');
      if (body.startsWith('!')) body = '^' + body.slice(1);
      source += `[${body}]`;
      index = close;
    } else if (char === '{') {
      braces++;
      source += '(?:';
    } else if (char === '}' && braces > 0) {
      braces--;
      source += ')';
    } else if (char === ',' && braces > 0) {
      source += '|';
    } else {
      source += char.replace(/[.+^$()|\\{}\]]/g, '\\$&');
    }
  }
  return source + ')'.repeat(braces);
}
