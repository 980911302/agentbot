import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import {
  faceStateFromStatus,
  groupCompositeFaces,
  mentionCandidateList,
  mentionedRichModel,
  messageEnterKind,
  splitMentions,
  timelineLayoutKind,
} from '../web/src/features/chat/ui-chrome.ts';
import { layoutMentionParagraph, parseBlocks } from '../web/src/markdown.tsx';

describe('faceStateFromStatus', () => {
  it('maps idle / thinking / working and waiting / blocked / done when present', () => {
    assert.equal(faceStateFromStatus('idle'), 'idle');
    assert.equal(faceStateFromStatus('thinking'), 'thinking');
    assert.equal(faceStateFromStatus('working'), 'working');
    assert.equal(faceStateFromStatus('waiting'), 'waiting');
    assert.equal(faceStateFromStatus('blocked'), 'blocked');
    assert.equal(faceStateFromStatus('error'), 'blocked');
    assert.equal(faceStateFromStatus('done'), 'done');
    assert.equal(faceStateFromStatus('paused'), 'paused', '暂停是独立脸：闭眼灰度，不当成也没当成沉默');
    assert.equal(faceStateFromStatus(undefined), 'idle');
    assert.equal(faceStateFromStatus('queued'), 'working');
  });
});

describe('timelineLayoutKind', () => {
  it('uses two columns in 1:1 and a speaker stream in groups', () => {
    assert.equal(timelineLayoutKind({ isGroup: false, role: 'user' }), 'dm-user');
    assert.equal(timelineLayoutKind({ isGroup: false, role: 'assistant' }), 'dm-agent');
    assert.equal(timelineLayoutKind({ isGroup: true, role: 'user' }), 'group-stream');
    assert.equal(timelineLayoutKind({ isGroup: true, role: 'assistant' }), 'group-stream');
  });
});

describe('messageEnterKind', () => {
  it('maps user rows to pop and assistant/group-member rows to short rise', () => {
    assert.equal(messageEnterKind({ isGroup: false, role: 'user' }), 'pop');
    assert.equal(messageEnterKind({ isGroup: false, role: 'assistant' }), 'rise');
    assert.equal(messageEnterKind({ isGroup: true, role: 'user' }), 'pop');
    assert.equal(messageEnterKind({ isGroup: true, role: 'assistant' }), 'rise');
  });
});

describe('splitMentions', () => {
  it('highlights @成员 and @everyone', () => {
    const parts = splitMentions('请 @测试运维 和 @everyone 看一下', ['测试运维', '白泽']);
    assert.deepEqual(
      parts.filter((part) => part.mention).map((part) => part.text),
      ['@测试运维', '@everyone'],
    );
  });
});

describe('mentionedRichModel', () => {
  it('keeps @mentions in the same paragraph as surrounding text', () => {
    const model = mentionedRichModel('请 @测试运维 和 @everyone 看一下', ['测试运维']);
    assert.equal(model.length, 1);
    const block = model[0];
    assert.equal(block?.type, 'paragraph');
    if (block?.type !== 'paragraph') throw new Error('expected a paragraph');
    assert.deepEqual(
      block.parts.map((part) => part.text),
      ['请 ', '@测试运维', ' 和 ', '@everyone', ' 看一下'],
    );
    assert.deepEqual(
      block.parts.map((part) => Boolean(part.mention)),
      [false, true, false, true, false],
    );
    assert.equal(block.parts.map((part) => part.text).join(''), '请 @测试运维 和 @everyone 看一下');
  });

  it('does not emit a block per mention fragment', () => {
    const model = mentionedRichModel('请 @甲 看', ['甲']);
    assert.equal(model.filter((block) => block.type === 'paragraph').length, 1);
  });

  it('stays a single parseBlocks paragraph so RichText can keep mentions inline', () => {
    const text = '请 @测试运维 和 @everyone 看一下';
    const blocks = parseBlocks(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type, 'paragraph');
    if (blocks[0]?.type !== 'paragraph') throw new Error('expected a paragraph');
    const model = mentionedRichModel(blocks[0].content, ['测试运维']);
    assert.equal(model.length, 1);
    assert.equal(model[0]?.type, 'paragraph');
  });

  it('layoutMentionParagraph is one <p> with inline mention children, not sibling blocks', () => {
    const layout = layoutMentionParagraph('请 @测试运维 和 @everyone 看一下', ['测试运维']);
    assert.equal(layout.tag, 'p');
    assert.equal(layout.className, 'rich-p');
    assert.deepEqual(
      layout.children.map((child) => child.kind),
      ['text', 'mention', 'text', 'mention', 'text'],
    );
    assert.equal(layout.children.map((child) => child.text).join(''), '请 @测试运维 和 @everyone 看一下');
  });
});

