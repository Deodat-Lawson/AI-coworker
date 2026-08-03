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
