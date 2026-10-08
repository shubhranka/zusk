// SVG icons, copied from zusk-design.dc.html where the design has them.

import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

const base = (size: number, rest: SVGProps<SVGSVGElement>) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  'aria-hidden': true as const,
  ...rest,
})

export const LogoIcon = ({ size = 26, ...p }: P) => (
  <svg {...base(size, p)} stroke="var(--accent)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="5.5" rx="8" ry="3" />
    <path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    <path d="M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </svg>
)

export const SearchIcon = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
)

export const PlusIcon = ({ size = 16, strokeWidth = 2, ...p }: P) => (
  <svg {...base(size, p)} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const GearIcon = ({ size = 18, ...p }: P) => (
  <svg {...base(size, p)} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
)

export const RefreshIcon = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" />
    <path d="M4 3.5V8h4.5" />
    <path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" />
    <path d="M20 20.5V16h-4.5" />
  </svg>
)

export const CollapseIcon = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 4l5 5 5-5" />
    <path d="M7 20l5-5 5 5" />
  </svg>
)

export const ChevronIcon = ({ open, size = 14, ...p }: P & { open: boolean }) => (
  <svg
    {...base(size, p)}
    className={open ? 'chev open' : 'chev'}
    stroke="var(--text-dim)"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
)

export const DatabaseIcon = ({ size = 16, color = 'var(--accent)', ...p }: P & { color?: string }) => (
  <svg {...base(size, p)} stroke={color} strokeWidth={1.7} strokeLinecap="round">
    <ellipse cx="12" cy="6" rx="7" ry="2.6" />
    <path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6" />
    <path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" />
  </svg>
)

export const SchemaIcon = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)} stroke="var(--c-keyword)" strokeWidth={1.7} strokeLinejoin="round">
    <path d="M12 3l9 5-9 5-9-5z" />
    <path d="M3 13l9 5 9-5" />
  </svg>
)

export const FolderIcon = ({ size = 16, ...p }: P) => (
  <svg {...base(size, p)} stroke="var(--text-muted)" strokeWidth={1.7} strokeLinejoin="round">
    <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </svg>
)

export const TableIcon = ({ size = 15, ...p }: P) => (
  <svg {...base(size, p)} stroke="var(--c-ident)" strokeWidth={1.7} strokeLinejoin="round">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M3.5 9.5h17M9.5 9.5v10" />
  </svg>
)

export const ViewIcon = ({ size = 15, ...p }: P) => (
  <svg {...base(size, p)} stroke="var(--c-string)" strokeWidth={1.7}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const FunctionIcon = ({ size = 15, ...p }: P) => (
  <svg {...base(size, p)} stroke="var(--c-number)" strokeWidth={1.8} strokeLinecap="round">
    <path d="M14 4h-1.5A2.5 2.5 0 0 0 10 6.5V20M6.5 11h7" />
  </svg>
)

export const KeyIcon = ({ size = 13, ...p }: P) => (
  <svg
    {...base(size, p)}
    aria-hidden={false}
    role="img"
    aria-label="Primary key"
    stroke="var(--accent)"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="8" cy="15" r="4" />
    <path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2" />
  </svg>
)

export const LinkIcon = ({ size = 13, ...p }: P) => (
  <svg
    {...base(size, p)}
    aria-hidden={false}
    role="img"
    aria-label="Foreign key"
    stroke="var(--c-fk)"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
)

export const ColumnIcon = ({ size = 13, ...p }: P) => (
  <svg {...base(size, p)} stroke="var(--text-faint)" strokeWidth={2} strokeLinecap="round">
    <path d="M6 8h12M6 12h12M6 16h8" />
  </svg>
)

export const PlayIcon = ({ size = 14, ...p }: P) => (
  <svg {...base(size, p)} fill="currentColor">
    <path d="M7 4.5v15l12-7.5z" />
  </svg>
)

export const StopIcon = ({ size = 12, ...p }: P) => (
  <svg {...base(size, p)} fill="currentColor">
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
)

export const FilterIcon = ({ size = 15, ...p }: P) => (
  <svg {...base(size, p)} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5h16l-6 7.5V19l-4 1.5v-8z" />
  </svg>
)

export const LockIcon = ({ size = 14, open = false, ...p }: P & { open?: boolean }) => (
  <svg {...base(size, p)} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="9.5" rx="2" />
    <path d={open ? 'M8 11V7.5a4 4 0 0 1 7.6-1.7' : 'M8 11V7.5a4 4 0 0 1 8 0V11'} />
  </svg>
)

export const PencilIcon = ({ size = 14, ...p }: P) => (
  <svg {...base(size, p)} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </svg>
)

export const UnplugIcon = ({ size = 14, ...p }: P) => (
  <svg {...base(size, p)} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 17l-3 3M17 7l3-3" />
    <path d="M9.5 9.5L7 12a3.5 3.5 0 0 0 5 5l2.5-2.5" />
    <path d="M14.5 14.5L17 12a3.5 3.5 0 0 0-5-5L9.5 9.5" />
    <path d="M4 4l16 16" />
  </svg>
)

export const CloseIcon = ({ size = 14, ...p }: P) => (
  <svg {...base(size, p)} stroke="currentColor" strokeWidth={1.9} strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)

export const EyeIcon = ({ size = 16, off = false, ...p }: P & { off?: boolean }) => (
  <svg {...base(size, p)} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="M4 4l16 16" />}
  </svg>
)

export const AlertIcon = ({ size = 15, ...p }: P) => (
  <svg {...base(size, p)} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.5v.01" />
  </svg>
)
