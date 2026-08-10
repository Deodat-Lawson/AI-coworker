/**
 * The icon set.
 *
 * These replaced a row of Unicode glyphs — ▣ ◈ ☑ ⇱ — that were doing the work of
 * icons without being any. A glyph is whatever the installed font decides it is:
 * it lands at a different weight and baseline from its neighbours, it cannot be
 * two-tone, and "▣" does not mean "projects" to anybody who has not been told.
 *
 * So: one grid, one stroke weight, `currentColor` throughout. Every icon is
 * drawn inside a 24×24 box on a 1.6px stroke with round joins, which is what
 * makes a row of them read as a set rather than as whatever each one happened to
 * be. Fills are used only where a shape is genuinely solid (the dot on today's
 * date), never to carry meaning on their own.
 *
 * The four that name a section of Knowledge are chosen to be unmistakable from
 * each other at 18px, because that is the size they are actually read at:
 *
 *   Projects   a folder      — the thing notes and artifacts live in
 *   Artifacts  a box         — a thing you hand to someone
 *   Tasks      a checklist   — work, with one line done
 *   Sources    a plug        — where knowledge is piped in from
 */

interface IconProps {
  /** Edge length in px. The stroke is scaled with it so 14px is not a smudge. */
  size?: number;
  className?: string;
}

function Svg({ size = 18, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function NewNoteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 3.2V7a1.5 1.5 0 0 0 1.5 1.5h3.8" />
      <path d="M19.3 10.4V19a2 2 0 0 1-2 2H6.7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.6Z" />
      <path d="M12 12.4v5" />
      <path d="M9.5 14.9h5" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.5 15.5 20 20" />
    </Svg>
  );
}

export function SwitcherIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3.5 4 7.5l4 4" />
      <path d="M4 7.5h15" />
      <path d="M16 20.5l4-4-4-4" />
      <path d="M20 16.5H5" />
    </Svg>
  );
}

export function GraphIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="6.5" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <circle cx="11.5" cy="18" r="2.5" />
      <path d="M8.4 7.1 15.6 8.5" />
      <path d="M7.1 8.8l3.3 6.9" />
      <path d="M16.7 11.1 13 15.9" />
    </Svg>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.6" y="5.2" width="16.8" height="15.2" rx="2.2" />
      <path d="M3.6 10.2h16.8" />
      <path d="M8 3.2v3.6" />
      <path d="M16 3.2v3.6" />
      <circle cx="12" cy="15.2" r="1.35" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function CommandIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3Z" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function ProjectsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.8 19.2V6.6a1.6 1.6 0 0 1 1.6-1.6h3.7a1.6 1.6 0 0 1 1.28.64l.94 1.26a1.6 1.6 0 0 0 1.28.64h6a1.6 1.6 0 0 1 1.6 1.6v10.06a1.6 1.6 0 0 1-1.6 1.6H5.4a1.6 1.6 0 0 1-1.6-1.6Z" />
      <path d="M8 15.6h5.4" />
    </Svg>
  );
}

export function ArtifactsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.3 20 7.5v9L12 20.7 4 16.5v-9Z" />
      <path d="M4 7.5 12 11.7l8-4.2" />
      <path d="M12 11.7v9" />
    </Svg>
  );
}

export function TasksIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6.8h9.5" />
      <path d="M4 12h9.5" />
      <path d="M4 17.2h5.5" />
      <path d="M15.4 16.4 17.6 18.6 21 14.8" />
    </Svg>
  );
}

export function SourcesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 3.2v4.4" />
      <path d="M15 3.2v4.4" />
      <path d="M6.4 7.6h11.2v3.3a5.6 5.6 0 0 1-11.2 0Z" />
      <path d="M12 16.5v4.3" />
    </Svg>
  );
}

/** Reading view / editing view, the pair the tab bar toggles between. */
export function EyeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.6 12S6 6.4 12 6.4 21.4 12 21.4 12 18 17.6 12 17.6 2.6 12 2.6 12Z" />
      <circle cx="12" cy="12" r="2.9" />
    </Svg>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12.6 20.4H20" />
      <path d="M16.1 4.2a2.1 2.1 0 0 1 3 3L8.2 18.1l-4.1 1.1 1.1-4.1Z" />
    </Svg>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5.6" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="18.4" cy="12" r="1.35" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Sits in front of an external link, so a URL is not the only signal. */
export function ExternalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.4 4.6H19.4V10.6" />
      <path d="M19.4 4.6 11.6 12.4" />
      <path d="M17.4 14.6v4a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8V8.4a1.8 1.8 0 0 1 1.8-1.8h4" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.6 7.4h14.8" />
      <path d="M9.4 7.4V5.6a1.4 1.4 0 0 1 1.4-1.4h2.4a1.4 1.4 0 0 1 1.4 1.4v1.8" />
      <path d="M6.6 7.4l.8 11.4a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.8-11.4" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5.2v13.6" />
      <path d="M5.2 12h13.6" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12.8 9.6 17.4 19 7.2" />
    </Svg>
  );
}

export function FolderOpenIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.8 8.4V6.6A1.6 1.6 0 0 1 5.4 5h3.7a1.6 1.6 0 0 1 1.28.64l.94 1.26a1.6 1.6 0 0 0 1.28.64h6a1.6 1.6 0 0 1 1.6 1.6v.66" />
      <path d="M2.8 11.4h18.4l-1.7 7.3a1.6 1.6 0 0 1-1.56 1.24H6.06A1.6 1.6 0 0 1 4.5 18.7Z" />
    </Svg>
  );
}
