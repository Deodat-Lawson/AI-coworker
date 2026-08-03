/** Bundle entry for the markdown tests — the renderer modules under test. */

export { decorateLine, decorateInline } from '../../packages/desktop/src/vault/decorate.js';
export {
  escapeHtml,
  extractSection,
  parseBlocks,
  renderBlock,
  renderBlocks,
  renderInline,
  renderMarkdown,
} from '../../packages/desktop/src/vault/markdown.js';
export { highlight } from '../../packages/desktop/src/vault/highlight.js';
