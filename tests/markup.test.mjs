import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emojiFor,
  messagePreview,
  parseInline,
  parseMessage,
  resolveMentions,
  scanMentions,
  searchEmoji,
} from '../packages/shared/dist/index.js';

const MEMBERS = [
  { address: 'sarah@northwind', displayName: 'Sarah Chen' },
  { address: 'dana@northwind', displayName: 'Dana Whitfield' },
  { address: 'marcus@northwind', displayName: 'Marcus Rivera' },
];

/** Collect the inline nodes of a given type, at any depth. */
function nodesOfType(nodes, type, out = []) {
  for (const node of nodes) {
    if (node.type === type) out.push(node);
    if ('children' in node) nodesOfType(node.children, type, out);
  }
  return out;
}

test('a mention only fires when it names somebody real', () => {
  const { mentions } = resolveMentions('@sarah can you look at this? email me @ 5', MEMBERS);
  assert.deepEqual(mentions, ['sarah@northwind']);

  // First names, handles and full addresses all resolve to the same person.
  assert.deepEqual(resolveMentions('@Sarah', MEMBERS).mentions, ['sarah@northwind']);
  assert.deepEqual(resolveMentions('@sarah@northwind', MEMBERS).mentions, ['sarah@northwind']);

  // Somebody who is not in the room is not a mention.
  assert.deepEqual(resolveMentions('@nobody hello', MEMBERS).mentions, []);

  // Trailing punctuation belongs to the sentence, not the handle.
  assert.deepEqual(resolveMentions('thanks @marcus.', MEMBERS).mentions, ['marcus@northwind']);
});

test('@channel and @here are broadcasts, not people', () => {
  assert.equal(resolveMentions('@here quick one', MEMBERS).broadcast, 'here');
  assert.equal(resolveMentions('@channel ship it', MEMBERS).broadcast, 'channel');
  assert.equal(resolveMentions('@everyone', MEMBERS).broadcast, 'everyone');
  assert.equal(resolveMentions('nothing special', MEMBERS).broadcast, undefined);
  // A broadcast is not also a personal mention.
  assert.deepEqual(resolveMentions('@here', MEMBERS).mentions, []);
});

test('code is quoted, so an address inside it pings nobody', () => {
  const scan = scanMentions('use `@sarah` as the literal, not @dana');
  assert.deepEqual(scan.handles, ['dana']);

  const fenced = scanMentions('```\nmail("@sarah")\n```\nand @marcus knows');
  assert.deepEqual(fenced.handles, ['marcus']);
});

test('channel links are picked up at word boundaries', () => {
  assert.deepEqual(scanMentions('see #auth-migration and #billing').channels, [
    'auth-migration',
    'billing',
  ]);
  // A fragment in a URL is not a channel.
  assert.deepEqual(scanMentions('https://example.com/page#section').channels, []);
});

test('inline formatting parses the dialect people actually type', () => {
  const nodes = parseInline('**bold** and _italic_ and ~~gone~~ and `code`');
  assert.equal(nodesOfType(nodes, 'bold').length, 1);
  assert.equal(nodesOfType(nodes, 'italic').length, 1);
  assert.equal(nodesOfType(nodes, 'strike').length, 1);
  assert.equal(nodesOfType(nodes, 'code')[0].text, 'code');

  // snake_case survives: underscores inside a word are not emphasis.
  const snake = parseInline('call get_user_by_id now');
  assert.equal(nodesOfType(snake, 'italic').length, 0);

  // A lone asterisk is a lone asterisk.
  assert.equal(nodesOfType(parseInline('2 * 3 = 6'), 'italic').length, 0);

  // ** wins over * so bold does not get eaten by italic.
  const bold = parseInline('**really**');
  assert.equal(bold.length, 1);
  assert.equal(bold[0].type, 'bold');
});

test('links, emoji, mentions and channels become their own nodes', () => {
  const nodes = parseInline('ship https://example.com/pr/412 :tada: cc @sarah in #billing');
  assert.equal(nodesOfType(nodes, 'link')[0].href, 'https://example.com/pr/412');
  assert.equal(nodesOfType(nodes, 'emoji')[0].char, '🎉');
  assert.equal(nodesOfType(nodes, 'mention')[0].handle, 'sarah');
  assert.equal(nodesOfType(nodes, 'channel')[0].name, 'billing');

  const labelled = parseInline('[the PR](https://example.com/pr/412)');
  assert.equal(labelled[0].type, 'link');
  assert.equal(labelled[0].label, 'the PR');

  // www. links get a scheme so they are clickable.
  assert.equal(nodesOfType(parseInline('see www.example.com'), 'link')[0].href, 'https://www.example.com');
});

test('block structure: paragraphs, fences, quotes and lists', () => {
  const blocks = parseMessage(
    [
      'Here is the plan.',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '> we agreed this last week',
      '',
      '- first',
      '- second',
      '',
      '1. one',
      '2. two',
    ].join('\n'),
  );
  const kinds = blocks.map((b) => b.type);
  assert.deepEqual(kinds, ['paragraph', 'code', 'quote', 'list', 'list']);

  const code = blocks[1];
  assert.equal(code.lang, 'ts');
  assert.equal(code.text, 'const x = 1;');
  assert.equal(blocks[3].ordered, false);
  assert.equal(blocks[3].items.length, 2);
  assert.equal(blocks[4].ordered, true);

  // An empty message still renders as something.
  assert.equal(parseMessage('').length, 1);
});

test('previews flatten to one readable line', () => {
  const preview = messagePreview('**Shipping** `today`\n\n```\nnoise\n```\nafter :tada:');
  assert.ok(!preview.includes('**'));
  assert.ok(!preview.includes('```'));
  assert.ok(preview.includes('🎉'));
  assert.ok(!preview.includes('\n'));
  assert.ok(messagePreview('x'.repeat(300), 40).length <= 40);
});

test('emoji lookup and search behave', () => {
  assert.equal(emojiFor('tada'), '🎉');
  assert.equal(emojiFor('TADA'), '🎉');
  assert.equal(emojiFor('not_an_emoji'), null);
  const hits = searchEmoji('rock');
  assert.ok(hits.some((h) => h.code === 'rocket'));
  assert.deepEqual(searchEmoji(''), []);
});
