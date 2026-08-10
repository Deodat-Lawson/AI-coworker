/**
 * The sidebar, as the person arranged it.
 *
 * Slack gives you sections; Discord gives you categories. Both are the same
 * idea and both are the first thing anybody reaches for once they are in a
 * workspace with more than a dozen channels: *I want these four together, at
 * the top, called something I chose.*
 *
 * The layout is stored as a **diff from the default**, not as a full list. An
 * empty `sections` array means "draw the standard layout", so a workspace
 * nobody customized keeps working when the defaults change, and a channel
 * created tomorrow lands somewhere sensible instead of vanishing because it was
 * not in a list written last week. `resolveSections` is what turns the stored
 * diff plus today's channels into what the sidebar actually draws, and it is
 * total: every channel comes out exactly once.
 */

import type { ChannelId } from './workspace.js';

/** The groups the app draws when nobody has said otherwise. */
export type BuiltinSection = 'starred' | 'channels' | 'meetings' | 'dms';

export const BUILTIN_SECTIONS: readonly BuiltinSection[] = [
  'starred',
  'channels',
  'meetings',
  'dms',
] as const;

export const BUILTIN_LABELS: Record<BuiltinSection, string> = {
  starred: 'Starred',
  channels: 'Channels',
  meetings: 'Meetings',
  dms: 'Direct messages',
};

export const BUILTIN_EMOJI: Record<BuiltinSection, string> = {
  starred: '★',
  channels: '#',
  meetings: '◷',
  dms: '✉',
};

/**
 * One group in the sidebar.
 *
 * A section made by a person owns its channels explicitly — that is the point
 * of dragging one into it. A built-in section owns whatever is left over that
 * matches its kind, which is why `channels` on a built-in is a *pin list*: the
 * things put there deliberately, drawn before the rest.
 */
export interface SidebarSection {
  id: string;
  name: string;
  /** A single emoji or glyph drawn before the name. */
  emoji: string;
  collapsed: boolean;
  /** Explicit membership, in the order the person arranged. */
  channels: ChannelId[];
  /** Set when this is one of the standard groups rather than one somebody made. */
  builtin?: BuiltinSection;
  /** Draw only rows with something unread, the way Discord's collapse works. */
  unreadOnly?: boolean;
}

export interface SidebarLayout {
  sections: SidebarSection[];
}

/** A channel as the sidebar needs to sort it — the fields, not the view model. */
export interface SidebarChannel {
  id: ChannelId;
  kind: 'public' | 'private' | 'dm' | 'group_dm';
  starred: boolean;
  isMeeting: boolean;
  archived: boolean;
  /** For ordering inside a built-in group. */
  lastMessageAt: number;
  name: string;
}

export function builtinSection(kind: BuiltinSection): SidebarSection {
  return {
    id: `builtin:${kind}`,
    name: BUILTIN_LABELS[kind],
    emoji: BUILTIN_EMOJI[kind],
    collapsed: false,
    channels: [],
    builtin: kind,
  };
}

export function defaultSections(): SidebarSection[] {
  return BUILTIN_SECTIONS.map(builtinSection);
}

export function newSection(input: { name: string; emoji?: string; id?: string }): SidebarSection {
  return {
    id: input.id ?? `sec_${Math.random().toString(36).slice(2, 10)}`,
    name: input.name.trim().slice(0, 40) || 'New section',
    emoji: input.emoji || '▸',
    collapsed: false,
    channels: [],
  };
}

/**
 * Where a channel belongs when nobody has moved it.
 *
 * Order matters: starred beats everything (that is what starring is for), a
 * meeting is never a channel somebody chose to have, and a DM is its own kind.
 */
export function naturalSection(channel: SidebarChannel): BuiltinSection {
  if (channel.isMeeting) return 'meetings';
  if (channel.starred) return 'starred';
  if (channel.kind === 'dm' || channel.kind === 'group_dm') return 'dms';
  return 'channels';
}

/**
 * Turn the stored layout plus today's channels into what to draw.
 *
 * Guarantees, in order of how much they matter:
 *  1. Every channel handed in appears exactly once.
 *  2. A channel somebody filed into a section stays there, at the position they
 *     put it, even after it is starred or goes quiet.
 *  3. A channel nobody filed lands in its natural group.
 *  4. A section that ends up empty is dropped, *unless* somebody made it — an
 *     empty section you named is a place you are about to put something.
 */
