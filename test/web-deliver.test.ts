import { strict as assert } from 'node:assert';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DeliverPathError,
  deliverRoots,
  resolveDeliverPath,
} from '../src/tools/examples/deliver.js';
import {
  assertPublicUrl,
  htmlToText,
  isAdLink,
  isPrivateAddress,
  parseDuckDuckGo,
  unwrapDuckDuckGoUrl,
  UnsafeUrlError,
} from '../src/tools/examples/web.js';

/** 覆盖 docs/工具参考.md 中的安全边界 */
describe('联网工具', () => {
  describe('内网地址识别', () => {
    const privates = [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.254',
      '169.254.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
    ];
    for (const ip of privates) {
      it(`${ip} 判为内网`, () => assert.equal(isPrivateAddress(ip), true, ip));
    }

    const publics = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2001:4860:4860::8888'];
    for (const ip of publics) {
      it(`${ip} 判为公网`, () => assert.equal(isPrivateAddress(ip), false, ip));
    }
  });

  describe('URL 校验（SSRF 防护）', () => {
    it('拒绝非 http(s) 协议', async () => {
      await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), UnsafeUrlError);
      await assert.rejects(() => assertPublicUrl('ftp://example.com'), UnsafeUrlError);
    });

    it('拒绝 localhost', async () => {
      await assert.rejects(() => assertPublicUrl('http://localhost:3000'), UnsafeUrlError);
      await assert.rejects(() => assertPublicUrl('http://foo.localhost/'), UnsafeUrlError);
      await assert.rejects(() => assertPublicUrl('http://printer.local/'), UnsafeUrlError);
    });

    it('拒绝直接写内网 IP', async () => {
      await assert.rejects(() => assertPublicUrl('http://127.0.0.1/'), UnsafeUrlError);
      await assert.rejects(() => assertPublicUrl('http://192.168.1.1/admin'), UnsafeUrlError);
      await assert.rejects(() => assertPublicUrl('http://10.0.0.1/'), UnsafeUrlError);
    });

    it('拒绝不合法的 URL', async () => {
      await assert.rejects(() => assertPublicUrl('不是网址'), UnsafeUrlError);
    });
  });

  describe('HTML 转文本', () => {
    it('去掉脚本与样式', () => {
      const text = htmlToText('<p>正文</p><script>alert(1)</script><style>.a{}</style>');
      assert.ok(text.includes('正文'));
      assert.ok(!text.includes('alert'));
      assert.ok(!text.includes('.a{}'));
    });

    it('块级标签转成换行', () => {
      const text = htmlToText('<h1>标题</h1><p>第一段</p><p>第二段</p>');
      assert.equal(text.split('\n').filter(Boolean).length, 3);
    });

    it('列表项带短横线', () => {
      const text = htmlToText('<ul><li>甲</li><li>乙</li></ul>');
      assert.ok(text.includes('- 甲'));
    });

    it('解码常见实体', () => {
      assert.ok(htmlToText('<p>a &amp; b &lt;c&gt;</p>').includes('a & b <c>'));
    });
  });

  describe('搜索结果解析', () => {
    it('解出 DDG 的跳转链接', () => {
      const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=x';
      assert.equal(unwrapDuckDuckGoUrl(href), 'https://example.com/page');
    });

    it('直接链接原样返回', () => {
      assert.equal(unwrapDuckDuckGoUrl('https://example.com/a'), 'https://example.com/a');
    });

    it('解析结果列表', () => {
      const html = `
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com">第一条</a>
        <a class="result__snippet">摘要一</a>
        <a class="result__a" href="https://b.com">第二条</a>
        <a class="result__snippet">摘要二</a>
      `;
      const results = parseDuckDuckGo(html, 5);
      assert.equal(results.length, 2);
      assert.equal(results[0]?.url, 'https://a.com');
      assert.equal(results[0]?.title, '第一条');
      assert.equal(results[0]?.snippet, '摘要一');
      assert.equal(results[1]?.url, 'https://b.com');
    });

    it('过滤掉广告位链接', () => {
      const html = `
        <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=udemy.com">广告</a>
        <a class="result__snippet">广告摘要</a>
        <a class="result__a" href="https://real.example.com">真结果</a>
        <a class="result__snippet">真摘要</a>
      `;
      const results = parseDuckDuckGo(html, 5);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.url, 'https://real.example.com');
    });

    it('isAdLink 识别广告位', () => {
      assert.equal(isAdLink('https://duckduckgo.com/y.js?ad_domain=x.com'), true);
      assert.equal(isAdLink('https://example.com/y.js'), false, '别家域的 .js 不算');
      assert.equal(isAdLink('https://example.com/page'), false);
    });

    it('遵守条数上限', () => {
      const item = '<a class="result__a" href="https://x.com">t</a><a class="result__snippet">s</a>';
      assert.equal(parseDuckDuckGo(item.repeat(10), 3).length, 3);
    });
  });
});

describe('文件投递', () => {
  const roots = [join(homedir(), 'Downloads'), join(homedir(), 'Desktop'), join(homedir(), 'Documents')];

  it('默认投递到下载目录', () => {
    const target = resolveDeliverPath('report.md', undefined, roots);
    assert.equal(target.path, join(homedir(), 'Downloads', 'report.md'));
  });

  it('可以指定白名单内的目录', () => {
    const target = resolveDeliverPath('a.md', join(homedir(), 'Desktop'), roots);
    assert.equal(target.path, join(homedir(), 'Desktop', 'a.md'));
  });

  it('拒绝白名单之外的目录', () => {
    assert.throws(
      () => resolveDeliverPath('a.md', '/etc', roots),
      (error: unknown) => error instanceof DeliverPathError,
    );
    assert.throws(() => resolveDeliverPath('a.md', join(homedir(), '.ssh'), roots), DeliverPathError);
  });

  it('文件名里的路径分隔符会被剥掉（不能借它逃逸）', () => {
    const target = resolveDeliverPath('../../etc/passwd', undefined, roots);
    assert.equal(target.path, join(homedir(), 'Downloads', 'passwd'));
  });

  it('拒绝空文件名', () => {
    assert.throws(() => resolveDeliverPath('   ', undefined, roots), DeliverPathError);
  });

  it('支持用环境变量改写白名单', () => {
    const custom = deliverRoots({ AGENT_DELIVER_DIRS: '/tmp/a,/tmp/b' });
    assert.equal(custom.length, 2);
    assert.ok(custom[0]?.endsWith('/tmp/a'));
  });

  it('默认白名单是下载 / 桌面 / 文档', () => {
    const names = deliverRoots({}).map((root) => root.split('/').pop());
    assert.deepEqual(names, ['Downloads', 'Desktop', 'Documents']);
  });
});
