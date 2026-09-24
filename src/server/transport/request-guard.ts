import type { IncomingHttpHeaders } from 'node:http';

/**
 * 本机 API 请求守卫（bug_yc9t7bf99uf1）。
 *
 * 服务只监听 127.0.0.1，但光绑定回环挡不住两件事：
 * 1. 外站网页用 text/plain 这类「简单请求」绕过 CORS 预检直接打过来——浏览器对跨站写请求一定会带 Origin；
 * 2. DNS 重绑定把外站域名解析到 127.0.0.1，配上伪造 Host 就能同源读数据。
 *
 * 因此这里做三层：Host 必须是回环地址；带 Origin 的写操作来源必须是本应用；
 * 浏览器发来的写操作必须真的是 JSON。没有 Origin 的调用视为本机进程（CLI、curl、测试）放行。
 */

export type RequestRejectionCode = 'FORBIDDEN_HOST' | 'FORBIDDEN_ORIGIN' | 'FORBIDDEN_CONTENT_TYPE';

export interface RequestRejection {
  status: 403;
  error: string;
  code: RequestRejectionCode;
}

/** 只取守卫要判定的字段，便于用普通对象做单元测试 */
export interface GuardedRequest {
  method?: string;
  headers: IncomingHttpHeaders;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 从 Host / authority 里取主机名：IPv4、域名、[::1]、裸 IPv6 都要能分开端口 */
export function hostnameOf(authority: string): string {
  const value = authority.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value;
  }
  const first = value.indexOf(':');
  // 只有一个冒号才是「主机:端口」；多个冒号说明是没加方括号的裸 IPv6
  if (first >= 0 && value.indexOf(':', first + 1) < 0) return value.slice(0, first);
  return value;
}

/** 回环：IPv4 127/8、localhost 及其子域、IPv6 ::1 */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '::1') return true;
  return /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * 来源是否为本应用：同源（127.0.0.1/localhost 任意端口）、Vite 开发端口、
 * 桌面端经 http(s) 加载时同样落在回环上；file:// 是 Electron 直接加载本地页面时的来源。
 * 沙箱 iframe 与重定向场景会发 Origin: null，必须挡住。
 */
export function isAllowedOrigin(origin: string): boolean {
  if (origin === 'file://') return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // URL 对 IPv6 返回带方括号的 [::1]，统一交给 hostnameOf 去掉
  return isLoopbackHost(hostnameOf(url.hostname));
}

function hasBody(headers: IncomingHttpHeaders): boolean {
  const length = headers['content-length'];
  if (typeof length === 'string') return Number(length) > 0;
  return headers['transfer-encoding'] !== undefined;
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return false;
  // 允许 application/json; charset=utf-8 这类参数
  return raw.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/** 返回 null 放行，否则按 403 回绝 */
export function checkRequest(request: GuardedRequest): RequestRejection | null {
  const method = (request.method ?? 'GET').toUpperCase();
  const { headers } = request;

  const host = headers.host;
  const hostname = typeof host === 'string' ? hostnameOf(host) : '';
  if (!isLoopbackHost(hostname)) {
    return { status: 403, error: 'Host 不被允许：本服务只接受本机请求', code: 'FORBIDDEN_HOST' };
  }

  if (!UNSAFE_METHODS.has(method)) return null;

  const origin = headers.origin;
  // 没有 Origin 的不是浏览器（CLI、curl、桌面主进程、测试），无从伪造跨站
  if (typeof origin === 'string' && origin.length > 0 && !isAllowedOrigin(origin)) {
    return { status: 403, error: '来源不被允许：写操作只能来自本应用界面', code: 'FORBIDDEN_ORIGIN' };
  }

  // 浏览器发来的请求必须是 JSON：挡住 text/plain、表单这类不触发 CORS 预检的简单请求
  if (origin !== undefined && hasBody(headers) && !isJsonContentType(headers['content-type'])) {
    return {
      status: 403,
      error: 'Content-Type 不被允许：接口只接受 application/json',
      code: 'FORBIDDEN_CONTENT_TYPE',
    };
  }

  return null;
}
