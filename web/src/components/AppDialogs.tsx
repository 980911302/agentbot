import { BotProfileDialog } from './BotProfileDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { CreateDialog, type CreateAgentInput, type CreateRoomInput } from './CreateDialog';
import { RenameDialog } from './RenameDialog';
import { SettingsDialog } from './settings';
import type { ChannelItem } from './Sidebar';
import type { ThemePreference } from '../theme';
import type { DeleteConfirmCopy, SettingsSection } from '../features/workspace/dialog-view';
import type { BotSummary, ToolInfo } from '../types';

interface AppDialogsProps {
  /** 新建智能体 / 新建群 */
  createOpen: boolean;
  agents: BotSummary[];
  memberLimit: number;
  onCreateAgent: (input: CreateAgentInput) => void;
  onCreateRoom: (input: CreateRoomInput) => void;
  onCloseCreate: () => void;
  /** 模型管理与偏好设置 */
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  theme: ThemePreference;
  endpoint: string;
  tools: ToolInfo[];
  ownerName: string;
  onTheme: (next: ThemePreference) => void;
  onModel: (next: string) => void;
  onOwnerName: (next: string) => void;
  onCloseSettings: () => void;
  /** 后端未连接时的提示条 */
  online: boolean;
  /** 删除 / 解散的确认 */
  deleteOpen: boolean;
  deleteCopy: DeleteConfirmCopy;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  /** 智能体资料弹窗与群改名 */
  editingBot: BotSummary | null;
  onCloseEditBot: () => void;
  onSaveBotProfile: React.ComponentProps<typeof BotProfileDialog>['onSave'];
  renamingChannel: ChannelItem | null;
  onCloseRename: () => void;
  onSubmitRename: (name: string) => Promise<string | null>;
}

/**
 * 所有弹窗与提示条（OPT-04 从 App.tsx 抽出）。
 * 只负责「按状态摆出来」，开关状态仍在 use-dialogs，动作仍在 use-channel-actions——
 * 结构与文案与抽出前逐行一致。
 */
export function AppDialogs({
  createOpen,
  agents,
  memberLimit,
  onCreateAgent,
  onCreateRoom,
  onCloseCreate,
  settingsOpen,
  settingsSection,
  theme,
  endpoint,
  tools,
  ownerName,
  onTheme,
  onModel,
  onOwnerName,
  onCloseSettings,
  online,
  deleteOpen,
  deleteCopy,
  onConfirmDelete,
  onCancelDelete,
  editingBot,
  onCloseEditBot,
  onSaveBotProfile,
  renamingChannel,
  onCloseRename,
  onSubmitRename,
}: AppDialogsProps) {
  return (
    <>
      <CreateDialog
        open={createOpen}
        agents={agents}
        memberLimit={memberLimit}
        onCreateAgent={onCreateAgent}
        onCreateRoom={onCreateRoom}
        onClose={onCloseCreate}
      />

      <SettingsDialog
        open={settingsOpen}
        openSection={settingsSection}
        theme={theme}
        endpoint={endpoint}
        toolCount={tools.length}
        ownerName={ownerName}
        onTheme={onTheme}
        onModel={onModel}
        onOwnerName={onOwnerName}
        onClose={onCloseSettings}
      />

      {!online ? <div className="offline">后端服务未连接 · 当前展示本地联调视图</div> : null}

      <ConfirmDialog
        open={deleteOpen}
        danger
        title={deleteCopy.title}
        message={deleteCopy.message}
        confirmLabel={deleteCopy.confirmLabel}
        onConfirm={onConfirmDelete}
        onCancel={onCancelDelete}
      />

      <BotProfileDialog
        bot={editingBot}
        onClose={onCloseEditBot}
        onSave={onSaveBotProfile}
      />

      <RenameDialog
        title="重命名群"
        initial={renamingChannel?.name ?? ''}
        open={renamingChannel !== null}
        onClose={onCloseRename}
        onSubmit={onSubmitRename}
      />
    </>
  );
}