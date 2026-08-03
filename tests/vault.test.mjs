import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { Vault, Workspace } from '../packages/agent/dist/index.js';
import {
  buildBacklinks,
  buildGraph,
  buildResolver,
  formatDate,
  parseNoteMeta,
  parseYaml,
  resolveLink,
  splitFrontmatter,
  stringifyYaml,
  tagCounts,
  unlinkedMentions,
} from '../packages/shared/dist/index.js';

import { cleanup, makeTempDir } from './helpers.mjs';

async function makeVault(files) {
  const dir = await makeTempDir('ai-coworker-vault-');
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  return { dir, vault: await Vault.open(dir) };
}

test('a note is indexed the way the editor reads it', () => {
  const source = [
    '---',
    'title: Auth migration',
    'tags: [security, backend]',
    'aliases:',
    '  - Auth',
    '  - Login rewrite',
    'visibility: team',
    '---',
    '',
    '# Auth migration',
    '',
    'We depend on [[Session store#Retention|the retention rules]] and #infra/networking.',
    '',
    '- [ ] Rotate refresh tokens',
    '- [x] Ship the flag',
    '',
    '## Risks',
    '',
    'Cache invalidation is the open one. ^risk-1',
    '',
    '![[diagram.png]]',
    '',
    'See [the RFC](https://example.com/rfc) and [notes](Other%20note.md).',
  ].join('\n');

  const meta = parseNoteMeta('Projects/Auth.md', source);

  assert.equal(meta.title, 'Auth migration');
  assert.deepEqual(meta.aliases, ['Auth', 'Login rewrite']);
  assert.ok(meta.tags.includes('security'));
  assert.ok(meta.tags.includes('backend'));
  assert.ok(meta.tags.includes('infra/networking'), 'inline tags are indexed too');

  assert.deepEqual(
    meta.headings.map((h) => [h.level, h.text]),
    [
      [1, 'Auth migration'],
      [2, 'Risks'],
    ],
  );

  const link = meta.links.find((l) => l.target === 'Session store');
  assert.ok(link, 'wikilinks are found');
  assert.equal(link.subpath, '#Retention');
  assert.equal(link.alias, 'the retention rules');

  assert.equal(meta.embeds.length, 1);
  assert.equal(meta.embeds[0].target, 'diagram.png');

  assert.deepEqual(
    meta.tasks.map((t) => [t.checked, t.text]),
    [
      [false, 'Rotate refresh tokens'],
      [true, 'Ship the flag'],
    ],
  );

  assert.ok('risk-1' in meta.blocks, 'block anchors are addressable');
  assert.ok(meta.links.some((l) => l.external === 'https://example.com/rfc'));
  assert.ok(meta.links.some((l) => l.target === 'Other note.md'), 'markdown links are decoded');
});

test('code fences hide their contents from the index', () => {
  const meta = parseNoteMeta('Note.md', ['```md', '[[Not a link]] #not-a-tag', '```', '', '[[Real]]'].join('\n'));
  assert.equal(meta.links.length, 1);
  assert.equal(meta.links[0].target, 'Real');
  assert.deepEqual(meta.tags, []);
});

test('frontmatter survives a round trip', () => {
  const yaml = parseYaml(
    ['title: A note', 'count: 3', 'done: true', 'tags:', '  - one', '  - two', 'nested:', '  key: value'].join('\n'),
  );
  assert.equal(yaml.title, 'A note');
  assert.equal(yaml.count, 3);
  assert.equal(yaml.done, true);
  assert.deepEqual(yaml.tags, ['one', 'two']);
  assert.deepEqual(yaml.nested, { key: 'value' });

  const again = parseYaml(stringifyYaml(yaml));
  assert.deepEqual(again, yaml);

  // A value containing a colon must come back as one string, not two fields.
  const tricky = parseYaml(stringifyYaml({ note: 'time: 10:30', empty: '' }));
  assert.equal(tricky.note, 'time: 10:30');
});