describe('mentionCandidateList', () => {
  it('includes an everyone entry ahead of members', () => {
    const list = mentionCandidateList([{ id: 'a', name: '甲', color: '#111111' }]);
    assert.equal(list[0]?.name, 'everyone');
    assert.equal(list[0]?.id, '__everyone__');
    assert.equal(list.length, 2);
  });

  it('filters members and everyone by the typed query', () => {
    const members = [
      { id: 'a', name: '测试运维', color: '#111' },
      { id: 'b', name: '白泽', color: '#222' },
    ];
    const everyoneHits = mentionCandidateList(members, 'every');
    assert.deepEqual(everyoneHits.map((item) => item.name), ['everyone']);
    const nameHits = mentionCandidateList(members, '白');
    assert.deepEqual(nameHits.map((item) => item.name), ['白泽']);
  });
});

describe('groupCompositeFaces', () => {
  it('stacks 2–3 member faces and reports the remainder', () => {
    const two = groupCompositeFaces([
      { id: '1', name: 'A', color: '#1' },
      { id: '2', name: 'B', color: '#2' },
    ]);
    assert.equal(two.faces.length, 2);
    assert.equal(two.remainder, 0);

    const four = groupCompositeFaces([
      { id: '1', name: 'A', color: '#1' },
      { id: '2', name: 'B', color: '#2' },
      { id: '3', name: 'C', color: '#3' },
      { id: '4', name: 'D', color: '#4' },
    ]);
    assert.equal(four.faces.length, 3);
    assert.equal(four.remainder, 1);
    assert.deepEqual(four.faces.map((face) => face.id), ['1', '2', '3']);
  });
});

