import { IconPlug } from '../../icons';
import type { TestState } from './model-settings-shared.js';

/**
 * 单个模型的连接测试（UI-08）：测速结果就地显示，测试中禁止重复点击（规范 §5.1），
 * 结果汇总另有 Toast（在 use-model-settings 里发）。
 */
export function TestConnection({ modelName, state, onTest }: {
  modelName: string;
  state?: TestState;
  onTest: () => void;
}) {
  return (
    <>
      {state?.testing ? (
        <span className="model-latency-pill">测试中...</span>
      ) : state?.ok ? (
        <span className="model-latency-pill">{state.latencyMs}ms</span>
      ) : state?.error ? (
        <span className="model-latency-pill error" title={state.error}>失败</span>
      ) : null}
      <button
        type="button"
        className="model-action-icon-btn"
        title="测试连接延迟"
        aria-label={`测试 ${modelName} 的连接`}
        disabled={state?.testing}
        onClick={onTest}
      >
        <IconPlug />
      </button>
    </>
  );
}
