export function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dateTimeOf(ts: number): string {
  return new Date(ts).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function relative(ts: number, now = Date.now()): string {
  const delta = ts - now;
  const abs = Math.abs(delta);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  const fmt = (value: number, unit: string) =>
    `${Math.round(value)} ${unit}${Math.round(value) === 1 ? '' : 's'}`;

  let text: string;
  if (abs < minute) text = 'just now';
  else if (abs < hour) text = fmt(abs / minute, 'min');
  else if (abs < day) text = fmt(abs / hour, 'hour');
  else text = fmt(abs / day, 'day');

  if (text === 'just now') return text;
  return delta > 0 ? `in ${text}` : `${text} ago`;
}

export function nameOf(address: string, directory: { address: string; displayName: string }[]): string {
  return directory.find((d) => d.address === address)?.displayName ?? address.split('@')[0];
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** "Today", "Yesterday", or a written-out date — the divider in a message list. */
export function dayLabel(ts: number, now = Date.now()): string {
  const start = (value: number) => {
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((start(now) - start(ts)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(ts).toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: days > 300 ? 'numeric' : undefined,
  });
}

export function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
  );
}

/** A stable colour per person, so avatars stay recognisable between sessions. */
export function avatarColor(seed: string): string {
  const palette = [
    'linear-gradient(135deg, #3b6fd4, #7c4dff)',
    'linear-gradient(135deg, #0ea5e9, #22d3ee)',
    'linear-gradient(135deg, #d946ef, #f472b6)',
    'linear-gradient(135deg, #f97316, #facc15)',
    'linear-gradient(135deg, #10b981, #4ade80)',
    'linear-gradient(135deg, #6366f1, #a78bfa)',
    'linear-gradient(135deg, #ef4444, #fb7185)',
    'linear-gradient(135deg, #0891b2, #34d399)',
  ];
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return palette[(hash >>> 0) % palette.length]!;
}

/** "3 unread" style counts that read naturally at a glance. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Very small markdown subset: headings, bold, code, lists, links stripped to text. */
export function renderMarkdownish(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br/>');
}
