/** Inline icons. Small enough that a sprite sheet or a font would cost more. */

import type { ComponentChildren } from 'preact';

interface IconProps {
  size?: number;
  class?: string;
}

function base(size: number, cls: string | undefined, children: ComponentChildren) {
  return (
    <svg
      class={cls}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const PlusIcon = ({ size = 16, class: cls }: IconProps) =>
  base(size, cls, <><path d="M12 5v14" /><path d="M5 12h14" /></>);

export const CloseIcon = ({ size = 16, class: cls }: IconProps) =>
  base(size, cls, <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);

export const SplitRightIcon = ({ size = 16, class: cls }: IconProps) =>
  base(size, cls, <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></>);

export const SplitDownIcon = ({ size = 16, class: cls }: IconProps) =>
  base(size, cls, <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 12h18" /></>);

export const SettingsIcon = ({ size = 16, class: cls }: IconProps) =>
  base(
    size,
    cls,
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 5 8.9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1A1.7 1.7 0 0 0 10.5 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>,
  );

export const SidebarIcon = ({ size = 16, class: cls }: IconProps) =>
  base(size, cls, <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>);

export const SearchIcon = ({ size = 16, class: cls }: IconProps) =>
  base(size, cls, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);

export const TerminalIcon = ({ size = 16, class: cls }: IconProps) =>
  base(size, cls, <><path d="m5 7 4 4-4 4" /><path d="M13 15h6" /></>);

export const PencilIcon = ({ size = 16, class: cls }: IconProps) =>
  base(
    size,
    cls,
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>,
  );

export const ChevronIcon = ({ size = 16, class: cls }: IconProps) =>
  base(size, cls, <path d="m9 6 6 6-6 6" />);

export const LockIcon = ({ size = 16, class: cls }: IconProps) =>
  base(
    size,
    cls,
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>,
  );

export const UnlockIcon = ({ size = 16, class: cls }: IconProps) =>
  base(
    size,
    cls,
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 7.5-2" />
    </>,
  );

export const PinIcon = ({ size = 16, class: cls }: IconProps) =>
  base(
    size,
    cls,
    <>
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z" />
    </>,
  );