test('links resolve by name, by path, and prefer the same folder', async (t) => {
  const { dir, vault } = await makeVault({
    'Projects/Auth.md': '# Auth\n\n[[Shared]]\n',
    'Projects/Shared.md': '# Shared (projects)\n',
    'Archive/Shared.md': '# Shared (archive)\n',
    'Index.md': '---\naliases: [Home]\n---\n\n[[Projects/Auth]]\n',
  });
  t.after(() => cleanup([dir]));

  const snapshot = vault.snapshot();
  const index = buildResolver(snapshot.meta, snapshot.files);

  assert.equal(resolveLink(index, 'Projects/Auth', ''), 'Projects/Auth.md');
  assert.equal(resolveLink(index, 'Auth', ''), 'Projects/Auth.md');
  assert.equal(resolveLink(index, 'Home', ''), 'Index.md', 'aliases resolve');
  assert.equal(
    resolveLink(index, 'Shared', 'Projects/Auth.md'),
    'Projects/Shared.md',
    'an ambiguous name resolves to the neighbour',
  );
  assert.equal(resolveLink(index, 'Nothing here', ''), undefined);
});

test('renaming a note rewrites every link that pointed at it', async (t) => {
  const { dir, vault } = await makeVault({
    'Auth.md': '# Auth\n',
    'Roadmap.md': 'Blocked on [[Auth]] and [[Auth#Risks|the risks]].\n',
    'Deep/Notes.md': 'Also [[Auth]] plus a [markdown](Auth.md) link.\n',
    'Untouched.md': 'Mentions Auth in prose only.\n',
  });
  t.after(() => cleanup([dir]));

  const result = await vault.rename('Auth.md', 'Authentication.md');
  assert.equal(result.path, 'Authentication.md');
  assert.equal(result.updated.length, 2);

  const roadmap = await fs.readFile(path.join(dir, 'Roadmap.md'), 'utf8');
  assert.match(roadmap, /\[\[Authentication\]\]/);
  assert.match(roadmap, /\[\[Authentication#Risks\|the risks\]\]/, 'subpath and alias are preserved');

  const deep = await fs.readFile(path.join(dir, 'Deep/Notes.md'), 'utf8');
  assert.match(deep, /\[\[Authentication\]\]/);
  assert.match(deep, /\[markdown\]\(Authentication\.md\)/);

  const untouched = await fs.readFile(path.join(dir, 'Untouched.md'), 'utf8');
  assert.equal(untouched, 'Mentions Auth in prose only.\n', 'prose is never rewritten');
});

test('moving a folder keeps its notes and their links', async (t) => {
  const { dir, vault } = await makeVault({
    'Inbox/Idea.md': '# Idea\n',
    'Inbox/Second.md': 'Links to [[Idea]].\n',
  });
  t.after(() => cleanup([dir]));

  await vault.rename('Inbox', 'Archive/Inbox');
  const snapshot = vault.snapshot();
  const paths = snapshot.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['Archive/Inbox/Idea.md', 'Archive/Inbox/Second.md']);

  const index = buildResolver(snapshot.meta, snapshot.files);
  assert.equal(
    resolveLink(index, 'Idea', 'Archive/Inbox/Second.md'),
    'Archive/Inbox/Idea.md',
    'a bare link still resolves after the move',
  );
});

test('search understands the operators people actually type', async (t) => {
  const { dir, vault } = await makeVault({
    'Projects/Auth.md': '---\ntags: [security]\n---\n\n# Auth\n\nRefresh tokens rotate weekly.\n',
    'Projects/Mobile.md': '# Mobile\n\nRefresh the token cache on launch.\n',
    'Personal/Diary.md': '# Diary\n\n- [ ] refresh the plants\n',
  });
  t.after(() => cleanup([dir]));

  assert.deepEqual(
    vault.search('refresh').map((h) => h.path).sort(),
    ['Personal/Diary.md', 'Projects/Auth.md', 'Projects/Mobile.md'],
  );
  assert.deepEqual(
    vault.search('tag:#security').map((h) => h.path),
    ['Projects/Auth.md'],
  );
  assert.deepEqual(
    vault.search('refresh path:Projects').map((h) => h.path).sort(),
    ['Projects/Auth.md', 'Projects/Mobile.md'],
  );
  assert.deepEqual(
    vault.search('"refresh tokens"').map((h) => h.path),
    ['Projects/Auth.md'],
  );
  assert.deepEqual(
    vault.search('refresh -token').map((h) => h.path),
    ['Personal/Diary.md'],
    'a negated term removes files',
  );
  assert.deepEqual(vault.search('task:').map((h) => h.path), ['Personal/Diary.md']);
  assert.deepEqual(
    vault.search('/rotate\\s+weekly/').map((h) => h.path),
    ['Projects/Auth.md'],
    'regular expressions work',
  );
  assert.equal(vault.search('file:mobile')[0].path, 'Projects/Mobile.md');
});

test('backlinks, unlinked mentions, tags and the graph all agree', async (t) => {
  const { dir, vault } = await makeVault({
    'Auth.md': '---\ntags: [security]\n---\n\n# Auth\n',
    'Roadmap.md': '# Roadmap\n\nDepends on [[Auth]].\n',
    'Standup.md': '# Standup\n\nWe talked about Auth today.\n',
  });
  t.after(() => cleanup([dir]));

  const snapshot = vault.snapshot();
  const index = buildResolver(snapshot.meta, snapshot.files);
  const backlinks = buildBacklinks(snapshot.meta, index);

  const inbound = backlinks.get('Auth.md') ?? [];
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].from, 'Roadmap.md');
  assert.match(inbound[0].context, /Depends on/);

  const contents = new Map(
    await Promise.all(snapshot.files.map(async (f) => [f.path, await vault.read(f.path)])),
  );
  const mentions = unlinkedMentions(
    snapshot.meta,
    contents,
    snapshot.meta['Auth.md'],
    new Set(['Roadmap.md']),
  );
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].from, 'Standup.md');

  assert.equal(tagCounts(snapshot.meta).get('security'), 1);

  const graph = buildGraph(snapshot.meta, snapshot.files, index, { showUnresolved: true });
  assert.equal(graph.nodes.length, 3);
  assert.deepEqual(graph.edges, [{ source: 'Roadmap.md', target: 'Auth.md' }]);
});

