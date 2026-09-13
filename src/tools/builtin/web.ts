import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { defineTool } from '../tool.js';
import type { SecretStore } from '../../secret/store.js';

/**
 * 联网工具。
 *
 * 参见 docs/工具参考.md：搜网页 / 拉页面，公网只读。
 * 有连接器时优先走连接器，不要用搜索去绕过——这一条写在工具描述里。
 *
 * 安全边界：
 *   - 只允许 http/https
 *   - 解析域名后拒绝内网 / 环回 / 链路本地地址（SSRF 防护）
 *   - 限制响应体积与超时
 */

const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 12000;

export class UnsafeUrlError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnsafeUrlError';
  }
}

/** 内网 / 保留地址判断（IPv4 + IPv6） */
export function isPrivateAddress(ip: string): boolean {
  let value = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');

  if (value.includes(':')) {
    try { value = new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return true; }
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1]!, 16), lo = parseInt(hexMapped[2]!, 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (!/^[23][0-9a-f]{3}:/.test(value) || /^(2001:(db8|0):|2001::|2002:)/.test(value)) return true;
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fe80')) return true; // 链路本地
    if (/^f[cd][0-9a-f]{2}:/.test(value)) return true; // 唯一本地 fc00::/7
    // IPv4 映射地址 ::ffff:10.0.0.1
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }

  const parts = value.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
  const [a = 0, b = 0] = parts;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT
  if (a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))) return true;
  return false;
}