describe('zcode model settings chrome', () => {
  it('general prefs has no 全局活跃模型 and no Chat vs Reasoner catalog', () => {
    const src = readFileSync(join(ROOT, 'web/src/components/SettingsDialog.tsx'), 'utf8');
    assert.equal(src.includes('全局活跃模型'), false);
    const generalBlock = src.slice(
      src.indexOf('通用偏好'),
      src.indexOf('selectedProvider ?'),
    );
    assert.equal(generalBlock.includes('Chat'), false);
    assert.equal(generalBlock.includes('Reasoner'), false);
    assert.equal(/settings-section-title">默认模型/.test(src), false);
  });

  it('model settings keeps provider list, API key, enable, add provider and add model', () => {
    const src = readFileSync(join(ROOT, 'web/src/components/SettingsDialog.tsx'), 'utf8');
    assert.match(src, /模型设置/);
    assert.match(src, /添加服务商/);
    assert.match(src, /添加模型/);
    assert.match(src, /API Key/);
    assert.match(src, /已启用/);
    assert.match(src, /启用此服务商后显示其模型/);
  });

  it('composer source shows a model-name selector and 管理模型 in the bottom row', () => {
    const src = readFileSync(join(ROOT, 'web/src/components/Composer.tsx'), 'utf8');
    assert.match(src, /composer-model-bar/);
    assert.match(src, /composer-model-trigger/);
    assert.match(src, /管理模型/);
    const barAt = src.indexOf('composer-model-bar');
    const manageAt = src.indexOf('管理模型');
    assert.ok(barAt >= 0 && manageAt > barAt);
  });

  it('composer does not carry the thinking-level selector; it lives in model settings', () => {
    const src = readFileSync(join(ROOT, 'web/src/components/Composer.tsx'), 'utf8');
    assert.equal(src.includes('composer-thinking-trigger'), false);
    assert.equal(src.includes('thinkingLevel'), false);
    assert.equal(src.includes('onThinkingChange'), false);
    const settings = readFileSync(join(ROOT, 'web/src/components/SettingsDialog.tsx'), 'utf8');
    assert.match(settings, /思考等级/);
  });
});

describe('composer and group chrome must not grow new controls', () => {
  it('Composer source has no stop control', () => {
    const src = readFileSync(join(ROOT, 'web/src/components/Composer.tsx'), 'utf8');
    assert.match(src, /界面不做停止入口/);
    assert.equal(/aria-label=\{busy \? '停止'/.test(src), false);
    assert.equal(/capsule-action-btn stop/.test(src), false);
    assert.equal(/onClick=\{\(\) => .*stop/.test(src), false);
  });

  it('ChatView source does not insert a 正在回复 placeholder bubble', () => {
    const src = readFileSync(join(ROOT, 'web/src/components/ChatView.tsx'), 'utf8');
    assert.equal(src.includes('正在回复…'), false);
    assert.equal(/working-label">正在回复/.test(src), false);
    assert.equal(src.includes('className="msg-bubble-box working-bubble"'), false);
  });
});

describe('correspondence chrome is a single-line capsule and header row', () => {
  it('ships CSS for every class CorrespondenceView and ChatView actually use', () => {
    const css = readFileSync(join(ROOT, 'web/src/styles/05-chat.css'), 'utf8');
    const view = readFileSync(join(ROOT, 'web/src/components/CorrespondenceView.tsx'), 'utf8');
    const chat = readFileSync(join(ROOT, 'web/src/components/ChatView.tsx'), 'utf8');
    assert.match(view, /correspondence-single-peer/);
    assert.match(view, /correspondence-peer-identity/);
    assert.match(view, /correspondence-enter/);
    assert.match(chat, /correspondence-header-pair/);
    for (const selector of [
      '.correspondence-single-peer',
      '.correspondence-peer-identity',
      '.correspondence-enter',
      '.correspondence-header-pair',
      '.correspondence-peers',
      '.correspondence-avatars',
      '.correspondence-peer-menu',
      '.correspondence-open-hint',
    ]) {
      assert.match(css, new RegExp(selector.replace('.', '\\.')));
    }
    assert.match(css, /\.correspondence-peer-identity\s*\{[^}]*inline-flex/s);
    assert.match(css, /\.correspondence-peer-identity\s*\{[^}]*nowrap/s);
    assert.match(css, /\.correspondence-header-pair\s*\{[^}]*flex-direction:\s*row/s);
  });
});

describe('presence motion chrome', () => {
  it('ships user pop, ~8px assistant rise, 6–10px channel offset, composer glow, reduced-motion freeze', () => {
    const anim = readFileSync(join(ROOT, 'web/src/styles/08-animations.css'), 'utf8');
    const chatCss = readFileSync(join(ROOT, 'web/src/styles/05-chat.css'), 'utf8');
    const item = readFileSync(join(ROOT, 'web/src/components/MessageItem.tsx'), 'utf8');
    const living = readFileSync(join(ROOT, 'web/src/components/LivingAvatar.tsx'), 'utf8');
    const settings = readFileSync(join(ROOT, 'web/src/components/SettingsDialog.tsx'), 'utf8');

    assert.match(item, /messageEnterKind/);
    assert.match(item, /enter-\$\{enter\}/);
    assert.match(anim, /\.msg-row\.enter-pop/);
    assert.match(anim, /\.msg-row\.enter-rise/);
    assert.equal(/animation-delay/.test(item), false);

    assert.match(anim, /@keyframes pop/);
    assert.match(anim, /@keyframes msg-rise/);
    assert.match(anim, /translateY\(\s*8px\s*\)/);
    assert.equal(/100vh/.test(anim), false);
    assert.equal(/translateY\(\s*(1[5-9]|[2-9]\d|\d{3,})px\s*\)/.test(anim), false);

    assert.match(anim, /@keyframes swap-in/);
    assert.match(anim, /translateX\(\s*(6|7|8|9|10)px\s*\)/);
    assert.match(anim, /\.swap\s*\{[^}]*swap-in/s);

    assert.match(chatCss, /\.composer-capsule:focus-within[\s\S]{0,280}(--glow|--aura-glow)/);

    assert.match(anim, /prefers-reduced-motion:\s*reduce/);
    assert.match(anim, /\.living-avatar \.body[\s\S]{0,80}animation:\s*none/s);

    assert.match(living, /data-notice/);
    assert.match(living, /la-notice/);
    assert.equal(/animation:\s*la-notice[^;]*infinite/.test(living), false);

    assert.match(settings, /presence\.state/);
    assert.match(anim, /provider-settings-scrim\.(enter|enter-active)/);
  });
});

