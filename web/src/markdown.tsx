import { Fragment, useState, type ReactNode } from 'react';
import { splitMentions } from './features/chat/ui-chrome';

export type Block =
  | { type: 'heading'; level: number; content: string }
  | { type: 'code'; language: string; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; content: string }
  | { type: 'hr' }
  | { type: 'table'; header: string[]; align: TableAlign[]; rows: string[][] }
  | { type: 'paragraph'; content: string };

export type TableAlign = 'left' | 'center' | 'right' | null;

/** GFM 表格的分隔行：| --- | :---: | ---: |（至少一个竖线或两列） */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** 把一行按竖线切成单元格：去掉首尾竖线，支持 \| 转义 */
export function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === '\\' && body[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** 这一行和下一行能不能组成表格的开头：表头带竖线，下一行是分隔行且列数一致 */
function isTableStart(line: string, next: string | undefined): boolean {
  if (!line.includes('|') || next === undefined || !TABLE_SEPARATOR.test(next)) return false;
  if (!next.includes('|') && !line.trim().startsWith('|')) return false;
  return splitTableRow(line).length === splitTableRow(next).length;
}

function tableAlign(cell: string): TableAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/** 剥掉历史消息里残留的思维链段落，只留可见正文（复制用；渲染侧由 parseBlocks 丢弃）。
 *  实现在 features/chat/thinking.ts，与导出会话共用；这里保留导出，调用方不用改。 */
export { stripThinkingBlocks } from './features/chat/thinking';

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 0. Thinking block (<think>...</think>)
    // 思维链不再展示：解析出来直接丢弃，历史消息里残留的段落也不会渲染成折叠框
    if (line.trimStart().startsWith('<think>')) {
      if (!line.includes('</think>')) {
        i += 1;
        while (i < lines.length && !lines[i]!.includes('</think>')) {
          i += 1;
        }
        if (i < lines.length) i += 1;
      } else {
        i += 1;
      }
      continue;
    }


    // 1. Code fence
    if (line.trimStart().startsWith('```')) {
      const language = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({
        type: 'code',
        language: language || 'text',
        content: codeLines.join('\n'),
      });
      continue;
    }

    // 2. Horizontal rule
    if (/^(---|___|\*\*\*)\s*$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // 3. Headings
    const headingMatch = line.match(/^(#{1,4})\s+(\S.*)$/);
    if (headingMatch) {
      const hashes = headingMatch[1] ?? '#';
      const headingContent = headingMatch[2] ?? '';
      blocks.push({
        type: 'heading',
        level: hashes.length,
        content: headingContent,
      });
      i += 1;
      continue;
    }

    // 4. Blockquote
    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i]!.startsWith('>') || (lines[i]!.trim() && !lines[i]!.startsWith('#')))) {
        if (!lines[i]!.startsWith('>')) break;
        quoteLines.push(lines[i]!.replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({
        type: 'quote',
        content: quoteLines.join('\n'),
      });
      continue;
    }

    // 5. Unordered list
    if (/^(\s*)[-*+]\s+(\S.*)$/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^(\s*)[-*+]\s+(\S.*)$/.test(lines[i]!)) {
        const match = lines[i]!.match(/^(\s*)[-*+]\s+(\S.*)$/);
        if (match && match[2]) listItems.push(match[2]);
        i += 1;
      }
      blocks.push({
        type: 'list',
        ordered: false,
        items: listItems,
      });
      continue;
    }

    // 6. Ordered list
    if (/^(\s*)\d+\.\s+(\S.*)$/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^(\s*)\d+\.\s+(\S.*)$/.test(lines[i]!)) {
        const match = lines[i]!.match(/^(\s*)\d+\.\s+(\S.*)$/);
        if (match && match[2]) listItems.push(match[2]);
        i += 1;
      }
      blocks.push({
        type: 'list',
        ordered: true,
        items: listItems,
      });
      continue;
    }

    // 7. GFM table：表头 + 分隔行 + 若干数据行（遇到空行或不含竖线的行结束）
    if (isTableStart(line, lines[i + 1])) {
      const header = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]!).map(tableAlign);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) {
        const cells = splitTableRow(lines[i]!);
        // 列数不齐时补空或截断，按表头对齐
        rows.push(header.map((_, column) => cells[column] ?? ''));
        i += 1;
      }
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }

    // 8. Empty line
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 9. Paragraph lines
    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !lines[i]!.trimStart().startsWith('```') &&
      // 只把合法 Markdown 标题留给下一轮处理。单独的 `#`、`#foo`
      // 或五级以上标题都应按普通段落消费，否则 i 不前进，会把渲染器跑到 OOM。
      !/^(#{1,4})\s+(\S.*)$/.test(lines[i]!) &&
      !lines[i]!.startsWith('>') &&
      !/^(\s*)[-*+]\s+(\S.*)$/.test(lines[i]!) &&
      !/^(\s*)\d+\.\s+(\S.*)$/.test(lines[i]!) &&
      !/^(---|___|\*\*\*)\s*$/.test(lines[i]!.trim()) &&
      !isTableStart(lines[i]!, lines[i + 1])
    ) {
      paragraphLines.push(lines[i]!);
      i += 1;
    }
    // 防御性进度保证：即使上面的识别规则以后再次出现边界不一致，
    // 也必须把当前行当普通文本消费，绝不能让 while 原地空转到 OOM。
    if (paragraphLines.length === 0) {
      paragraphLines.push(lines[i]!);
      i += 1;
    }
    blocks.push({
      type: 'paragraph',
      content: paragraphLines.join('\n'),
    });
  }

  return blocks;
}

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'image'; alt: string; src: string };

