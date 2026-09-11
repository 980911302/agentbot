import { useState, type ReactNode } from 'react';

type Block =
  | { type: 'heading'; level: number; content: string }
  | { type: 'code'; language: string; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; content: string }
  | { type: 'hr' }
  | { type: 'paragraph'; content: string };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

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
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
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
    if (/^(\s*)[-*+]\s+(.+)$/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^(\s*)[-*+]\s+(.+)$/.test(lines[i]!)) {
        const match = lines[i]!.match(/^(\s*)[-*+]\s+(.+)$/);
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
    if (/^(\s*)\d+\.\s+(.+)$/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^(\s*)\d+\.\s+(.+)$/.test(lines[i]!)) {
        const match = lines[i]!.match(/^(\s*)\d+\.\s+(.+)$/);
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

    // 7. Empty line
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 8. Paragraph lines
    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !lines[i]!.trimStart().startsWith('```') &&
      !lines[i]!.startsWith('#') &&
      !lines[i]!.startsWith('>') &&
      !/^(\s*)[-*+]\s+/.test(lines[i]!) &&
      !/^(\s*)\d+\.\s+/.test(lines[i]!) &&
      !/^(---|___|\*\*\*)\s*$/.test(lines[i]!.trim())
    ) {
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

function renderInline(text: string): ReactNode[] {
  const pattern = /(\[[^\]]+\]\([^)]+\)|`[^`\n]+`|\*\*[^*]+?\*\*|\*[^*]+?\*)/g;
  const parts = text.split(pattern);

  return parts.map((part, index) => {
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch && linkMatch[1] && linkMatch[2]) {
      return (
        <a
          key={index}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="rich-link"
        >
          {linkMatch[1]}
        </a>
      );
    }

    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code key={index} className="rich-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }

    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }

    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }

    return <span key={index}>{part}</span>;
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
          {copied ? '✓ 已复制' : '复制'}
        </button>
      </div>
      <pre className="code-block-pre">
        <code>{content}</code>
      </pre>
    </div>
  );
}

export function RichText({ text }: { text: string }) {
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
          case 'paragraph':
          default:
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
