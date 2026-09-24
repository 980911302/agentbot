/** 通用组件库桶文件（UI-02）。按需 import，避免全量耦合。 */
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button.js';
export { IconButton, type IconButtonProps } from './IconButton.js';
export { Modal, type ModalProps } from './Modal.js';
export { Menu, MenuItem, type MenuProps, type MenuItemProps } from './Menu.js';
export { Tooltip, type TooltipProps } from './Tooltip.js';
export { ToastProvider, toast, type ToastItem } from './Toast.js';
export { Chip, type ChipProps } from './Chip.js';
export { Skeleton, type SkeletonProps } from './Skeleton.js';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedControlOption,
} from './SegmentedControl.js';
export { useModalKeys, type UseModalKeysOptions } from './useModalKeys.js';
