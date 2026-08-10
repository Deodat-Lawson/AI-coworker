/**
 * The icon set.
 *
 * Every icon in the app comes from here, drawn on one 24×24 grid with one
 * stroke weight, so a row of them reads as a set rather than as a pile of
 * symbols. That is the whole reason this file exists: the app used to draw its
 * navigation with text glyphs — ◆ for the agent, ⌕ for search, ❑ for threads —
 * and typographic glyphs cannot be made to line up. They carry their own
 * metrics, their own weight, and their own vertical centre, and no amount of
 * CSS makes ⌕ sit at the same optical size as #.
 *
 * Conventions, kept deliberately narrow:
 *  - 24×24 box, 1.75 stroke, round caps and joins, no fills except where a
 *    shape is genuinely solid (a presence dot, a filled star).
 *  - Icons never carry colour. They inherit `currentColor`, so the same icon
 *    works on a rail, in a menu, and inside a danger button.
 *  - `size` is the rendered pixel box. 16 in dense lists, 18 in the sidebar,
 *    20 in headers, 24+ in empty states.
 *
 * Adding one: draw it on the same grid, keep the optical weight of its
 * neighbours (a glyph made of long straight lines looks heavier than one made
 * of short ones at the same stroke width), and add it to `PATHS`.
 */

import type { CSSProperties, ReactNode } from 'react';

export type IconName =
  // navigation
  | 'search'
  | 'activity'
  | 'threads'
  | 'agent'
  | 'people'
  | 'knowledge'
  | 'settings'
  | 'home'
  | 'compass'
  // channels
  | 'hash'
  | 'lock'
  | 'megaphone'
  | 'envelope'
  | 'meeting'
  | 'star'
  | 'star-filled'
  | 'bell'
  | 'bell-off'
  | 'pin'
  | 'archive'
  // actions
  | 'plus'
  | 'minus'
  | 'check'
  | 'close'
  | 'more'
  | 'edit'
  | 'trash'
  | 'send'
  | 'refresh'
  | 'upload'
  | 'download'
  | 'external'
  | 'link'
  | 'copy'
  | 'filter'
  | 'grip'
  | 'reply'
  | 'emoji'
  | 'attach'
  // state
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-up'
  | 'arrow-right'
  | 'eye'
  | 'eye-off'
  | 'clock'
  | 'calendar'
  | 'play'
  | 'pause'
  | 'alert'
  | 'info'
  | 'shield'
  | 'shield-check'
  | 'key'
  | 'sparkle'
  // the machine
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'terminal'
  | 'code'
  | 'cpu'
  | 'database'
  | 'plug'
  | 'brain'
  | 'workspace'
  | 'palette'
  | 'layout'
  | 'image'
  | 'globe';

/**
 * Path data only — no `<svg>` wrapper, no colour, no size. The wrapper below
 * owns all of that so a new icon cannot quietly disagree with the set.
 */