test('an unresolved link becomes its own node in the graph', async (t) => {
  const { dir, vault } = await makeVault({ 'A.md': 'Points at [[Nowhere]].\n' });
  t.after(() => cleanup([dir]));
  const snapshot = vault.snapshot();
  const index = buildResolver(snapshot.meta, snapshot.files);

  const withGhosts = buildGraph(snapshot.meta, snapshot.files, index, { showUnresolved: true });
  assert.equal(withGhosts.nodes.length, 2);
  assert.ok(withGhosts.nodes.some((n) => n.kind === 'unresolved' && n.label === 'Nowhere'));

  const withoutGhosts = buildGraph(snapshot.meta, snapshot.files, index, { showUnresolved: false });
  assert.equal(withoutGhosts.nodes.length, 1);
  assert.equal(withoutGhosts.edges.length, 0);
});

test('daily notes and templates fill in the date', async (t) => {
  const { dir, vault } = await makeVault({
    'Templates/Daily.md': '# {{title}}\n\nWritten on {{date:YYYY-MM-DD}}.\n\n## Focus\n',
  });
  t.after(() => cleanup([dir]));

  await vault.updateSettings({
    dailyNoteFolder: 'Daily',
    dailyNoteFormat: 'YYYY-MM-DD',
    dailyNoteTemplate: 'Templates/Daily.md',
    templateFolder: 'Templates',
  });

  const today = formatDate('YYYY-MM-DD');
  const created = await vault.dailyNote();
  assert.equal(created, `Daily/${today}.md`);

  const body = await vault.read(created);
  assert.match(body, new RegExp(`# ${today}`));
  assert.match(body, new RegExp(`Written on ${today}`));

  // Asking twice opens the same note rather than making a second one.
  assert.equal(await vault.dailyNote(), created);
  assert.equal(vault.templates().length, 1);
});

test('deleting moves a note to the vault trash, not into the void', async (t) => {
  const { dir, vault } = await makeVault({ 'Gone.md': '# Gone\n' });
  t.after(() => cleanup([dir]));

  await vault.delete('Gone.md');
  assert.equal(vault.exists('Gone.md'), false);
  const trashed = await fs.readFile(path.join(dir, '.trash', 'Gone.md'), 'utf8');
  assert.equal(trashed, '# Gone\n');
});

