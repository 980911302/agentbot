import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import { Collapsible } from '../motion';
import { formatClock } from '../format';
import { IconArrows } from '../icons';
import { Chip } from './ui/Chip.js';
import { Skeleton } from './ui/Skeleton.js';
import {
  STEP_STATUS_LABEL,
  WORK_FILTERS,
  WORK_STATUS_LABEL,
  countWorks,
  deliverableRefLabel,
  deliverableRefs,
  filterWorks,
  nextActionOf,
  objectiveOf,
  progressTextOf,
  sortWorksForPanel,
  stepProgressOf,
  waitingTargetOf,
  workSummaryLine,
  type WorkFilter,
} from '../features/work/work-view';
import type { WorkItem, WorkStep } from '../../../src/work/item.js';

interface WorkPanelProps {
  agentId: string;
  agentName: string;
}

const FILTER_LABEL: Record<WorkFilter, string> = {
  all: '全部',
  active: '进行中',
  waiting: '等待中',
  finished: '已结束',
};

/**
 * 「工作」抽屉（E4.7）= 这位同事手头的工作。
 *
 * 只显示接口回来的真实状态与进展（状态即事实）：没有进度不编，没有交付物就说没有。
 * 列表来自 GET /api/agents/:id/work；步骤按需展开时才去 GET .../work/:workId，
 * 展开前那件工作的步骤根本不在 DOM 里。
 */
