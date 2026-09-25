import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui';
import { clearBotAvatar, uploadBotAvatar } from '../api';
import { agentAvatarUrl } from '../features/agents/avatar-view';
import type { BotSummary } from '../types';

/** 与服务端一致的口径：只收这四种图片，5MB 上限（超过由服务端再拒一次） */
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const MAX_BYTES = 5 * 1024 * 1024;

interface AgentAvatarPickerProps {
  /** 有头像时用一个能识别的按钮名，方便键盘与冒烟测试定位 */
  bot: Pick<BotSummary, 'id' | 'avatar' | 'avatarUrl'>;
  /** 没有自定义图片时展示的东西（生成的脸由调用方决定形状/颜色） */
  fallback: ReactNode;
  /** 上传/清空成功后回调新的引用值，调用方据此同步本地状态 */
  onChanged?: (avatar: string) => void;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败，换一张试试'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

/**
 * 头像选择器（E5.1）：上传 / 清除都走资源接口，落盘在数据目录的头像目录。
 *
 * 本地保留一份刚上传的结果：侧边栏数据要等下一次快照刷新，抽屉里先显示新图，
 * 不能出现「传完了却还显示旧脸」。
 */
export function AgentAvatarPicker({ bot, fallback, onChanged }: AgentAvatarPickerProps) {
  const [local, setLocal] = useState<{ avatar: string; url: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 换了一位同事：本地覆盖值作废，回到服务端快照
  useEffect(() => {
    setLocal(null);
    setError(null);
  }, [bot.id]);

  const avatar = local ? local.avatar : (bot.avatar ?? '');
  const url = local ? local.url : agentAvatarUrl(bot);

  const pick = async (file: File | undefined) => {
    if (!file || busy) return;
    if (!ACCEPT.split(',').includes(file.type)) {
      setError('头像只支持 PNG / JPEG / WebP / GIF');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('头像必须小于 5MB');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await readAsDataUrl(file);
      const saved = await uploadBotAvatar(bot.id, dataUrl);
      setLocal({ avatar: saved.avatar, url: saved.avatarUrl });
      onChanged?.(saved.avatar);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const clear = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await clearBotAvatar(bot.id);
      setLocal({ avatar: saved.avatar, url: saved.avatarUrl });
      onChanged?.(saved.avatar);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-avatar-picker">
      <div className="agent-avatar-picker-preview">
        {url ? (
          <img className="agent-avatar-picker-image" src={url} alt="当前头像" />
        ) : (
          fallback
        )}
      </div>

      <div className="agent-avatar-picker-actions">
        <Button size="sm" variant="secondary" loading={busy} onClick={() => inputRef.current?.click()}>
          上传图片
        </Button>
        {avatar ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void clear()}>
            清除头像
          </Button>
        ) : null}
      </div>

      <input
        ref={inputRef}
        className="agent-avatar-picker-input"
        type="file"
        accept={ACCEPT}
        aria-label="选择头像图片"
        onChange={(event) => void pick(event.target.files?.[0])}
      />

      <p className="agent-avatar-picker-hint">
        {avatar ? '自定义图片会盖住生成的脸；清除后回到默认。' : 'PNG / JPEG / WebP / GIF，小于 5MB。'}
      </p>
      {error ? <p className="agent-avatar-picker-error">{error}</p> : null}
    </div>
  );
}