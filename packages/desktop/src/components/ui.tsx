import { useEffect, useRef, useState, type ReactNode } from 'react';

import { EMOJI_PICKER_ROWS, emojiFor, searchEmoji } from '@ai-coworker/shared';

import { avatarColor, initials } from '../lib/format.js';
import { Icon, type IconName } from './icons.js';

/** A centred dialog. Escape closes it, and clicking the backdrop does too. */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{title}</div>
            {subtitle ? <div className="modal-sub">{subtitle}</div> : null}
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/** A dismissable popover anchored wherever it is rendered. */
export function Popover({ onClose, children, align = 'left' }: { onClose: () => void; children: ReactNode; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // Defer: the click that opened this popover is still bubbling.
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div className={`popover ${align}`} ref={ref}>
      {children}
    </div>
  );
}

/**
 * A menu that opens where the pointer is, the way right-clicking a channel
 * works in Slack and Discord.
 *
 * It positions itself after mounting rather than at the click, because the only
 * way to know whether a menu fits below the cursor is to measure the menu — and
 * a menu that opens half off the bottom of the window is worse than no menu.
 */
export function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const margin = 8;
    const left = Math.max(margin, Math.min(x, window.innerWidth - box.width - margin));
    const top =
      y + box.height + margin > window.innerHeight
        ? Math.max(margin, y - box.height)
        : y;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const id = setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      window.addEventListener('contextmenu', onDown);
    }, 0);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('contextmenu', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div
      className="context-menu"
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/** One row in a context menu: an icon, a label, and an optional shortcut. */
export function MenuRow({
  icon,
  label,
  hint,
  danger,
  checked,
  onClick,
}: {
  icon?: IconName;
  label: string;
  hint?: string;
  danger?: boolean;
  checked?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`menu-item ${danger ? 'danger' : ''}`} role="menuitem" onClick={onClick}>
      {icon ? <Icon name={icon} size={15} className="menu-icon" /> : <span className="menu-icon" />}
      <span className="menu-text">{label}</span>
      {checked ? <Icon name="check" size={14} className="menu-check" /> : null}
      {hint ? <span className="menu-hint">{hint}</span> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-label">{children}</div>;
}

export function Avatar({
  name,
  address,
  size = 36,
  presence,
  square,
  image,
}: {
  name: string;
  address: string;
  size?: number;
  presence?: 'active' | 'away' | 'dnd' | 'offline';
  square?: boolean;
  /** An uploaded picture. Initials are the fallback, not the placeholder. */
  image?: string;
}) {
  const radius = square ? Math.round(size / 4) : '50%';
  return (
    <span className="avatar-wrap" style={{ width: size, height: size }}>
      {image ? (
        <img
          className="avatar"
          src={image}
          alt=""
          style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover' }}
        />
      ) : (
        <span
          className="avatar"
          style={{
            width: size,
            height: size,
            background: avatarColor(address || name),
            borderRadius: radius,
            fontSize: Math.max(10, Math.round(size / 2.6)),
          }}
        >
          {initials(name)}
        </span>
      )}
      {presence ? <span className={`presence ${presence}`} title={presence} /> : null}
    </span>
  );
}

const QUICK = ['👍', '🎉', '❤️', '👀', '✅', '🔥'];

/** Emoji picker: a handful of instant reactions, plus search over shortcodes. */
export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const results = query ? searchEmoji(query, 32) : [];

  return (
    <Popover onClose={onClose}>
      <div className="emoji-picker">
        <input
          autoFocus
          placeholder="Search emoji"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <div className="emoji-grid">
            {results.map((hit) => (
              <button key={hit.code} title={`:${hit.code}:`} onClick={() => onPick(hit.char)}>
                {hit.char}
              </button>
            ))}
            {!results.length ? <div className="hint">Nothing matches.</div> : null}
          </div>
        ) : (
          EMOJI_PICKER_ROWS.map((row) => (
            <div key={row.label}>
              <div className="emoji-row-label">{row.label}</div>
              <div className="emoji-grid">
                {row.codes.map((code) => (
                  <button key={code} title={`:${code}:`} onClick={() => onPick(emojiFor(code) ?? '')}>
                    {emojiFor(code)}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </Popover>
  );
}

/** The six one-tap reactions that hang off the message hover toolbar. */
export function QuickReactions({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <>
      {QUICK.map((emoji) => (
        <button key={emoji} className="hover-action" title={`React ${emoji}`} onClick={() => onPick(emoji)}>
          {emoji}
        </button>
      ))}
    </>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

/** Inline confirmation for anything destructive; no native dialogs. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = 'danger',
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);

  return (
    <button
      className={className}
      onClick={() => {
        if (armed) onConfirm();
        else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