export function resolveSections(
  stored: SidebarSection[] | undefined,
  channels: SidebarChannel[],
): SidebarSection[] {
  const layout = normalizeSections(stored);
  const byId = new Map(channels.map((c) => [c.id, c]));
  const placed = new Set<ChannelId>();

  // Pass one: honour explicit membership, dropping ids for channels that are
  // gone (archived out from under them, or left).
  const resolved = layout.map((section) => {
    const kept = section.channels.filter((id) => byId.has(id) && !placed.has(id));
    for (const id of kept) placed.add(id);
    return { ...section, channels: kept };
  });

  // Pass two: everything nobody filed falls into its natural group.
  const leftovers = channels.filter((c) => !placed.has(c.id));
  for (const channel of leftovers) {
    const kind = naturalSection(channel);
    const target = resolved.find((s) => s.builtin === kind);
    if (target) target.channels.push(channel.id);
    else {
      // Somebody deleted the built-in group this channel belongs to. It still
      // has to be reachable, so the group comes back rather than the channel
      // disappearing from the app.
      const revived = builtinSection(kind);
      revived.channels.push(channel.id);
      resolved.push(revived);
    }
  }

  // Ordering *inside* a built-in group is the app's business, not the person's:
  // they did not arrange it, so it follows the rule the group is named for.
  for (const section of resolved) {
    if (!section.builtin) continue;
    const pinned = new Set(
      (layout.find((s) => s.id === section.id)?.channels ?? []).filter((id) => byId.has(id)),
    );
    section.channels.sort((a, b) => {
      const pinDelta = Number(pinned.has(b)) - Number(pinned.has(a));
      if (pinDelta) return pinDelta;
      const left = byId.get(a)!;
      const right = byId.get(b)!;
      if (section.builtin === 'dms' || section.builtin === 'meetings') {
        return right.lastMessageAt - left.lastMessageAt || left.name.localeCompare(right.name);
      }
      return left.name.localeCompare(right.name);
    });
  }

  return resolved.filter((section) => section.builtin === undefined || section.channels.length > 0);
}

/** Fill in anything a stored layout predates, and drop anything malformed. */
export function normalizeSections(stored: SidebarSection[] | undefined): SidebarSection[] {
  if (!stored?.length) return defaultSections();
  const seen = new Set<string>();
  const out: SidebarSection[] = [];
  for (const section of stored) {
    if (!section?.id || seen.has(section.id)) continue;
    seen.add(section.id);
    out.push({
      id: section.id,
      name: (section.name ?? '').slice(0, 40) || 'Section',
      emoji: section.emoji || '▸',
      collapsed: Boolean(section.collapsed),
      channels: [...new Set(section.channels ?? [])],
      builtin: section.builtin,
      unreadOnly: section.unreadOnly,
    });
  }
  // Any built-in the stored layout never mentioned is appended, so a layout
  // written before a group existed still shows that group's channels.
  for (const kind of BUILTIN_SECTIONS) {
    if (!out.some((s) => s.builtin === kind)) out.push(builtinSection(kind));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * Move a channel into a section at a position.
 *
 * Always removes it from wherever it was first, so the "appears exactly once"
 * guarantee holds without the caller thinking about it. Dropping onto a
 * built-in group with `index` unset means "stop pinning this here", which is
 * how a channel goes back to sorting itself.
 */
export function placeChannel(
  sections: SidebarSection[],
  channelId: ChannelId,
  sectionId: string,
  index?: number,
): SidebarSection[] {
  const stripped = sections.map((section) => ({
    ...section,
    channels: section.channels.filter((id) => id !== channelId),
  }));
  const target = stripped.find((section) => section.id === sectionId);
  if (!target) return stripped;
  const at = index === undefined ? target.channels.length : Math.max(0, Math.min(index, target.channels.length));
  target.channels.splice(at, 0, channelId);
  return stripped;
}

/** Take a channel out of every explicit list; it returns to its natural group. */
export function unfileChannel(sections: SidebarSection[], channelId: ChannelId): SidebarSection[] {
  return sections.map((section) => ({
    ...section,
    channels: section.channels.filter((id) => id !== channelId),
  }));
}

export function moveSection(sections: SidebarSection[], sectionId: string, to: number): SidebarSection[] {
  const from = sections.findIndex((section) => section.id === sectionId);
  if (from === -1) return sections;
  const next = [...sections];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved!);
  return next;
}

export function updateSection(
  sections: SidebarSection[],
  sectionId: string,
  patch: Partial<Pick<SidebarSection, 'name' | 'emoji' | 'collapsed' | 'unreadOnly'>>,
): SidebarSection[] {
  return sections.map((section) =>
    section.id === sectionId
      ? { ...section, ...patch, name: (patch.name ?? section.name).slice(0, 40) || section.name }
      : section,
  );
}

/**
 * Delete a section somebody made. Its channels are not deleted — they fall back
 * to their natural group on the next resolve, which is the only forgiving
 * behaviour here. Built-in groups cannot be removed; hiding one is what
 * collapsing is for.
 */
export function removeSection(sections: SidebarSection[], sectionId: string): SidebarSection[] {
  return sections.filter((section) => section.builtin !== undefined || section.id !== sectionId);
}
