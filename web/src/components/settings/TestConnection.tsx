import type { TestState } from './model-settings-shared.js';

/** 连接测试：文字按钮，结果就地显示在按钮上（延迟或「失败」），再点一次重测。 */
export function TestConnection({
  modelName,
  state,
  onTest,
}: {
  modelName: string;
  state?: TestState;
  onTest: () => void;
}) {
  const label = state?.testing
    ? '测试中…'
    : state?.ok
      ? `${state.latencyMs ?? 0}ms`
      : state?.error
        ? '失败'
        : '测试';
  const tone = state?.ok ? ' ok' : state?.error && !state.testing ? ' failed' : '';
  return (
    <button
      type="button"
      className={`model-test${tone}`}
      title={state?.error ?? '测试连接'}
      aria-label={`测试 ${modelName} 的连接`}
      disabled={state?.testing}
      onClick={onTest}
    >
      {label}
    </button>
  );
}
