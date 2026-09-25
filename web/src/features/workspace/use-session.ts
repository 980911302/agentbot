import { useCallback, useEffect, useState } from 'react';
import * as api from '../../api';
import { toast } from '../../components/ui/Toast.js';
import { ensureNotifyPermission } from '../../notify';
import type { ChannelItem } from '../../components/Sidebar';
import type { HealthInfo, ModelOption } from '../../types';

/**
 * 会话与后端设置（OPT-04 从 App.tsx 抽出）：health / 在线 / 模型 / 主人名，
 * 以及三条时间线——首屏引导、工作台 15s 安全网同步、health 20s 与窗口聚焦刷新。
 *
 * 主人名的权威源是后端设置（E5.7）；localStorage 只用于首屏先渲染，避免名字闪一下。
 */
export function useWorkspaceSession(input: {
  syncWorkspace: () => Promise<ChannelItem[]>;
  setActiveChannelId: React.Dispatch<React.SetStateAction<string>>;
}) {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [online, setOnline] = useState(true);
  const [model, setModel] = useState('');
  /**
   * 用户显示名（E5.7）：以后端设置存储为准——同一份名字要给界面、群消息和 CLI 用。
   * localStorage 只留纯界面偏好（面板/侧栏宽度、主题），不再是这个名字的事实源。
   */
  const [ownerName, setOwnerNameState] = useState(
    () => localStorage.getItem('agentbot.ownerName') ?? 'linlin zhang',
  );

  const { syncWorkspace, setActiveChannelId } = input;

  /** 群 + 智能体 → 侧边栏条目；首屏就位 + 尽早拿通知授权 */
  useEffect(() => {
    let cancelled = false;
    void ensureNotifyPermission();
    void (async () => {
      try {
        const info = await api.fetchHealth();
        if (cancelled) return;
        setHealth(info);
        setOnline(Boolean(info));
        if (info) {
          setModel((curr) => curr || info.model);
          // 后端的主人名是事实源：拿到就用它，并顺手更新首屏缓存
          if (info.ownerName) {
            setOwnerNameState(info.ownerName);
            localStorage.setItem('agentbot.ownerName', info.ownerName);
          }
        }

        const channelList = await syncWorkspace();
        if (cancelled) return;

        setActiveChannelId((current) =>
          channelList.some((item) => item.id === current) ? current : (channelList[0]?.id ?? ''),
        );
      } catch {
        if (!cancelled) setOnline(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [syncWorkspace, setActiveChannelId]);

  // 安全网：后台可能被别的入口改动（另一个窗口、脚本），定期同步一次
  useEffect(() => {
    const timer = window.setInterval(() => void syncWorkspace(), 15000);
    return () => window.clearInterval(timer);
  }, [syncWorkspace]);

  const refreshHealth = useCallback(async () => {
    try {
      const info = await api.fetchHealth();
      setHealth(info);
      setOnline(Boolean(info));
      if (info?.model) setModel(info.model);
    } catch {
      setOnline(false);
    }
  }, []);

  /**
   * health 只在启动时拉过一次：模型与工具清单之后再不刷新，
   * 设置里改完（或在别处改完）输入框还显示旧模型。这里补上定时刷新和
   * 窗口重新聚焦时的刷新——切回窗口就该看到最新状态。
   */
  useEffect(() => {
    const timer = window.setInterval(() => void refreshHealth(), 20000);
    const onFocus = () => void refreshHealth();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshHealth();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshHealth]);

  const models = health?.models ?? [];
  const tools = health?.tools ?? [];

  const handleModelChange = useCallback(
    async (next: string, picked?: ModelOption) => {
      setModel(next);
      // 优先用下拉直接传来的整项：同一上游模型可能挂在多个供应商下，
      // 只按 id 反查会命中第一个，激活到用户没点的那个供应商
      const option = picked ?? models.find((item) => item.id === next);
      if (option?.providerId && option?.modelConfigId) {
        try {
          await api.setActiveProviderModel(option.providerId, option.modelConfigId);
          await refreshHealth();
        } catch {
          // 本地已切换；持久化失败时下次启动会回到服务端当前模型
        }
      }
    },
    [models, refreshHealth],
  );

  const setOwnerName = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      // 先落本地缓存供下次首屏用，再写后端；后端拒绝时回滚并把原因说出来
      const previous = ownerName;
      setOwnerNameState(trimmed);
      localStorage.setItem('agentbot.ownerName', trimmed);
      void api
        .savePreferences({ ownerName: trimmed })
        .then((saved) => {
          setOwnerNameState(saved.ownerName);
          localStorage.setItem('agentbot.ownerName', saved.ownerName);
        })
        .catch((error: unknown) => {
          setOwnerNameState(previous);
          localStorage.setItem('agentbot.ownerName', previous);
          toast(
            `主人名没保存成功：${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        });
    },
    [ownerName],
  );

  const endpoint =
    typeof window === 'undefined' ? '127.0.0.1:8787' : window.location.host || '127.0.0.1:8787';

  return {
    health,
    online,
    model,
    ownerName,
    setOwnerName,
    refreshHealth,
    handleModelChange,
    models,
    tools,
    endpoint,
  };
}