const INLINE_PATTERN =
  /(!\[[^\]]*\]\([^)\s]+\)|\[[^\]]+\]\([^)\s]+\)|`[^`\n]+`|\*\*[^*]+?\*\*|\*[^*]+?\*|https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%()[\]]+)/g;

/** 只放行 http/https/mailto 链接；javascript: 等协议当普通文字 */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}

/**
 * 图片能不能直接显示：CSP 的 img-src 只允许同源与 data:，
 * 所以只有 data:image/*、同源相对路径才画 <img>；外链图片退化成链接，免得出一个裂图。
 */
export function inlineImageSrc(src: string): string | null {
  const trimmed = src.trim();
  if (/^data:image\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  return null;
}

/** 裸网址末尾的标点（中英文）不算网址的一部分 */
function trimUrlTail(url: string): { url: string; tail: string } {
  const match = url.match(/[.,;:!?)\]}'"，。；：！？、）》」』]+$/);
  if (!match) return { url, tail: '' };
  return { url: url.slice(0, -match[0].length), tail: match[0] };
}

/** 行内标记 → 片段：链接、图片、裸网址、行内代码、粗体、斜体；供渲染与单测共用 */
export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = tokens.at(-1);
    if (last?.kind === 'text') last.text += value;
    else tokens.push({ kind: 'text', text: value });
  };
  for (const part of text.split(INLINE_PATTERN)) {
    if (!part) continue;
    const image = part.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (image) {
      tokens.push({ kind: 'image', alt: image[1] ?? '', src: image[2] ?? '' });
      continue;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link && link[1] && link[2]) {
      const href = safeHref(link[2]);
      if (href) tokens.push({ kind: 'link', text: link[1], href });
      else pushText(link[1]);
      continue;
    }
    if (/^https?:\/\//i.test(part)) {
      const { url, tail } = trimUrlTail(part);
      tokens.push({ kind: 'link', text: url, href: url });
      pushText(tail);
      continue;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      tokens.push({ kind: 'code', text: part.slice(1, -1) });
      continue;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      tokens.push({ kind: 'strong', text: part.slice(2, -2) });
      continue;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      tokens.push({ kind: 'em', text: part.slice(1, -1) });
      continue;
    }
    pushText(part);
  }
  return tokens;
}

function renderInline(text: string): ReactNode[] {
  return tokenizeInline(text).map((token, index) => {
    switch (token.kind) {
      case 'link':
        return (
          <a key={index} href={token.href} target="_blank" rel="noopener noreferrer" className="rich-link">
            {token.text}
          </a>
        );
      case 'image': {
        const src = inlineImageSrc(token.src);
        if (src) return <img key={index} src={src} alt={token.alt} className="rich-image" loading="lazy" />;
        const href = safeHref(token.src);
        const label = `图片：${token.alt || token.src}`;
        return href ? (
          <a key={index} href={href} target="_blank" rel="noopener noreferrer" className="rich-link">
            {label}
          </a>
        ) : (
          <span key={index}>{label}</span>
        );
      }
      case 'code':
        return (
          <code key={index} className="rich-inline-code">
            {token.text}
          </code>
        );
      case 'strong':
        return <strong key={index}>{token.text}</strong>;
      case 'em':
        return <em key={index}>{token.text}</em>;
      default:
        return <span key={index}>{token.text}</span>;
    }
  });
}

function CodeBlock({ language, content }: { language: string; content: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="code-block-wrapper">
      <div className="code-block-head">
        <span className="code-block-lang">{language || 'code'}</span>
        <button
          type="button"
          className={`code-copy-btn${copied ? ' copied' : ''}`}
          onClick={copy}
          title="复制代码"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="code-block-pre">
        <code>{content}</code>
      </pre>
    </div>
  );
}

/** 段内 @ 与前后文同属一个 <p>，不把每个碎片包成块级 RichText。 */
export function layoutMentionParagraph(content: string, mentionNames: string[]): {
  tag: 'p';
  className: 'rich-p';
  children: Array<{ kind: 'mention' | 'text'; text: string }>;
} {
  return {
    tag: 'p',
    className: 'rich-p',
    children: splitMentions(content, mentionNames).map((part) => ({
      kind: part.mention ? 'mention' : 'text',
      text: part.text,
    })),
  };
}

function renderParagraphWithMentions(content: string, mentionNames: string[], key: number) {
  const layout = layoutMentionParagraph(content, mentionNames);
  return (
    <p key={key} className={layout.className}>
      {layout.children.map((child, index) =>
        child.kind === 'mention' ? (
          <span className="mention" key={index}>
            {child.text}
          </span>
        ) : (
          <Fragment key={index}>{renderInline(child.text)}</Fragment>
        ),
      )}
    </p>
  );
}

export function RichText({ text, mentionNames = [] }: { text: string; mentionNames?: string[] }) {
  const blocks = parseBlocks(text);

  return (
    <div className="rich-text-container">
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading': {
            if (block.level === 1) return <h3 key={index} className="rich-h1">{renderInline(block.content)}</h3>;
            if (block.level === 2) return <h4 key={index} className="rich-h2">{renderInline(block.content)}</h4>;
            return <h5 key={index} className="rich-h3">{renderInline(block.content)}</h5>;
          }
          case 'code':
            return <CodeBlock key={index} language={block.language} content={block.content} />;
          case 'list': {
            const ListTag = block.ordered ? 'ol' : 'ul';
            return (
              <ListTag key={index} className="rich-list">
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInline(item)}</li>
                ))}
              </ListTag>
            );
          }
          case 'quote':
            return (
              <blockquote key={index} className="rich-quote">
                {renderInline(block.content)}
              </blockquote>
            );
          case 'hr':
            return <hr key={index} className="rich-hr" />;
          case 'table':
            return (
              <div key={index} className="rich-table-wrap">
                <table className="rich-table">
                  <thead>
                    <tr>
                      {block.header.map((cell, column) => (
                        <th key={column} style={block.align[column] ? { textAlign: block.align[column]! } : undefined}>
                          {renderInline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, column) => (
                          <td key={column} style={block.align[column] ? { textAlign: block.align[column]! } : undefined}>
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'paragraph':
          default:
            if (mentionNames.length > 0 && block.type === 'paragraph') {
              return renderParagraphWithMentions(block.content, mentionNames, index);
            }
            return (
              <p key={index} className="rich-p">
                {renderInline(block.content)}
              </p>
            );
        }
      })}
    </div>
  );
}