test('a link cannot reach outside the vault', async (t) => {
  const { dir, vault } = await makeVault({ 'A.md': '# A\n' });
  t.after(() => cleanup([dir]));
  assert.throws(() => vault.abs('../../etc/passwd'), /escapes the vault/);
});

test('settings live in .obsidian so the folder opens in Obsidian itself', async (t) => {
  const { dir, vault } = await makeVault({ 'A.md': '# A\n' });
  t.after(() => cleanup([dir]));

  await vault.updateSettings({ theme: 'light', fontSize: 18 });
  const saved = JSON.parse(await fs.readFile(path.join(dir, '.obsidian', 'app.json'), 'utf8'));
  assert.equal(saved.theme, 'light');
  assert.equal(saved.fontSize, 18);

  const reopened = await Vault.open(dir);
  assert.equal(reopened.settings.theme, 'light');
  assert.equal(reopened.settings.fontSize, 18);
  reopened.close();
});

test('the agent reads hand-written vault notes, folders and all', async (t) => {
  const dir = await makeTempDir('ai-coworker-ws-');
  t.after(() => cleanup([dir]));

  await fs.mkdir(path.join(dir, 'notes', 'Projects'), { recursive: true });
  // No frontmatter, no id — exactly what another editor would leave behind.
  await fs.writeFile(
    path.join(dir, 'notes', 'Projects', 'Rollout.md'),
    '# Rollout plan\n\nStaged behind a flag. #release\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'notes', 'Private thought.md'),
    '---\nvisibility: private\nkind: idea\ncustom: keep me\n---\n\nNot for the meeting.\n',
    'utf8',
  );

  const workspace = await Workspace.open(dir);
  const titles = workspace.notes.map((n) => n.title).sort();
  assert.deepEqual(titles, ['Private thought', 'Rollout plan']);

  const rollout = workspace.notes.find((n) => n.title === 'Rollout plan');
  assert.equal(rollout.path, 'Projects/Rollout.md');
  assert.ok(rollout.tags.includes('release'));

  const priv = workspace.notes.find((n) => n.title === 'Private thought');
  assert.equal(priv.visibility, 'private');
  assert.equal(priv.kind, 'idea');

  // The agent rewriting a note must not eat properties it does not own.
  await workspace.upsertNote({ id: priv.id, title: priv.title, body: 'Revised.', kind: 'idea' });
  await workspace.flush();
  const raw = await fs.readFile(path.join(dir, 'notes', 'Private thought.md'), 'utf8');
  assert.match(raw, /custom: keep me/);
  assert.match(raw, /Revised\./);
  assert.equal(splitFrontmatter(raw).frontmatter.visibility, 'private');

  // Ids stay stable across reloads so nothing loses its identity.
  const reopened = await Workspace.open(dir);
  assert.ok(reopened.notes.some((n) => n.id === priv.id));
});

test('a note the agent writes lands in the vault as a plain markdown file', async (t) => {
  const dir = await makeTempDir('ai-coworker-ws2-');
  t.after(() => cleanup([dir]));

  const workspace = await Workspace.open(dir);
  await workspace.upsertNote({ title: 'Decision: use refresh tokens', body: 'Because sessions leak.' });
  await workspace.flush();

  const files = await fs.readdir(path.join(dir, 'notes'));
  assert.deepEqual(files, ['decision-use-refresh-tokens.md']);

  const vault = await Vault.open(path.join(dir, 'notes'));
  const snapshot = vault.snapshot();
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.meta['decision-use-refresh-tokens.md'].title, 'Decision: use refresh tokens');
  vault.close();
});

test('date formatting covers the tokens daily notes use', () => {
  const date = new Date(2026, 1, 3, 14, 5, 9);
  assert.equal(formatDate('YYYY-MM-DD', date), '2026-02-03');
  assert.equal(formatDate('YYYY-MM-DD HH:mm', date), '2026-02-03 14:05');
  assert.equal(formatDate('dddd', date), 'Tuesday');
  assert.equal(formatDate('MMM D, YYYY', date), 'Feb 3, 2026');
  assert.equal(formatDate('[Week] ww', date), 'Week 06', 'square brackets escape literal text');
});
