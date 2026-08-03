/**
 * Mermaid diagrams, loaded on demand.
 *
 * The library is large and most notes never contain a diagram, so it is only
 * imported the first time a ```mermaid block actually appears on screen.
 */

let loader: Promise<typeof import('mermaid')> | null = null;
let configuredTheme: string | null = null;
let sequence = 0;

export async function renderMermaidIn(root: HTMLElement, dark: boolean): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('.md-mermaid:not([data-rendered])')];
  if (blocks.length === 0) return;

  loader ??= import('mermaid');
  const mermaid = (await loader).default;
  const theme = dark ? 'dark' : 'default';
  if (configuredTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      theme,
      securityLevel: 'strict',
      fontFamily: 'inherit',
    });
    configuredTheme = theme;
  }

  for (const block of blocks) {
    block.dataset.rendered = '1';
    const code = block.dataset.code ?? '';
    sequence += 1;
    try {
      const { svg } = await mermaid.render(`mermaid-${sequence}`, code);
      block.innerHTML = svg;
    } catch (err) {
      block.innerHTML = `<pre class="md-mermaid-error">${(err as Error).message}</pre>`;
    }
  }
}

/** Diagrams must re-render when their source changes, not just when new ones appear. */
export function invalidateMermaid(root: HTMLElement): void {
  for (const block of root.querySelectorAll<HTMLElement>('.md-mermaid[data-rendered]')) {
    delete block.dataset.rendered;
  }
}