/** 校验 URL 安全性；返回规范化后的 URL */
export async function assertPublicUrl(raw: string, signal?: AbortSignal): Promise<URL> {
  signal?.throwIfAborted();
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError(`不是合法的 URL：${raw}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`只支持 http / https，收到的是 ${url.protocol}`);
  }
  if (url.href.length > 4096) throw new UnsafeUrlError('规范化 URL 超过 4096 字符');

  if (url.username || url.password) throw new UnsafeUrlError('URL 不允许夹带用户名/密码，请使用密钥引用');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new UnsafeUrlError('不允许访问本机地址');
  }

  // 域名直接给出 IP 的情况
  if (isPrivateAddress(host)) {
    throw new UnsafeUrlError(`不允许访问内网地址：${host}`);
  }

  // 解析域名，拒绝指向内网的
  try {
    const resolved = await cancellable(lookup(host, { all: true }), signal);
    const blocked = resolved.find((item) => isPrivateAddress(item.address));
    if (blocked) {
      throw new UnsafeUrlError(`${host} 解析到内网地址 ${blocked.address}，已拒绝`);
    }
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw error;
    throw new UnsafeUrlError(`无法解析域名 ${host}`);
  }

  return url;
}

async function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

/** HTML → 纯文本；不引入依赖，够用即可 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;

  try { for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value?.length ?? 0;
    if (bytes > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('网页响应超过 2MiB，请请求更小的页面/接口范围');
    }
    text += decoder.decode(value, { stream: true });
  }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

/** 每一次实际连接都在 lookup 回调中校验地址并把已校验地址交给 socket，防 DNS 重绑定。 */
export async function fetchPublic(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  let current = url;
  const sendHeaders = { ...headers, 'accept-encoding': 'identity' };
  for (let redirect = 0; redirect <= 3; redirect++) {
    signal.throwIfAborted();
    await assertPublicUrl(current.href, signal);
    signal.throwIfAborted();
    const response = await new Promise<Response>((resolve, reject) => {
      const request = (current.protocol === 'https:' ? httpsRequest : httpRequest)(current, {
        headers: sendHeaders, signal,
        lookup(host, options, callback) {
          lookup(host, { all: true }).then(addresses => {
            if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new UnsafeUrlError('实际连接解析到了内网/保留地址，已拒绝');
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          }).catch(error => callback(error, []));
        },
      }, incoming => {
        const chunks: Buffer[] = []; let bytes = 0;
        incoming.on('error', reject);
        const status = incoming.statusCode ?? 502;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        if ([301, 302, 303, 307, 308].includes(status)) {
          resolve(new Response(null, { status, headers: responseHeaders })); incoming.destroy(); return;
        }
        if (Number(incoming.headers['content-length']) > MAX_BYTES) { reject(new Error('网页响应超过 2MiB')); incoming.destroy(); return; }
        incoming.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) { reject(new Error('网页响应超过 2MiB')); incoming.destroy(); return; }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          if (responseHeaders.get('content-encoding') && responseHeaders.get('content-encoding') !== 'identity') { reject(new Error('服务器忽略 identity 要求，返回了压缩内容；请换文本接口')); return; }
          try { resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders })); } catch (error) { reject(error); }
        });
      });
      request.on('error', reject); request.end();
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirect === 3) throw new Error('重定向超过 3 次');
    const location = response.headers.get('location');
    if (!location) throw new Error('重定向缺少 location');
    const next = new URL(location, current);
    if (next.origin !== current.origin) delete (sendHeaders as Record<string, string>).authorization;
    current = next;
  }
  throw new Error('重定向失败');
}

export function createWebTools(secrets: SecretStore) {
  const webFetch = defineTool<{ url: string; secretName?: string; maxChars?: number; offset?: number }>({
    name: 'WebFetch',
    description: [
      '抓取一个公开网页并转成纯文本。只支持公网 http/https，不能访问内网与需要登录的页面。',
      '需要带鉴权时，让用户先用 request_secret 存好，再用 secretName 引用（不要索要明文）。',
      '如果已经有对应连接器（GitHub / Slack 等），优先走连接器，不要用它绕过。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 URL' },
        secretName: { type: 'string', description: '可选的密钥名，会作为 Bearer token 发送' },
        maxChars: { type: 'integer', minimum: 500, maximum: 12000, description: '默认 12000 字符' },
        offset: { type: 'integer', minimum: 0, maximum: MAX_BYTES, description: '纯文本字符偏移，从 0 起；每页会重新抓取' },
      },
      required: ['url'],
    },
    async execute(args, context) {
      const url = new URL(args.url);
      const headers: Record<string, string> = {
        'user-agent': 'AgentBot/0.1 (+local agent)',
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
      };

      if (args.secretName) {
        const token = await secrets.read(args.secretName);
        if (!token) throw new Error(`没有名为「${args.secretName}」的密钥；先用 request_secret 让用户提供`);
        headers.authorization = `Bearer ${token}`;
      }

      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;

      const response = await fetchPublic(url, headers, signal);
      if (!response.ok) {
        throw new Error(`抓取失败：HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType && !/^(text\/|application\/(json|[^;]+\+json|xml|xhtml\+xml|javascript))/i.test(contentType)) {
        throw new Error(`不支持二进制内容（${contentType}），只抓文本页面`);
      }

      const raw = await readLimited(response);
      if (raw.includes('\0')) throw new Error('响应含二进制内容，不能作为文本页面读取');
      const isHtml = contentType.includes('html') || /^\s*</.test(raw);
      const text = isHtml ? htmlToText(raw) : raw.trim();

      const limit = Math.min(Math.max(args.maxChars ?? MAX_TEXT_CHARS, 500), MAX_TEXT_CHARS, 14000 - url.href.length - 512);
      const offset = args.offset ?? 0;
      const clipped = text.slice(offset, offset + limit) + (text.length > offset + limit ? `\n[本页已满；next_offset=${offset + limit}]` : '\n[已到正文末尾]');

      return [`URL: ${url.href}`, `类型: ${contentType.slice(0, 120) || 'unknown'}`, '', clipped].join('\n');
    },
  });

  const webSearch = defineTool<{ search_term: string; explanation?: string }>({
    name: 'WebSearch',
    description: [
      '用关键词搜公网，返回标题 + 链接 + 摘要。',
      '搜到结果后如果需要正文，再用 web_fetch 抓具体那一条。',
      '不要用它去访问需要登录的内容；有连接器时优先用连接器。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        search_term: { type: 'string', description: '搜索词；话题性搜索要带当前年份' },
        explanation: { type: 'string', description: '一句话说明为什么要搜' },
      },
      required: ['search_term'],
    },
    async execute(args, context) {
      const query = args.search_term?.trim();
      if (!query) throw new Error('搜索词不能为空');
      const limit = 5;

      const endpoint = new URL('https://html.duckduckgo.com/html/');
      endpoint.searchParams.set('q', query);

      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;

      const response = await fetchPublic(endpoint, {
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          accept: 'text/html',
        }, signal);
      if (!response.ok) throw new Error(`搜索失败：HTTP ${response.status}`);

      const html = await readLimited(response);
      const results = parseDuckDuckGo(html, limit);
      if (results.length === 0) {
        return `没有搜到「${query}」的结果（可能被限流或需要换关键词）。可以改用 web_fetch 直接抓已知网址。`;
      }

      return results
        .map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet}`)
        .join('\n\n');
    },
  });

  return [webSearch, webFetch];
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets: string[] = [];
  for (const match of html.matchAll(snippetPattern)) {
    if (snippets.length >= 50) break;
    snippets.push(htmlToText(match[1] ?? '').slice(0, 600));
  }

  let index = 0;
  for (const match of html.matchAll(linkPattern)) {
    if (results.length >= limit) break;
    const rawHref = decodeHtmlEntities(match[1] ?? '');
    const url = unwrapDuckDuckGoUrl(rawHref);
    const title = htmlToText(match[2] ?? '');
    const snippet = snippets[index++] ?? '';
    if (!url || !title || url.length > 2000 || !/^https?:\/\//.test(url) || isAdLink(url)) continue;
    results.push({ title: title.slice(0, 200), url, snippet });
  }

  return results;
}

/** DDG 的结果链接常包一层 /l/?uddg=…，这里解回真实地址 */
export function unwrapDuckDuckGoUrl(href: string): string | undefined {
  if (!href) return undefined;
  const normalized = href.startsWith('//') ? `https:${href}` : href;

  if (normalized.startsWith('/l/') || normalized.includes('duckduckgo.com/l/')) {
    try {
      const url = new URL(normalized, 'https://duckduckgo.com');
      const target = url.searchParams.get('uddg');
      return target ? decodeURIComponent(target) : undefined;
    } catch {
      return undefined;
    }
  }

  return /^https?:\/\//.test(normalized) ? normalized : undefined;
}

/** DDG 的广告位是 /y.js 跳转，不该混进搜索结果 */
export function isAdLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!/(^|\.)duckduckgo\.com$/.test(host)) return false;
    return /\.js$/.test(parsed.pathname) || parsed.searchParams.has('ad_domain');
  } catch {
    return false;
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");
}
