/**
 * Commands are the single entry point for everything the workspace can do.
 * The palette lists them, hotkeys fire them, menus reuse them — so a feature
 * exists once and is reachable three ways.
 */

export interface Command {
  id: string;
  name: string;
  group?: string;
  /** Default binding, e.g. "Mod+O". Overridable in settings. */
  hotkey?: string;
  /** Hidden from the palette but still bindable (mode toggles, navigation). */
  hidden?: boolean;
  run(): void;
}

/** Normalize a keyboard event into the "Mod+Shift+K" shape bindings use. */
export function eventToBinding(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  const key = event.key;
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(key)) return '';
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}

export function resolveBinding(
  command: Command,
  overrides: Record<string, string> | undefined,
): string | undefined {
  return overrides?.[command.id] ?? command.hotkey;
}
