import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import { Collapsible, useCountUp } from '../motion';
import { IconClose, IconPlus, IconTrash } from '../icons';
import type { MemoryEntryView, MemoryScope, MemorySnapshot, MemoryTier } from '../types';

interface MemoryPanelProps {
  agentId: string;
  agentName: string;
  refreshToken: number;
  onClose: () => void;
}

const TIER_META: Record<MemoryTier, { label: string; hint: string }> = {
  portrait: { label: '画像', hint: '每次都带着' },
  log: { label: '日志', hint: '按时间，旧的挤出眼前' },
  scratch: { label: '随手笔记', hint: '淡得最快' },
};

const SCOPES: MemoryScope[] = ['self', 'user', 'project'];

const SCOPE_HINT: Record<MemoryScope, string> = {
  self: '只有这个智能体能读',
  user: '所有智能体共用',
  project: '参与该项目的智能体可读',
};

export function MemoryPanel({ agentId, agentName, refreshToken, onClose }: MemoryPanelProps) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftScope, setDraftScope] = useState<MemoryScope>('self');
  const [draftTier, setDraftTier] = useState<MemoryTier>('log');

  const [tierFilter, setTierFilter] = useState<MemoryTier | 'all'>('all');
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSnapshot(await api.fetchMemory(agentId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload, refreshToken]);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    await api.writeMemory(agentId, { text, scope: draftScope, tier: draftTier }).catch(() => undefined);
    setDraft('');
    setAdding(false);
    await reload();
  };

  const remove = async (entry: MemoryEntryView) => {
    if (busyEntryId) return;
    setBusyEntryId(entry.id);
    try {
      await api.deleteMemory(agentId, entry.scope, entry.ownerId, entry.id);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyEntryId(null);
    }
  };

  const promote = async (entry: MemoryEntryView, tier: MemoryTier) => {
    if (busyEntryId) return;
    setBusyEntryId(entry.id);
    try {
      await api.promoteMemory(agentId, entry.scope, entry.ownerId, entry.id, tier);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyEntryId(null);
    }
  };

  const portraitCount = useCountUp(snapshot?.counts.portrait ?? 0);
  const logCount = useCountUp(snapshot?.counts.log ?? 0);
  const scratchCount = useCountUp(snapshot?.counts.scratch ?? 0);
  const totalCount = useCountUp(snapshot ? snapshot.counts.portrait + snapshot.counts.log + snapshot.counts.scratch : 0);

  return (
    <section className="memory-panel">
      <header className="screen-head">
        <span className="memory-title">记忆库</span>
        <span className="memory-sub">{agentName}</span>
        <button
          type="button"
          className="screen-btn"
          aria-label="新增记忆"
          title="新增一条记忆"
          onClick={() => setAdding((value) => !value)}
        >
          <IconPlus size={15} />
        </button>
      </header>

      <div className="memory-body">
        {snapshot ? (
          <div className="memory-counts">
            <button
              type="button"
              className={`tier-pill portrait${tierFilter === 'portrait' ? ' active' : ''}`}
              onClick={() => setTierFilter((prev) => (prev === 'portrait' ? 'all' : 'portrait'))}
              title="过滤画像记忆"
            >
              画像 {portraitCount}
            </button>
            <button
              type="button"
              className={`tier-pill log${tierFilter === 'log' ? ' active' : ''}`}
              onClick={() => setTierFilter((prev) => (prev === 'log' ? 'all' : 'log'))}
              title="过滤日志记忆"
            >
              日志 {logCount}
            </button>
            <button
              type="button"
              className={`tier-pill scratch${tierFilter === 'scratch' ? ' active' : ''}`}
              onClick={() => setTierFilter((prev) => (prev === 'scratch' ? 'all' : 'scratch'))}
              title="过滤随手记忆"
            >
              随手 {scratchCount}
            </button>
            <button
              type="button"
              className={`tier-pill all${tierFilter === 'all' ? ' active' : ''}`}
              onClick={() => setTierFilter('all')}
              title="显示全部"
            >
              共 {totalCount} 条
            </button>
          </div>
        ) : null}

        <Collapsible open={adding}>
          <div className="memory-add">
            <textarea
              rows={2}
              value={draft}
              placeholder="要它记住什么？"
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="memory-add-row">
              <select value={draftScope} onChange={(event) => setDraftScope(event.target.value as MemoryScope)}>
                {SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {scope === 'self' ? '它的笔记' : scope === 'user' ? '共用的你' : '项目笔记'}
                  </option>
                ))}
              </select>
              <select value={draftTier} onChange={(event) => setDraftTier(event.target.value as MemoryTier)}>
                {(Object.keys(TIER_META) as MemoryTier[]).map((tier) => (
                  <option key={tier} value={tier}>
                    {TIER_META[tier].label}
                  </option>
                ))}
              </select>
              <button type="button" className="btn primary small" onClick={() => void submit()}>
                记住
              </button>
            </div>
          </div>
        </Collapsible>

        {loading ? (
          <div className="memory-skeleton">
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line" />
          </div>
        ) : null}
        {error ? <p className="memory-empty error">{error}</p> : null}

        {snapshot && !loading
          ? snapshot.buckets.map((bucket) => {
              const entries =
                tierFilter === 'all'
                  ? bucket.entries
                  : bucket.entries.filter((entry) => entry.tier === tierFilter);
              return (
                <div className="memory-bucket" key={`${bucket.scope}:${bucket.ownerId}`}>
                  <div className="memory-bucket-head">
                    <span className={`scope-dot ${bucket.scope}`} />
                    <span className="memory-bucket-name">{bucket.label}</span>
                    <span className="memory-bucket-hint">{SCOPE_HINT[bucket.scope]}</span>
                    <span className="memory-count">{entries.length}</span>
                  </div>

                  {entries.length === 0 ? (
                    <p className="memory-empty">{bucket.entries.length === 0 ? '还没有记录' : '该分类下暂无记录'}</p>
                  ) : (
                    <ul className="memory-list">
                      {entries.map((entry) => {
                        const isBusy = busyEntryId === entry.id;
                        return (
                          <li className={`memory-item ${entry.inView ? '' : 'dim'}`} key={entry.id}>
                            <div className="memory-item-head">
                              <span className={`tier-tag ${entry.tier}`}>{TIER_META[entry.tier].label}</span>
                              <span className="memory-source">
                                {entry.source === 'user' ? '你写的' : entry.source === 'agent' ? '它记的' : '自动抽取'}
                              </span>
                              {!entry.inView ? <span className="memory-out">需搜索</span> : null}
                            </div>
                            <p className="memory-text">{entry.text}</p>
                            <div className="memory-actions">
                              {entry.tier === 'portrait' ? (
                                <button
                                  type="button"
                                  className="memory-act"
                                  disabled={isBusy}
                                  onClick={() => void promote(entry, 'log')}
                                >
                                  {isBusy ? '处理中…' : '降为日志'}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="memory-act"
                                  title="提到画像层，以后每次都带着"
                                  disabled={isBusy}
                                  onClick={() => void promote(entry, 'portrait')}
                                >
                                  {isBusy ? '处理中…' : '置为画像'}
                                </button>
                              )}
                              <button
                                type="button"
                                className="memory-act danger"
                                aria-label="遗忘"
                                disabled={isBusy}
                                onClick={() => void remove(entry)}
                              >
                                <IconTrash size={13} />
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })
          : null}
      </div>
    </section>
  );
}