export function WorkPanel({ agentId, agentName }: WorkPanelProps) {
  const [works, setWorks] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<WorkFilter>('all');
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [steps, setSteps] = useState<Record<string, WorkStep[]>>({});
  const [stepsLoadingId, setStepsLoadingId] = useState<string | null>(null);
  const [stepsError, setStepsError] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const items = await api.fetchAgentWorks(agentId);
      // 列表重新取回：已展开工作的步骤缓存作废，避免显示上一版步骤
      setWorks(sortWorksForPanel(items));
      setSteps({});
      setStepsError({});
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    setOpenIds([]);
    setFilter('all');
    void reload();
  }, [reload]);

  /** 展开才拉步骤：不展开就不发请求，也不占 DOM */
  const loadSteps = async (workId: string) => {
    setStepsLoadingId(workId);
    try {
      const detail = await api.fetchWorkDetail(agentId, workId);
      setSteps((current) => ({ ...current, [workId]: detail.steps }));
      setStepsError((current) => {
        const next = { ...current };
        delete next[workId];
        return next;
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      setStepsError((current) => ({ ...current, [workId]: reason }));
    } finally {
      setStepsLoadingId((current) => (current === workId ? null : current));
    }
  };

  const toggleSteps = (workId: string) => {
    const isOpen = openIds.includes(workId);
    setOpenIds(isOpen ? openIds.filter((id) => id !== workId) : [...openIds, workId]);
    if (!isOpen && steps[workId] === undefined && stepsLoadingId !== workId) void loadSteps(workId);
  };

  const visible = filterWorks(works, filter);
  const counts = countWorks(works);

  return (
    <section className="work-panel">
      <header className="screen-head">
        <span className="work-head-title">手头工作</span>
        <span className="work-head-sub" title={agentName}>
          {agentName}
        </span>
        <button
          type="button"
          className="screen-btn"
          aria-label="刷新工作列表"
          title="重新读取该同事的工作"
          onClick={() => void reload()}
        >
          <IconArrows size={15} />
        </button>
      </header>

      <div className="work-body">
        <div className="work-filters" role="group" aria-label="按状态筛选工作">
          {WORK_FILTERS.map((item) => (
            <Chip key={item} selected={filter === item} onClick={() => setFilter(item)}>
              {FILTER_LABEL[item]} {counts[item]}
            </Chip>
          ))}
        </div>
        <p className="work-summary">{workSummaryLine(works)}</p>

        {loading ? (
          <div className="work-skeletons" aria-hidden="true">
            <Skeleton height={86} radius="var(--r-md)" />
            <Skeleton height={86} radius="var(--r-md)" />
          </div>
        ) : null}

        {error ? (
          <div className="work-error" role="alert">
            <p>读不到这位同事的工作：{error}</p>
            <button type="button" className="work-act" onClick={() => void reload()}>
              重试
            </button>
          </div>
        ) : null}

        {!loading && !error && works.length === 0 ? (
          <p className="work-empty">手头没有工作。对话里托付一件事，这里就会出现它。</p>
        ) : null}

        {!loading && works.length > 0 && visible.length === 0 ? (
          <p className="work-empty">这个状态下没有工作。</p>
        ) : null}

        {!loading
          ? visible.map((work) => {
              const isOpen = openIds.includes(work.id);
              const waitingTarget = waitingTargetOf(work);
              const nextAction = nextActionOf(work);
              const objective = objectiveOf(work);
              const refs = deliverableRefs(work);
              const loadedSteps = steps[work.id];
              const progress = stepProgressOf(loadedSteps ?? []);
              return (
                <article className="work-card" key={work.id} data-work-id={work.id} data-status={work.status}>
                  <div className="work-card-head">
                    <span className={`work-status ${work.status}`}>{WORK_STATUS_LABEL[work.status]}</span>
                    <span className="work-card-title">{work.title}</span>
                    <span className="work-card-time">{formatClock(work.updatedAt)}</span>
                  </div>

                  <dl className="work-fields">
                    {/* 目标：标题就是原话第一句，短消息里两栏一模一样，只有目标多说了什么才单列 */}
                    {objective ? (
                      <div className="work-field">
                        <dt>目标</dt>
                        <dd>{objective}</dd>
                      </div>
                    ) : null}
                    <div className="work-field">
                      <dt>进展</dt>
                      <dd>{progressTextOf(work)}</dd>
                    </div>
                    {waitingTarget ? (
                      <div className="work-field waiting">
                        <dt>在等</dt>
                        <dd>{waitingTarget}</dd>
                      </div>
                    ) : null}
                    {nextAction ? (
                      <div className="work-field">
                        <dt>下一步</dt>
                        <dd>{nextAction}</dd>
                      </div>
                    ) : null}
                    <div className="work-field">
                      <dt>交付物</dt>
                      <dd>
                        {refs.length === 0 ? (
                          <span className="work-none">还没有交付物</span>
                        ) : (
                          <span className="work-artifacts">
                            {refs.map((ref) => (
                              <span className="work-artifact" key={ref} title={ref}>
                                {deliverableRefLabel(ref)}
                              </span>
                            ))}
                          </span>
                        )}
                      </dd>
                    </div>
                  </dl>

                  <button
                    type="button"
                    className="work-act"
                    aria-expanded={isOpen}
                    onClick={() => toggleSteps(work.id)}
                  >
                    {isOpen
                      ? '收起步骤'
                      : progress.total > 0
                        ? `步骤 ${progress.completed}/${progress.total}`
                        : '步骤'}
                  </button>

                  <Collapsible open={isOpen}>
                    {/* 展开过才渲染：没展开的卡片里连步骤/验收的 DOM 都不存在（按需展开）。
                        收起后仍保留（loadedSteps 还在），折叠动画才有内容可播。 */}
                    {isOpen || loadedSteps !== undefined ? (
                      <div className="work-steps">
                      {stepsLoadingId === work.id ? (
                        <Skeleton height={14} />
                      ) : stepsError[work.id] ? (
                        <p className="work-error-line">步骤没读出来：{stepsError[work.id]}</p>
                      ) : loadedSteps === undefined ? null : loadedSteps.length === 0 ? (
                        <p className="work-none">这件工作还没有步骤记录。</p>
                      ) : (
                        <ol className="work-step-list">
                          {loadedSteps.map((step) => (
                            <li className="work-step" key={step.id} data-step-status={step.status}>
                              <span className={`work-step-dot ${step.status}`} aria-hidden="true" />
                              <span className="work-step-title">{step.title}</span>
                              <span className={`work-step-status ${step.status}`}>
                                {STEP_STATUS_LABEL[step.status]}
                              </span>
                              {step.note ? <span className="work-step-note">{step.note}</span> : null}
                            </li>
                          ))}
                        </ol>
                      )}

                      {work.acceptance.length > 0 ? (
                        <div className="work-acceptance">
                          <span className="work-acceptance-label">验收</span>
                          <ul className="work-acceptance-list">
                            {work.acceptance.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      </div>
                    ) : null}
                  </Collapsible>
                </article>
              );
            })
          : null}
      </div>
    </section>
  );
}