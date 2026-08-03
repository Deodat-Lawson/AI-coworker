/**
 * Vault settings. Everything here is written to `.obsidian/app.json`, so the
 * folder keeps its own configuration and travels with it.
 */

import { useState } from 'react';

import type { VaultSettings } from '@ai-coworker/shared';

import type { Command } from './commands.js';

interface Props {
  settings: VaultSettings;
  folders: string[];
  templates: string[];
  commands: Command[];
  onChange(patch: Partial<VaultSettings>): void;
  onClose(): void;
  vaultRoot: string;
}

type Section = 'editor' | 'appearance' | 'files' | 'daily' | 'templates' | 'hotkeys' | 'about';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'editor', label: 'Editor' },
  { key: 'appearance', label: 'Appearance' },
  { key: 'files', label: 'Files & links' },
  { key: 'daily', label: 'Daily notes' },
  { key: 'templates', label: 'Templates' },
  { key: 'hotkeys', label: 'Hotkeys' },
  { key: 'about', label: 'About' },
];

export default function SettingsModal({
  settings,
  folders,
  templates,
  commands,
  onChange,
  onClose,
  vaultRoot,
}: Props) {
  const [section, setSection] = useState<Section>('editor');
  const [recording, setRecording] = useState<string | null>(null);
  const [hotkeyFilter, setHotkeyFilter] = useState('');

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-settings" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-nav">
          {SECTIONS.map((entry) => (
            <button
              key={entry.key}
              className={`settings-nav-item${section === entry.key ? ' is-active' : ''}`}
              onClick={() => setSection(entry.key)}
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="settings-body">
          {section === 'editor' ? (
            <>
              <Row label="Default editing mode" hint="What a note opens in.">
                <select
                  value={settings.defaultViewMode}
                  onChange={(event) =>
                    onChange({ defaultViewMode: event.target.value as VaultSettings['defaultViewMode'] })
                  }
                >
                  <option value="live">Live preview</option>
                  <option value="source">Source</option>
                  <option value="reading">Reading</option>
                </select>
              </Row>
              <Row label="Readable line length" hint="Keeps text to a comfortable column.">
                <Switch
                  value={settings.readableLineLength}
                  onChange={(v) => onChange({ readableLineLength: v })}
                />
              </Row>
              <Row label="Line width" hint={`${settings.lineWidth}px`}>
                <input
                  type="range"
                  min={480}
                  max={1200}
                  step={20}
                  value={settings.lineWidth}
                  onChange={(event) => onChange({ lineWidth: Number(event.target.value) })}
                />
              </Row>
              <Row label="Font size" hint={`${settings.fontSize}px`}>
                <input
                  type="range"
                  min={12}
                  max={24}
                  value={settings.fontSize}
                  onChange={(event) => onChange({ fontSize: Number(event.target.value) })}
                />
              </Row>
              <Row label="Show line numbers">
                <Switch
                  value={settings.showLineNumbers}
                  onChange={(v) => onChange({ showLineNumbers: v })}
                />
              </Row>
              <Row label="Spellcheck">
                <Switch value={settings.spellcheck} onChange={(v) => onChange({ spellcheck: v })} />
              </Row>
              <Row
                label="Strict line breaks"
                hint="Off: a single newline breaks the line, as Obsidian does by default."
              >
                <Switch
                  value={settings.strictLineBreaks}
                  onChange={(v) => onChange({ strictLineBreaks: v })}
                />
              </Row>
            </>
          ) : null}

          {section === 'appearance' ? (
            <>
              <Row label="Theme">
                <select
                  value={settings.theme}
                  onChange={(event) => onChange({ theme: event.target.value as VaultSettings['theme'] })}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">Match system</option>
                </select>
              </Row>
              <Row label="Accent colour">
                <div className="accent-row">
                  {['#6ea8fe', '#a78bfa', '#4ade80', '#fbbf24', '#f87171', '#22d3ee'].map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={`accent-swatch${settings.accentColor === color ? ' is-active' : ''}`}
                      style={{ background: color }}
                      onClick={() => onChange({ accentColor: color })}
                    />
                  ))}
                  <input
                    type="color"
                    value={settings.accentColor}
                    onChange={(event) => onChange({ accentColor: event.target.value })}
                  />
                </div>
              </Row>
              <Row label="Show ribbon" hint="The icon strip down the left edge.">
                <Switch value={settings.showRibbon} onChange={(v) => onChange({ showRibbon: v })} />
              </Row>
              <Row label="Show properties in the note">
                <Switch
                  value={settings.showFrontmatter}
                  onChange={(v) => onChange({ showFrontmatter: v })}
                />
              </Row>
            </>
          ) : null}

          {section === 'files' ? (
            <>
              <Row label="Default folder for new notes">
                <FolderSelect
                  value={settings.newFileFolder}
                  folders={folders}
                  onChange={(v) => onChange({ newFileFolder: v })}
                />
              </Row>
              <Row label="Attachment folder">
                <FolderSelect
                  value={settings.attachmentFolder}
                  folders={folders}
                  onChange={(v) => onChange({ attachmentFolder: v })}
                />
              </Row>
              <Row label="Update links on rename" hint="Rewrites [[links]] pointing at a renamed note.">
                <Switch
                  value={settings.alwaysUpdateLinks}
                  onChange={(v) => onChange({ alwaysUpdateLinks: v })}
                />
              </Row>
              <Row label="Confirm before deleting">
                <Switch value={settings.confirmDelete} onChange={(v) => onChange({ confirmDelete: v })} />
              </Row>
              <Row label="Deleted files">
                <select
                  value={settings.trashOption}
                  onChange={(event) =>
                    onChange({ trashOption: event.target.value as VaultSettings['trashOption'] })
                  }
                >
                  <option value="local">Move to vault trash (.trash)</option>
                  <option value="permanent">Delete permanently</option>
                </select>
              </Row>
            </>
          ) : null}

          {section === 'daily' ? (
            <>
              <Row label="Date format" hint="Tokens: YYYY MM DD dddd HH mm">
                <input
                  value={settings.dailyNoteFormat}
                  onChange={(event) => onChange({ dailyNoteFormat: event.target.value })}
                />
              </Row>
              <Row label="Folder">
                <FolderSelect
                  value={settings.dailyNoteFolder}
                  folders={folders}
                  onChange={(v) => onChange({ dailyNoteFolder: v })}
                />
              </Row>
              <Row label="Template">
                <select
                  value={settings.dailyNoteTemplate}
                  onChange={(event) => onChange({ dailyNoteTemplate: event.target.value })}
                >
                  <option value="">None</option>
                  {templates.map((template) => (
                    <option key={template} value={template}>
                      {template}
                    </option>
                  ))}
                </select>
              </Row>
            </>
          ) : null}

          {section === 'templates' ? (
            <>
              <Row label="Template folder">
                <FolderSelect
                  value={settings.templateFolder}
                  folders={folders}
                  onChange={(v) => onChange({ templateFolder: v })}
                />
              </Row>
              <div className="settings-note">
                <p>Templates support:</p>
                <ul>
                  <li>
                    <code>{'{{title}}'}</code> — the new note's name
                  </li>
                  <li>
                    <code>{'{{date}}'}</code>, <code>{'{{time}}'}</code>
                  </li>
                  <li>
                    <code>{'{{date:YYYY-MM-DD}}'}</code> — any format
                  </li>
                </ul>
                <p>{templates.length} template{templates.length === 1 ? '' : 's'} found.</p>
              </div>
            </>
          ) : null}

          {section === 'hotkeys' ? (
            <>
              <input
                className="hotkey-filter"
                placeholder="Filter commands…"
                value={hotkeyFilter}
                onChange={(event) => setHotkeyFilter(event.target.value)}
              />
              <div className="hotkey-list">
                {commands
                  .filter((command) =>
                    command.name.toLowerCase().includes(hotkeyFilter.trim().toLowerCase()),
                  )
                  .map((command) => {
                    const binding = settings.hotkeys[command.id] ?? command.hotkey ?? '';
                    return (
                      <div className="hotkey-row" key={command.id}>
                        <span className="hotkey-name">{command.name}</span>
                        <button
                          className={`hotkey-key${recording === command.id ? ' is-recording' : ''}`}
                          type="button"
                          onClick={() => setRecording(command.id)}
                          onKeyDown={(event) => {
                            if (recording !== command.id) return;
                            event.preventDefault();
                            if (event.key === 'Escape') {
                              setRecording(null);
                              return;
                            }
                            if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return;
                            const parts: string[] = [];
                            if (event.metaKey || event.ctrlKey) parts.push('Mod');
                            if (event.altKey) parts.push('Alt');
                            if (event.shiftKey) parts.push('Shift');
                            parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
                            onChange({
                              hotkeys: { ...settings.hotkeys, [command.id]: parts.join('+') },
                            });
                            setRecording(null);
                          }}
                        >
                          {recording === command.id ? 'Press keys…' : formatHotkey(binding) || 'Not set'}
                        </button>
                        {settings.hotkeys[command.id] ? (
                          <button
                            className="ghost"
                            type="button"
                            onClick={() => {
                              const next = { ...settings.hotkeys };
                              delete next[command.id];
                              onChange({ hotkeys: next });
                            }}
                          >
                            reset
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
              </div>
            </>
          ) : null}

          {section === 'about' ? (
            <div className="settings-note">
              <p>
                This vault lives at <code>{vaultRoot}</code>.
              </p>
              <p>
                It is a plain folder of markdown files with an <code>.obsidian/</code> directory
                beside them — open it in Obsidian and everything, including this configuration,
                is where that app expects it.
              </p>
              <p>
                Your agent reads the same folder. A note you write here is a note it can quote in
                a meeting, subject to the <code>visibility</code> property.
              </p>
            </div>
          ) : null}
        </div>
        <button className="modal-close" onClick={onClose} type="button">
          ×
        </button>
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-label">
        <div>{label}</div>
        {hint ? <div className="settings-hint">{hint}</div> : null}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function Switch({ value, onChange }: { value: boolean; onChange(next: boolean): void }) {
  return (
    <button
      className={`switch${value ? ' is-on' : ''}`}
      onClick={() => onChange(!value)}
      type="button"
      role="switch"
      aria-checked={value}
    >
      <span />
    </button>
  );
}

function FolderSelect({
  value,
  folders,
  onChange,
}: {
  value: string;
  folders: string[];
  onChange(next: string): void;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">(vault root)</option>
      {folders.map((folder) => (
        <option key={folder} value={folder}>
          {folder}
        </option>
      ))}
    </select>
  );
}

export function formatHotkey(binding: string): string {
  if (!binding) return '';
  const isMac = navigator.platform.toLowerCase().includes('mac');
  return binding
    .split('+')
    .map((part) => {
      if (part === 'Mod') return isMac ? '⌘' : 'Ctrl';
      if (part === 'Shift') return isMac ? '⇧' : 'Shift';
      if (part === 'Alt') return isMac ? '⌥' : 'Alt';
      if (part === 'ArrowLeft') return '←';
      if (part === 'ArrowRight') return '→';
      return part;
    })
    .join(isMac ? '' : '+');
}
