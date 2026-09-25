import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchAgentTools, fetchBots, fetchHealth, saveAgentTools } from '../../api';
import type { BotSummary } from '../../types';
import { Button, Chip, Skeleton, toast } from '../ui';
import {
  clearOptional,
  isDirty,
  selectionSummary,
  splitTools,
  toggleTool,
  type ToolCatalogEntry,
} from './tool-selection.js';

/**
 * 按同事装卸工具（E5.3）：左边选同事，右边勾选可选工具。
 *
 * 数据都来自后端：工具目录取 /api/health（`required` 由后端标必需能力），
 * 同事取 /api/bots，勾选状态取 /api/agents/:id；保存走 PATCH 并用**返回的清单**
 * 回填界面——不做假成功、不猜状态。必需能力不参与勾选（后端恒定叠加，卸不掉）。
 */
export function AgentToolsSection() {
  const [agents, setAgents] = useState<BotSummary[]>();
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>();
  const [agentId, setAgentId] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [persisted, setPersisted] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    void Promise.all([fetchBots(), fetchHealth()])
      .then(([bots, health]) => {
        if (!alive) return;
        const visible = bots.filter((bot) => bot.hidden !== true);
        setAgents(visible);
        setCatalog(health.tools ?? []);
        setAgentId((current) => current ?? visible[0]?.id);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  const loadTools = useCallback(async (id: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const names = await fetchAgentTools(id);
      setSelected(names);
      setPersisted(names);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (agentId) void loadTools(agentId);
  }, [agentId, loadTools]);

  const groups = useMemo(() => splitTools(catalog ?? []), [catalog]);
  const dirty = isDirty(selected, persisted);

  const save = async () => {
    if (!agentId) return;
    setSaving(true);
    setError(undefined);
    try {
      const confirmed = await saveAgentTools(agentId, selected);
      setSelected(confirmed);
      setPersisted(confirmed);
      toast('工具装卸已保存，下个回合起生效', 'ok');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (error && !agents) {
    return (
      <div className="provider-detail-scroll">
        <div className="provider-header-row">
          <div className="provider-header-left">
            <h2 className="provider-title-text">工具装卸</h2>
          </div>
        </div>
        <p className="settings-row-desc">读取同事与工具清单失败：{error}</p>
      </div>
    );
  }

  if (!agents || !catalog) {
    return (
      <div className="provider-detail-scroll" data-testid="agent-tools-loading">
        <Skeleton height={28} />
        <Skeleton height={160} />
      </div>
    );
  }

  return (
    <div className="provider-detail-scroll" data-testid="agent-tools-section">
      <div className="provider-header-row">
        <div className="provider-header-left">
          <h2 className="provider-title-text">工具装卸</h2>
        </div>
      </div>
      <p className="settings-row-desc agent-tools-hint">
        按同事勾选可选工具。必需能力恒定可用、不可卸载；卸载的可选工具重启后不会被补回。
      </p>

      <div className="settings-section">
        <div className="settings-section-title">选择同事</div>
        <div className="settings-card">
          <div className="agent-tools-picker">
            {agents.length === 0 ? (
              <span className="settings-row-desc">还没有同事，先去侧栏新建一个</span>
            ) : (
              agents.map((agent) => (
                <Chip key={agent.id} selected={agent.id === agentId} onClick={() => setAgentId(agent.id)}>
                  {agent.name}
                </Chip>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">必需能力（不可卸载）</div>
        <div className="settings-card">
          {groups.required.map((tool) => (
            <label key={tool.name} className="agent-tool-row locked">
              <input type="checkbox" checked disabled readOnly aria-label={tool.name} />
              <span className="agent-tool-name">{tool.name}</span>
              <span className="agent-tool-desc">{tool.description}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">可选工具</div>
        <div className="settings-card" data-testid="optional-tools">
          {groups.optional.map((tool) => (
            <label key={tool.name} className="agent-tool-row">
              <input
                type="checkbox"
                aria-label={tool.name}
                checked={selected.includes(tool.name)}
                disabled={loading || !agentId}
                onChange={() => setSelected((current) => toggleTool(current, tool.name, catalog))}
              />
              <span className="agent-tool-name">{tool.name}</span>
              <span className="agent-tool-desc">{tool.description}</span>
            </label>
          ))}
        </div>
      </div>

      {error ? <p className="settings-row-desc agent-tools-error">保存没成功：{error}</p> : null}

      <div className="agent-tools-savebar" data-testid="agent-tools-savebar">
        <span className="settings-row-desc" data-testid="agent-tools-summary">
          {loading ? '正在读取…' : selectionSummary(groups, selected)}
        </span>
        <div className="agent-tools-savebar-actions">
          <Button
            variant="ghost"
            aria-label="全部卸载可选工具"
            disabled={loading || saving || !agentId}
            onClick={() => setSelected(clearOptional())}
          >
            全部卸载
          </Button>
          <Button variant="primary" loading={saving} disabled={loading || !agentId || !dirty} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}