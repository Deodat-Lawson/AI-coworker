/**
 * The markdown engine lives in the renderer, so it is bundled once with esbuild
 * and then exercised as a plain module. The most important assertion in here is
 * the round-trip one: decoration must never change a single character of the
 * source, because the editor serializes its own DOM back to the file.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-coworker-md-'));
const outFile = path.join(outDir, 'bundle.mjs');

await esbuild.build({
  entryPoints: [path.resolve('tests/fixtures/markdown-entry.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const md = await import(pathToFileURL(outFile).href);

test.after(() => fs.rm(outDir, { recursive: true, force: true }));

const files = new Map([
  ['Auth.md', '# Auth\n\nThe body.\n\n## Risks\n\nToken theft.\n\nA sentence. ^abc\n'],
]);

function context(overrides = {}) {
  return {
    sourcePath: 'Note.md',
    resolve: (target) => (target === 'Auth' || target === 'Auth.md' ? 'Auth.md' : undefined),
    resourceUrl: (p) => `vault://file/${p}`,
    readFile: (p) => files.get(p) ?? null,
    ...overrides,
  };
}

/** The visible text of rendered HTML, with entities put back. */
function textOf(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

test('decoration never changes a character of the source', () => {
  const lines = [
    '# A heading with **bold** and `code`',
    '## Another — with an em dash and "quotes"',
    'Plain text with *emphasis*, __strong__, ~~struck~~ and ==highlight==.',
    'A [[wikilink]], an [[aliased|alias]], a [[note#Heading]] and an ![[embed.png]].',
    'A [markdown](https://example.com/a_(b)) link and a bare https://example.com/x?y=1 URL.',
    '- [ ] a task with a #tag/inside and $x^2 + y$ math',
    '  1. nested ordered item',
    '> [!warning]+ Careful now',
    '> quoted **text**',
    '| a | b |',
    '| --- | --- |',
    'Escaped \\*not emphasis\\* and a lone * star.',
    'Trailing block id at the end ^block-01',
    '```js',
    'const x = 1; // not decorated as prose',
    '```',
    '%% a comment %%',
    '---',
    'snake_case_word stays intact and 5 * 3 * 2 = 30',
    '',
    '\tindented with a tab',
    'Unicode: café, 日本語, 🎉 emoji',
  ];

  for (const line of lines) {
    for (const active of [true, false]) {
      const html = md.decorateLine(line, { active });
      assert.equal(
        textOf(html),
        line,
        `decoration changed the text of ${JSON.stringify(line)} (active=${active})`,
      );
    }
  }
});

test('decorating with a resolver adds link targets but not characters', () => {
  const resolve = (target) => (target === 'Known' ? 'Known.md' : undefined);
  const lines = [
    'a [[Known]] and a [[Missing]] link',
    'an [[Known#Heading|alias]] link',
    'a [text](Known.md) and an [out](https://example.com) link',
    'a bare https://example.com/x link',
  ];
  for (const line of lines) {
    for (const active of [true, false]) {
      const html = md.decorateLine(line, { active, resolve });
      assert.equal(textOf(html), line, `resolver decoration changed ${JSON.stringify(line)}`);
    }
  }

  const withLink = md.decorateLine(lines[0], { active: true, resolve });
  assert.match(withLink, /data-href="Known"/);
  assert.match(withLink, /data-resolved="Known\.md"/);
  assert.match(withLink, /is-unresolved/, 'the missing target is marked');

  const external = md.decorateLine(lines[3], { active: true, resolve });
  assert.match(external, /data-external="https:\/\/example\.com\/x"/);
});

test('inactive lines hide their syntax markers, active lines show them', () => {
  const active = md.decorateLine('some **bold** words', { active: true });
  const inactive = md.decorateLine('some **bold** words', { active: false });
  assert.ok(!active.includes('cm-hidden'), 'the line with the caret keeps its markers visible');
  assert.ok(inactive.includes('cm-hidden'), 'other lines hide them');
  // Both still carry the same characters — only the styling differs.
  assert.equal(textOf(active), textOf(inactive));
});

test('blocks know which source lines they came from', () => {
  const source = ['# Title', '', 'A paragraph.', '', '```js', 'code()', '```', '', '- one', '- two'].join('\n');
  const blocks = md.parseBlocks(source.split('\n'));
  const shape = blocks.map((b) => [b.type, b.from, b.to]);
  assert.deepEqual(shape, [
    ['heading', 0, 1],
    ['blank', 1, 2],
    ['paragraph', 2, 3],
    ['blank', 3, 4],
    ['code', 4, 7],
    ['blank', 7, 8],
    ['list', 8, 10],
  ]);
});

test('lists nest, carry tasks, and hold indented content', () => {
  const source = [
    '- parent',
    '  - child',
    '    - grandchild',
    '- [ ] a task',
    '- [x] a done task',
  ].join('\n');
  const [list] = md.parseBlocks(source.split('\n'));
  assert.equal(list.type, 'list');
  assert.equal(list.items.length, 3);
  assert.equal(list.items[0].children.length, 1);
  assert.equal(list.items[0].children[0].children.length, 1);
  assert.equal(list.items[0].children[0].children[0].content, 'grandchild');
  assert.equal(list.items[1].task, ' ');
  assert.equal(list.items[2].task, 'x');

  const html = md.renderMarkdown(source, context());
  assert.ok(html.includes('type="checkbox"'));
  assert.ok(html.includes('data-task-line="3"'), 'checkboxes know their source line');
  assert.ok(html.includes('checked'));
});

test('rendered output keeps a source position on every run of text', () => {
  const html = md.renderMarkdown('Hello **world** and [[Auth]].', context());
  assert.match(html, /data-l="0"/);
  assert.match(html, /data-o="\d+"/);
  const link = /data-href="Auth"[^>]*data-resolved="Auth\.md"/.exec(html);
  assert.ok(link, 'a resolved wikilink carries the path it points at');
});

test('an unresolved link is marked as such', () => {
  const html = md.renderMarkdown('See [[Nowhere]].', context());
  assert.match(html, /class="md-link is-unresolved"/);
  assert.match(html, /data-resolved=""/);
});

test('tables, callouts and code fences render', () => {
  const table = md.renderMarkdown('| a | b |\n| :-- | --: |\n| 1 | 2 |', context());
  assert.match(table, /<table class="md-table">/);
  assert.match(table, /text-align:left/);
  assert.match(table, /text-align:right/);

  const callout = md.renderMarkdown('> [!warning]- Watch out\n> Body text', context());
  assert.match(callout, /callout-warning/);
  assert.match(callout, /is-collapsed/);
  assert.match(callout, /Watch out/);

  const code = md.renderMarkdown('```ts\nconst x: number = 1;\n```', context());
  assert.match(code, /class="tok-keyword">const/);
  assert.match(code, /md-copy/);

  const mermaid = md.renderMarkdown('```mermaid\ngraph TD\n A-->B\n```', context());
  assert.match(mermaid, /class="md-mermaid"/);
  assert.match(mermaid, /data-code="graph TD/);
});

test('embeds pull in the target note, and cycles stop', () => {
  const html = md.renderMarkdown('![[Auth]]', context());
  assert.match(html, /class="md-embed"/);
  assert.match(html, /The body\./);

  const section = md.renderMarkdown('![[Auth#Risks]]', context());
  assert.match(section, /Token theft\./);
  assert.ok(!section.includes('The body.'), 'only the requested section is pulled in');

  const self = md.renderMarkdown('![[Auth]]', context({ sourcePath: 'Auth.md' }));
  assert.match(self, /is-cyclic/);

  const missing = md.renderMarkdown('![[Nowhere]]', context());
  assert.match(missing, /is-unresolved/);
});

test('sections are extracted by heading and by block anchor', () => {
  const content = files.get('Auth.md');
  assert.match(md.extractSection(content, '#Risks'), /^## Risks/);
  assert.ok(!md.extractSection(content, '#Risks').includes('The body.'));
  assert.equal(md.extractSection(content, '#^abc').trim(), 'A sentence.');
  assert.equal(md.extractSection(content, ''), content);
});

test('images size themselves from the embed alias', () => {
  const html = md.renderMarkdown('![[shot.png|320]]', context({ resolve: () => 'shot.png' }));
  assert.match(html, /width:320px/);
  assert.match(html, /vault:\/\/file\/shot\.png/);
});

test('inline code and math are not re-parsed as markdown', () => {
  const html = md.renderMarkdown('`[[not a link]]` and text', context());
  assert.ok(!html.includes('data-href'), 'a link inside backticks stays literal');
  assert.match(html, /\[\[not a link\]\]/);
});

test('frontmatter renders as a properties block, and body lines shift with it', () => {
  const source = ['---', 'title: X', 'tags: [a]', '---', '', '# X', ''].join('\n');
  const blocks = md.parseBlocks(source.split('\n'));
  assert.equal(blocks[0].type, 'frontmatter');
  assert.equal(blocks[0].to, 4);
  const heading = blocks.find((b) => b.type === 'heading');
  assert.equal(heading.from, 5, 'the heading keeps its real line number');

  const html = md.renderMarkdown(source, context());
  assert.match(html, /md-frontmatter/);
  assert.match(html, /Properties/);
});
