/** 图片引用有独立边界；不把 base64 大正文塞进工具参数、收件箱和历史。 */
export interface InputImage { url: string; alt?: string }
export const MAX_INPUT_IMAGES = 4;
export const IMAGE_CONTEXT_RESERVE = 4096; // 预算预留，不是供应商计费用量。

export function validateInputImages(value: unknown): InputImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_INPUT_IMAGES) throw new Error('images 最多 4 张');
  return value.map(image => {
    if (!image || typeof image.url !== 'string' || image.url.length > 2048) throw new Error('图片 URL 必须是最多 2048 字符的 HTTP(S) 地址');
    let url: URL;
    try { url = new URL(image.url); } catch { throw new Error('图片 URL 无效'); }
    if (url.href.length > 2048) throw new Error('图片 URL 编码后不能超过 2048 字符');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('图片只支持不含账号密码的 HTTP(S) URL；不支持本地路径或 base64');
    if (image.alt !== undefined && (typeof image.alt !== 'string' || image.alt.length > 300)) throw new Error('图片 alt 最多 300 字符');
    return { url: url.href, ...(image.alt ? { alt: image.alt } : {}) };
  });
}
