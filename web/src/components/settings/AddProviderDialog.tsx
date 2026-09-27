import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../ui';
import { useModalKeys } from '../ui/useModalKeys.js';
import { Field } from './Field.js';
import {
  EMPTY_PROVIDER_DRAFT,
  providerDraftErrors,
  type ProviderDraft,
  type ProviderDraftErrors,
} from './model-settings-shared.js';

/**
 * 添加服务商：名称、地址、Key、第一个模型，一步到能用。
 * 叠在设置窗口上面：注册进弹窗栈，Esc 只关它自己、不连设置窗口一起关。
 */
export function AddProviderDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (draft: ProviderDraft) => Promise<boolean>;
}) {
  const dialogRef = useModalKeys({ open, onClose, id: 'settings-add-provider' });
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_PROVIDER_DRAFT);
  const [errors, setErrors] = useState<ProviderDraftErrors>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(EMPTY_PROVIDER_DRAFT);
    setErrors({});
  }, [open]);

  if (!open) return null;

  const patch = (next: Partial<ProviderDraft>) => setDraft((prev) => ({ ...prev, ...next }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = providerDraftErrors(draft);
    setErrors(found);
    if (Object.keys(found).length > 0 || saving) return;
    setSaving(true);
    const ok = await onSubmit(draft);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <div
      className="submodal-overlay"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        className="submodal-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-provider-title"
      >
        <h3 className="submodal-title" id="add-provider-title">
          添加服务商
        </h3>
        <form onSubmit={(event) => void submit(event)}>
          <Field label="名称" htmlFor="new-provider-name" error={errors.name}>
            <input
              id="new-provider-name"
              className="provider-text-input"
              placeholder="DeepSeek"
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </Field>
          <Field label="地址" htmlFor="new-provider-url" error={errors.baseURL}>
            <input
              id="new-provider-url"
              className="provider-text-input"
              placeholder="https://api.deepseek.com/v1"
              value={draft.baseURL}
              onChange={(event) => patch({ baseURL: event.target.value })}
            />
          </Field>
          <Field label="Key" htmlFor="new-provider-key">
            <input
              id="new-provider-key"
              type="password"
              className="provider-text-input"
              placeholder="sk-...，可以之后再填"
              autoComplete="off"
              value={draft.apiKey}
              onChange={(event) => patch({ apiKey: event.target.value })}
            />
          </Field>
          <Field label="模型" htmlFor="new-provider-model" error={errors.model}>
            <input
              id="new-provider-model"
              className="provider-text-input"
              placeholder="deepseek-flash"
              value={draft.model}
              onChange={(event) => patch({ model: event.target.value })}
            />
          </Field>
          <div className="submodal-actions">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" type="submit" loading={saving}>
              添加
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