const PATHS: Record<IconName, ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-3.6-3.6" />
    </>
  ),
  activity: <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />,
  threads: (
    <>
      <path d="M20 14a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
      <path d="M8 9h8M8 12h5" />
    </>
  ),
  agent: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 4v3M9 12v1.5M15 12v1.5M9.5 16.5h5" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 6.5a3 3 0 0 1 0 5.6M17.5 15.2a5.5 5.5 0 0 1 3 3.8" />
    </>
  ),
  knowledge: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 15.5z" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h4.5a1.5 1.5 0 0 0 1.5-1.5z" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
    </>
  ),
  home: <path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z" />,
  compass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15 9-2 4.2-4 1.8 2-4.2z" />
    </>
  ),

  hash: <path d="M6 9.5h13M5 15h13M10.5 4l-2 16M16.5 4l-2 16" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 10v4a1.5 1.5 0 0 0 1.5 1.5H8l7 4.5V5.5L8 10H5.5A1.5 1.5 0 0 0 4 11.5z" />
      <path d="M18 9.5a4 4 0 0 1 0 5" />
    </>
  ),
  envelope: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),
  meeting: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  star: <path d="m12 4 2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4-3.9 5.5-.8z" />,
  'star-filled': (
    <path
      d="m12 4 2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4-3.9 5.5-.8z"
      fill="currentColor"
    />
  ),
  bell: (
    <>
      <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5" />
      <path d="M10 18.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  'bell-off': (
    <>
      <path d="M8.6 6.4A5.5 5.5 0 0 1 17.5 10c0 4 1.5 5.5 1.5 5.5H9" />
      <path d="M6.6 9.4c-.1.2-.1.4-.1.6 0 4-1.5 5.5-1.5 5.5h2" />
      <path d="M10 18.5a2.2 2.2 0 0 0 4 0" />
      <path d="M4 4l16 16" />
    </>
  ),
  pin: (
    <>
      <path d="M9 3.5h6l-.8 5.2 3.3 3.3H6.5l3.3-3.3z" />
      <path d="M12 12v8.5" />
    </>
  ),
  archive: (
    <>
      <rect x="3.5" y="4.5" width="17" height="4" rx="1.2" />
      <path d="M5 8.5v9.8A2.2 2.2 0 0 0 7.2 20.5h9.6a2.2 2.2 0 0 0 2.2-2.2V8.5" />
      <path d="M10 12.5h4" />
    </>
  ),

  plus: <path d="M12 5.5v13M5.5 12h13" />,
  minus: <path d="M5.5 12h13" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z" />
      <path d="m13.5 7 3.5 3.5" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.5h15" />
      <path d="M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5" />
      <path d="M6.5 6.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12.5" />
      <path d="M10.5 10v7M13.5 10v7" />
    </>
  ),
  send: (
    <>
      <path d="M20.5 3.5 10.5 13.5" />
      <path d="M20.5 3.5 14 20.5l-3.5-7-7-3.5z" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4.5" />
      <path d="m7.5 9 4.5-4.5L16.5 9" />
      <path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.5V16" />
      <path d="m7.5 11.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15" />
    </>
  ),
  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19 5 11.5 12.5" />
      <path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 1 0-5-5l-1.2 1.2" />
      <path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 1 0 5 5l1.2-1.2" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </>
  ),
  filter: <path d="M4 6h16l-6.2 7.2v5.3l-3.6 2v-7.3z" />,
  grip: (
    <>
      <circle cx="9.5" cy="6.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="6.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="17.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="17.5" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  reply: (
    <>
      <path d="M9 7 4 11.5 9 16" />
      <path d="M4.5 11.5h9a6 6 0 0 1 6 6v1" />
    </>
  ),
  emoji: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 14.5a4 4 0 0 0 6 0" />
      <circle cx="9.2" cy="9.8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="9.8" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  attach: (
    <path d="M18 11.5 12 17.5a4 4 0 0 1-5.7-5.7l7-7a2.8 2.8 0 0 1 4 4l-7 7a1.6 1.6 0 0 1-2.2-2.2l6.2-6.2" />
  ),

  'chevron-down': <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  'chevron-right': <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,
  'chevron-left': <path d="M14.5 6.5 9 12l5.5 5.5" />,
  'chevron-up': <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />,
  'arrow-right': (
    <>
      <path d="M4.5 12h15" />
      <path d="m13.5 6 6 6-6 6" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M9.9 6c.7-.2 1.4-.3 2.1-.3 6 0 9.5 6.3 9.5 6.3a17 17 0 0 1-2.8 3.6" />
      <path d="M6.3 8A17 17 0 0 0 2.5 12s3.5 6.3 9.5 6.3c1.6 0 3-.4 4.2-1" />
      <path d="M4 4l16 16" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.2l3.4 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3.5v4M16 3.5v4" />
    </>
  ),
  play: <path d="M8 5.5 18.5 12 8 18.5z" />,
  pause: <path d="M9 5.5v13M15 5.5v13" />,
  alert: (
    <>
      <path d="M10.6 4.2 2.9 17.5A1.6 1.6 0 0 0 4.3 20h15.4a1.6 1.6 0 0 0 1.4-2.5L13.4 4.2a1.6 1.6 0 0 0-2.8 0" />
      <path d="M12 9.5v4.2" />
      <circle cx="12" cy="16.8" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  shield: <path d="M12 3.5 5 6.2v5.4c0 4.3 2.9 7.5 7 8.9 4.1-1.4 7-4.6 7-8.9V6.2z" />,
  'shield-check': (
    <>
      <path d="M12 3.5 5 6.2v5.4c0 4.3 2.9 7.5 7 8.9 4.1-1.4 7-4.6 7-8.9V6.2z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="14" r="4" />
      <path d="m10.8 11.2 8-8M16.5 5.5l2 2M14 8l2 2" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3.5 13.6 9 19 10.5 13.6 12 12 17.5 10.4 12 5 10.5 10.4 9z" />
      <path d="M18 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
    </>
  ),

  folder: <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19.5H5a1.5 1.5 0 0 1-1.5-1.5z" />,
  'folder-open': (
    <>
      <path d="M3.5 18V7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v1.5" />
      <path d="m3.5 18 2.4-6.2a1.5 1.5 0 0 1 1.4-1h14.2l-2.6 6.6a1.5 1.5 0 0 1-1.4.9H5A1.5 1.5 0 0 1 3.5 18" />
    </>
  ),
  file: (
    <>
      <path d="M13 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V9z" />
      <path d="M13 3.5V9h5.5M9 13h6M9 16.5h4" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7.5 10 2.5 2.2-2.5 2.3M12.5 15h4" />
    </>
  ),
  code: <path d="m8.5 8-4.5 4 4.5 4M15.5 8l4.5 4-4.5 4M13.5 5l-3 14" />,
  cpu: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <rect x="10" y="10" width="4" height="4" rx="1" />
      <path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6.5" rx="7.5" ry="3" />
      <path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11" />
      <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3.5v5M15 3.5v5" />
      <path d="M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 17v3.5" />
    </>
  ),
  brain: (
    <>
      <path d="M12 5.5a3 3 0 0 0-5.7-1.3A3 3 0 0 0 4 9.5a3.2 3.2 0 0 0 .6 4.4A3 3 0 0 0 8 19a3 3 0 0 0 4 1.2z" />
      <path d="M12 5.5a3 3 0 0 1 5.7-1.3A3 3 0 0 1 20 9.5a3.2 3.2 0 0 1-.6 4.4A3 3 0 0 1 16 19a3 3 0 0 1-4 1.2z" />
    </>
  ),
  workspace: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-1 2-1.8s-.6-1.2-.6-2 .7-1.4 1.6-1.4H17a4 4 0 0 0 4-4c0-4.3-4-7.8-9-7.8" />
      <circle cx="8" cy="10" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="9.5" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  layout: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4 17 4.5-4.2 3.5 3 3-2.6 5 4.3" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5a13 13 0 0 1 0 17 13 13 0 0 1 0-17" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  /** Rendered pixel box. 16 dense, 18 sidebar, 20 header. */
  size?: number;
  className?: string;
  style?: CSSProperties;
  /**
   * Icons are decorative by default: they sit beside a label that already says
   * what the control does. Pass a title only when the icon *is* the label, and
   * then it is announced rather than hidden.
   */
  title?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 18, className, style, title, strokeWidth = 1.75 }: IconProps) {
  const path = PATHS[name];
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {path}
    </svg>
  );
}

/** The icon a channel row draws, given what kind of channel it is. */
export function channelIcon(kind: string, isMeeting?: boolean): IconName {
  if (isMeeting) return 'meeting';
  if (kind === 'private') return 'lock';
  if (kind === 'dm' || kind === 'group_dm') return 'envelope';
  return 'hash';
}
