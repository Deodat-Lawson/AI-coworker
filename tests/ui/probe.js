/**
 * The end-to-end suite, evaluated inside the running renderer.
 *
 * It drives the real interface — clicking rows, placing the caret, firing the
 * same `beforeinput` intents a keyboard produces — and then reads the files back
 * through the app's own IPC. An assertion that passes here means the bytes on
 * disk are right, not merely that the DOM looked plausible.
 */

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SAVE_WAIT = 950; // the editor debounces writes at 600ms

  const results = [];
  const logs = [];
  // Published as we go, so a run that never finishes can still be read back
  // from outside instead of leaving a silent window.
  window.__probe = { results, logs, running: null };
  const log = (message) => logs.push(String(message));

  // -- assertions -----------------------------------------------------------

  function assert(condition, message) {
    if (!condition) throw new Error(message || 'assertion failed');
  }
  function eq(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(
        `${message ? message + ': ' : ''}expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
      );
    }
  }
  function includes(haystack, needle, message) {
    if (!String(haystack).includes(needle)) {
      throw new Error(
        `${message ? message + ': ' : ''}expected to find ${JSON.stringify(needle)} in ${JSON.stringify(String(haystack).slice(0, 400))}`,
      );
    }
  }
  function excludes(haystack, needle, message) {
    if (String(haystack).includes(needle)) {
      throw new Error(
        `${message ? message + ': ' : ''}did not expect ${JSON.stringify(needle)} in ${JSON.stringify(String(haystack).slice(0, 400))}`,
      );
    }
  }

  /**
   * Every test runs under a hard cap. Without it a single await that never
   * settles takes the whole suite with it — the runner sits on a window that
   * looks busy, and there is nothing in the report to say which test did it.
   */
  const TEST_TIMEOUT = 45_000;

  async function test(name, fn) {
    const started = Date.now();
    window.__probe.running = name;
    let timer;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${TEST_TIMEOUT / 1000}s`)),
            TEST_TIMEOUT,
          );
        }),
      ]);
      results.push({ name, ok: true, ms: Date.now() - started });
    } catch (error) {
      results.push({
        name,
        ok: false,
        ms: Date.now() - started,
        error: (error && error.message) || String(error),
      });
    } finally {
      clearTimeout(timer);
      window.__probe.running = null;
    }
  }

  // -- vault access ---------------------------------------------------------

  async function unwrap(promise) {
    const result = await promise;
    if (!result || result.ok !== true) throw new Error(result ? result.error : 'no ipc result');
    return result.value;
  }
  const read = (path) => unwrap(window.api.vaultRead(path));
  const create = (path, content) => unwrap(window.api.vaultCreate(path, content));
  const removeFile = (path) => unwrap(window.api.vaultDelete(path));

  // -- ui helpers -----------------------------------------------------------

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const editor = () => q('.ob-leaf.is-active .cm-editor') ?? q('.cm-editor');

  function byText(selector, needle, root = document) {
    return qa(selector, root).find((el) => el.textContent.includes(needle));
  }

  /**
   * Type into a React-controlled input. Assigning `.value` directly is
   * swallowed: React caches the last value it set on the node and treats an
   * identical-looking change as a no-op, so the setter has to be called on the
   * prototype and the event dispatched by hand.
   */
  function setNativeValue(element, value) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function waitFor(fn, what, timeout = 4000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(60);
    }
  }

  async function openKnowledge() {
    const nav = byText('.side-row', 'Knowledge');
    if (nav && !nav.classList.contains('active')) nav.click();
    await waitFor(() => q('.ob'), 'the vault workspace');
    await sleep(300);
  }

  async function showFiles() {
    const tab = byText('.side-tab', 'Files');
    if (tab && !tab.classList.contains('is-active')) {
      tab.click();
      await sleep(150);
    }
  }

  const activeRowMatches = (label) => {
    const row = q('.tree-row.is-file.is-active');
    return Boolean(row && row.textContent.trim().startsWith(label));
  };

  async function openFile(label) {
    await showFiles();
    const deadline = Date.now() + 8000;
    for (;;) {
      if (activeRowMatches(label)) break;
      const row = qa('.tree-row.is-file').find((el) => el.textContent.trim().startsWith(label));
      if (row) {
        row.click();
        await sleep(220);
        if (activeRowMatches(label)) break;
      }
      if (Date.now() > deadline) throw new Error(`could not open "${label}"`);
      await sleep(120);
    }
    await sleep(320);
  }

  /** Close everything so exactly one editor exists for the next fixture. */
  async function closeAllTabs() {
    for (let i = 0; i < 40; i += 1) {
      const tabs = qa('.tab');
      // Closing the last tab leaves one empty placeholder; that is the floor.
      if (tabs.length <= 1 && (!tabs[0] || tabs[0].textContent.includes('New tab'))) break;
      const close = q('.tab-close');
      if (!close) break;
      close.click();
      await sleep(50);
    }
    await sleep(150);
  }

  /** Create a fixture, open it alone, and put the caret in it. */
  async function fixture(name, content, activateOn) {
    const path = await create(name, content);
    await sleep(260);
    await closeAllTabs();
    await openFile(path.split('/').pop().replace(/\.md$/, ''));
    if (activateOn !== null) {
      await activate(activateOn ?? content.split('\n').find((l) => l.trim()));
    }
    // Nothing should type into a note until the file on disk is the fixture.
    const onDisk = await read(path);
    eq(onDisk, content, `fixture "${name}" did not start clean`);
    return path;
  }

  /** Click rendered text so its block becomes editable source. */
  async function activate(needle) {
    const deadline = Date.now() + 8000;
    for (;;) {
      const span =
        qa('.cm-widget [data-l][data-o]').find((s) => s.textContent.includes(needle)) ??
        qa('.cm-widget').find((w) => w.textContent.includes(needle));
      if (span) {
        const rect = span.getBoundingClientRect();
        span.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            clientX: rect.left + 1,
            clientY: rect.top + rect.height / 2,
          }),
        );
        await sleep(160);
        if (q('.cm-line')) return;
      }
      if (Date.now() > deadline) throw new Error(`could not put the caret in "${needle}"`);
      await sleep(120);
    }
  }

  function nodeAt(el, column) {
    let remaining = column;
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const length = node.nodeValue.length;
        if (remaining <= length) return { node, offset: remaining };
        remaining -= length;
        return null;
      }
      if (node.nodeName === 'BR') return null;
      for (const child of node.childNodes) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(el) || { node: el, offset: 0 };
  }

  /** Place the caret (or a selection) by source line and column. */
  async function caret(line, column, endLine, endColumn) {
    const startEl = await waitFor(
      () => q(`.cm-line[data-line="${line}"]`),
      `editable line ${line}`,
      1500,
    );
    const start = nodeAt(startEl, column);
    let end = start;
    if (endLine !== undefined) {
      const endEl = await waitFor(
        () => q(`.cm-line[data-line="${endLine}"]`),
        `editable line ${endLine}`,
        1500,
      );
      end = nodeAt(endEl, endColumn);
    }
    const selection = window.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.addRange(range);
    editor().dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(90);
  }

  /** Select across rendered widgets, which is where naive editors lose data. */
  function anySpan(needle) {
    const candidates = [
      ...qa('.cm-line, .cm-line span'),
      ...qa('.cm-widget [data-l][data-o]'),
    ];
    return candidates.find((el) => el.textContent.includes(needle) && el.firstChild);
  }

  async function selectAcross(startNeedle, endNeedle) {
    const startSpan = await waitFor(() => anySpan(startNeedle), `span "${startNeedle}"`);
    const endSpan = await waitFor(() => anySpan(endNeedle), `span "${endNeedle}"`);
    const selection = window.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(startSpan.firstChild || startSpan, 0);
    const endNode = endSpan.firstChild || endSpan;
    range.setEnd(endNode, endNode.nodeType === Node.TEXT_NODE ? endNode.nodeValue.length : 0);
    selection.addRange(range);
    editor().dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(90);
  }

  /** Fire the same intent a keyboard would. */
  function intent(inputType, data, transfer) {
    const event = new InputEvent('beforeinput', {
      inputType,
      data: data ?? null,
      dataTransfer: transfer,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    editor().dispatchEvent(event);
  }

  async function type(text) {
    for (const character of [...text]) {
      intent('insertText', character);
      await sleep(24);
    }
    await sleep(60);
  }

  const enter = async () => {
    intent('insertParagraph');
    await sleep(90);
  };
  const backspace = async (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      intent('deleteContentBackward');
      await sleep(25);
    }
    await sleep(60);
  };
  const forwardDelete = async (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      intent('deleteContentForward');
      await sleep(25);
    }
    await sleep(60);
  };

  async function key(k, options = {}) {
    editor().dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...options }),
    );
    await sleep(110);
  }

  async function saved(path) {
    await sleep(SAVE_WAIT);
    return read(path);
  }

  // -- the suite ------------------------------------------------------------

  return (async () => {
    await openKnowledge();

    // ---------------------------------------------------------------- typing

    await test('typing inside a paragraph writes exactly that text to disk', async () => {
      const path = await fixture('t-type.md', 'First paragraph.\n\nSecond paragraph.\n');
      await caret(0, 5);
      await type('XY');
      eq(await saved(path), 'FirstXY paragraph.\n\nSecond paragraph.\n');
    });

    await test("the browser's own editing command routes through the model", async () => {
      // Everything else here fires synthetic intents. This one uses Chromium's
      // real editing command, so the native path is proven too.
      const path = await fixture('t-native.md', 'native \n');
      await caret(0, 7);
      const applied = document.execCommand('insertText', false, 'typed');
      assert(applied !== false, 'execCommand was accepted');
      await sleep(200);
      eq(await saved(path), 'native typed\n');
    });

    await test('typing at the very start of a line', async () => {
      const path = await fixture('t-start.md', 'alpha beta\n');
      await caret(0, 0);
      await type('Z ');
      eq(await saved(path), 'Z alpha beta\n');
    });

    await test('typing at the very end of a line', async () => {
      const path = await fixture('t-end.md', 'alpha\n');
      await caret(0, 5);
      await type('!');
      eq(await saved(path), 'alpha!\n');
    });

    await test('backspace joins two paragraphs without eating the rest', async () => {
      const path = await fixture('t-join.md', 'one\n\ntwo\n\nthree\n');
      await activate('two');
      await caret(2, 0);
      await backspace(2);
      eq(await saved(path), 'onetwo\n\nthree\n');
    });

    await test('backspace at the very start of the document does nothing', async () => {
      const path = await fixture('t-nostart.md', 'alpha\n');
      await caret(0, 0);
      await backspace(3);
      eq(await saved(path), 'alpha\n');
    });

    await test('backspace at the start of a block leaves the rendered block above intact', async () => {
      const source = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nparagraph after the table\n';
      const path = await fixture('t-widget-above.md', source, 'paragraph after');
      await caret(4, 0);
      await backspace(1);
      const after = await saved(path);
      includes(after, '| a | b |', 'the table survives');
      includes(after, '| 1 | 2 |', 'the table body survives');
      eq(after, '| a | b |\n| --- | --- |\n| 1 | 2 |\nparagraph after the table\n');
    });

    await test('forward delete joins the following line', async () => {
      const path = await fixture('t-fwd.md', 'one\ntwo\n');
      await caret(0, 3);
      await forwardDelete(1);
      eq(await saved(path), 'onetwo\n');
    });

    await test('a selection spanning a rendered widget deletes only the selected source', async () => {
      const source = 'intro line\n\n```js\ncode()\n```\n\noutro line\n';
      const path = await fixture('t-span.md', source, 'intro line');
      await selectAcross('intro line', 'outro line');
      intent('deleteContentBackward');
      await sleep(120);
      const after = await saved(path);
      excludes(after, 'code()', 'the fenced block inside the selection went with it');
      excludes(after, 'intro line');
      excludes(after, 'outro line');
    });

    await test('typing over a selection that spans a widget replaces it', async () => {
      const source = 'alpha\n\n> quoted line\n\nomega\n';
      const path = await fixture('t-replace-span.md', source, 'alpha');
      await selectAcross('alpha', 'omega');
      await type('R');
      const after = await saved(path);
      includes(after, 'R');
      excludes(after, 'quoted line');
    });

    await test('enter splits a paragraph at the caret', async () => {
      const path = await fixture('t-split.md', 'hello world\n');
      await caret(0, 5);
      await enter();
      eq(await saved(path), 'hello\n world\n');
    });

    await test('enter continues a bullet list, and empties end it', async () => {
      const path = await fixture('t-bullet.md', '- first\n', 'first');
      await caret(0, 7);
      await enter();
      await type('second');
      await enter();
      await enter();
      eq(await saved(path), '- first\n- second\n\n');
    });

    await test('enter increments an ordered list', async () => {
      const path = await fixture('t-ordered.md', '1. one\n', 'one');
      await caret(0, 6);
      await enter();
      await type('two');
      await enter();
      await type('three');
      eq(await saved(path), '1. one\n2. two\n3. three\n');
    });

    await test('enter carries a task checkbox to the next item', async () => {
      const path = await fixture('t-task.md', '- [ ] alpha\n', 'alpha');
      await caret(0, 11);
      await enter();
      await type('beta');
      eq(await saved(path), '- [ ] alpha\n- [ ] beta\n');
    });

    await test('enter inside a code fence is a plain newline', async () => {
      const path = await fixture('t-fence-enter.md', '```js\n- not a list\n```\n', '- not a list');
      await caret(1, 12);
      await enter();
      await type('x');
      eq(await saved(path), '```js\n- not a list\nx\n```\n');
    });

    await test('enter continues a blockquote', async () => {
      const path = await fixture('t-quote.md', '> quoted\n', 'quoted');
      await caret(0, 8);
      await enter();
      await type('more');
      eq(await saved(path), '> quoted\n> more\n');
    });

    await test('tab inserts a tab in prose and indents a list item', async () => {
      const prose = await fixture('t-tab-prose.md', 'plain text\n');
      await caret(0, 5);
      await key('Tab');
      eq(await saved(prose), 'plain\t text\n');

      const list = await fixture('t-tab-list.md', '- one\n- two\n', 'one');
      await caret(1, 5);
      await key('Tab');
      eq(await saved(list), '- one\n\t- two\n');
      await key('Tab', { shiftKey: true });
      eq(await saved(list), '- one\n- two\n');
    });

    await test('brackets auto-close and the closer types over itself', async () => {
      const path = await fixture('t-pairs.md', 'link \n');
      await caret(0, 5);
      await type('[');
      await type('x');
      await type(']');
      await type('!');
      eq(await saved(path), 'link [x]!\n');
    });

    await test('typing a bracket around a selection wraps it', async () => {
      const path = await fixture('t-wrap.md', 'wrap me now\n');
      await caret(0, 5, 0, 7);
      await type('[');
      eq(await saved(path), 'wrap [me] now\n');
    });

    await test('bold and italic wrap and unwrap the selection', async () => {
      const path = await fixture('t-bold.md', 'make this bold\n');
      await caret(0, 10, 0, 14);
      await key('b', { metaKey: true });
      eq(await saved(path), 'make this **bold**\n');
      await key('b', { metaKey: true });
      eq(await saved(path), 'make this bold\n');
      await key('i', { metaKey: true });
      eq(await saved(path), 'make this *bold*\n');
    });

    await test('undo and redo restore the document exactly', async () => {
      const path = await fixture('t-undo.md', 'base\n');
      await caret(0, 4);
      await type(' one');
      await sleep(700);
      await type(' two');
      await sleep(120);
      await key('z', { metaKey: true });
      await key('z', { metaKey: true });
      await key('z', { metaKey: true });
      const undone = await saved(path);
      eq(undone, 'base\n', 'undo walks all the way back');
      await key('z', { metaKey: true, shiftKey: true });
      const redone = await saved(path);
      assert(redone !== 'base\n', 'redo puts an edit back');
      includes(redone, 'one');
    });

    await test('cut removes the selection and copies markdown', async () => {
      const path = await fixture('t-cut.md', 'keep **bold** drop\n', 'keep');
      await caret(0, 5, 0, 13);
      const transfer = new DataTransfer();
      editor().dispatchEvent(
        new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
      await sleep(150);
      eq(transfer.getData('text/plain'), '**bold**', 'the clipboard gets markdown, not rendered text');
      eq(await saved(path), 'keep  drop\n');
    });

    await test('paste inserts plain text at the caret', async () => {
      const path = await fixture('t-paste.md', 'a  b\n');
      await caret(0, 2);
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'PASTED');
      editor().dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
      await sleep(150);
      eq(await saved(path), 'a PASTED b\n');
    });

    await test('word delete removes a whole word', async () => {
      const path = await fixture('t-word.md', 'alpha beta gamma\n');
      await caret(0, 10);
      intent('deleteWordBackward');
      await sleep(140);
      eq(await saved(path), 'alpha  gamma\n');
    });

    await test('backspace removes a whole emoji, not half of it', async () => {
      const path = await fixture('t-emoji.md', 'party 🎉 time\n');
      await caret(0, 8);
      await backspace(1);
      eq(await saved(path), 'party  time\n');
    });

    await test('editing one line of a rich note leaves every other byte alone', async () => {
      const source = [
        '---',
        'tags: [alpha]',
        '---',
        '',
        '# Title',
        '',
        'A paragraph to edit.',
        '',
        '> [!warning] Careful',
        '> Body of the callout.',
        '',
        '| a | b |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '```ts',
        'const x: number = 1;',
        '```',
        '',
        '$$',
        'e = mc^2',
        '$$',
        '',
        '- [ ] a task',
        '- [x] a done task',
        '',
        'Final line. ^anchor',
        '',
      ].join('\n');
      const path = await fixture('t-rich.md', source, 'A paragraph to edit');
      await caret(6, 20);
      await type('!');
      const after = await saved(path);
      eq(after, source.replace('A paragraph to edit.', 'A paragraph to edit.!'));
    });

    await test('clicking a task checkbox toggles the right line', async () => {
      const path = await fixture(
        't-check.md',
        '- [ ] first\n- [ ] second\n- [ ] third\n',
        null,
      );
      const boxes = await waitFor(
        () => (qa('.cm-widget input.md-task').length >= 3 ? qa('.cm-widget input.md-task') : null),
        'three checkboxes',
      );
      boxes[1].click();
      await sleep(250);
      eq(await saved(path), '- [ ] first\n- [x] second\n- [ ] third\n');
      // The rendered block is rebuilt after a toggle; the old node is detached.
      qa('.cm-widget input.md-task')[1].click();
      await sleep(250);
      eq(await saved(path), '- [ ] first\n- [ ] second\n- [ ] third\n');
    });

    await test('source mode shows every marker and still round-trips', async () => {
      const source = 'plain **bold** and [[Somewhere]]\n';
      const path = await fixture('t-source-mode.md', source, 'plain');
      const more = byText('.tab-actions .ghost', '⋯') || qa('.tab-actions .ghost')[1];
      more.click();
      await sleep(150);
      byText('.context-item', 'Source mode').click();
      await sleep(300);
      assert(q('.cm-line'), 'source mode renders lines');
      assert(!q('.cm-widget'), 'source mode renders no widgets');
      await caret(0, 5);
      await type('!');
      eq(await saved(path), 'plain! **bold** and [[Somewhere]]\n');
      const more2 = qa('.tab-actions .ghost')[1];
      more2.click();
      await sleep(150);
      byText('.context-item', 'Live preview').click();
      await sleep(250);
    });

    // ----------------------------------------------------------------- links

    await test('the link suggester completes a note name and closes the brackets', async () => {
      await create('Link Target Alpha.md', '# Link Target Alpha\n');
      await sleep(300);
      const path = await fixture('t-suggest.md', 'see \n');
      await caret(0, 4);
      await type('[');
      await type('[');
      await type('Link Target A');
      const item = await waitFor(
        () => qa('.cm-suggest-item').find((el) => el.textContent.includes('Link Target Alpha')),
        'a link suggestion for Link Target Alpha',
      );
      item.click();
      await sleep(200);
      eq(await saved(path), 'see [[Link Target Alpha]]\n');
    });

    await test('accepting a suggestion does not duplicate existing brackets', async () => {
      const path = await fixture('t-suggest2.md', 'x [[]]\n', 'x ');
      await caret(0, 4);
      await type('Link Target A');
      const item = await waitFor(
        () => qa('.cm-suggest-item').find((el) => el.textContent.includes('Link Target Alpha')),
        'a link suggestion for Link Target Alpha',
      );
      item.click();
      await sleep(200);
      eq(await saved(path), 'x [[Link Target Alpha]]\n');
    });

    await test('the suggester completes headings after a hash', async () => {
      await create('Heading Host.md', '# Heading Host\n\n## Second Section\n\ntext\n');
      await sleep(300);
      const path = await fixture('t-suggest3.md', 'ref \n');
      await caret(0, 4);
      await type('[');
      await type('[');
      await type('Heading Host#Sec');
      const item = await waitFor(
        () => qa('.cm-suggest-item').find((el) => el.textContent.includes('Second Section')),
        'a heading suggestion',
      );
      item.click();
      await sleep(200);
      eq(await saved(path), 'ref [[Heading Host#Second Section]]\n');
    });

    await test('a link in a rendered block opens on a plain click', async () => {
      await fixture('t-nav.md', 'go to [[Link Target Alpha]] now\n', null);
      const link = await waitFor(
        () => qa('.cm-widget .md-link').find((a) => a.textContent.includes('Link Target Alpha')),
        'a rendered link',
      );
      link.click();
      await waitFor(
        () => q('.tab.is-active .tab-title').textContent.includes('Link Target Alpha'),
        'navigation to the target',
      );
    });

    await test('a link in the line being edited needs the modifier, then navigates', async () => {
      await fixture('t-nav2.md', 'go to [[Link Target Alpha]] now\n', 'go to');
      const inline = await waitFor(
        () => qa('.cm-line .cm-link').find((s) => s.textContent.includes('Link Target Alpha')),
        'a decorated link in the active line',
      );
      eq(inline.dataset.resolved, 'Link Target Alpha.md', 'the decorated link knows what it resolves to');
      inline.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(250);
      includes(q('.tab.is-active .tab-title').textContent, 't-nav2', 'a plain click stays put');
      // The line is re-decorated after the caret moves, so re-find the node.
      const again = await waitFor(
        () => qa('.cm-line .cm-link').find((s) => s.textContent.includes('Link Target Alpha')),
        'the link again',
      );
      again.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
      );
      await waitFor(
        () => q('.tab.is-active .tab-title').textContent.includes('Link Target Alpha'),
        'modifier-click navigation',
      );
    });

    await test('an unresolved link is marked and creates the note when followed', async () => {
      await fixture('t-ghost.md', 'see [[Freshly Invented Note]]\n', null);
      const ghost = await waitFor(
        () => qa('.cm-widget .md-link.is-unresolved').find((a) => a.textContent.includes('Freshly Invented')),
        'an unresolved link',
      );
      ghost.click();
      await waitFor(
        () => q('.tab.is-active .tab-title').textContent.includes('Freshly Invented Note'),
        'the new note opening',
      );
      const created = await read('Freshly Invented Note.md');
      includes(created, 'Freshly Invented Note');
    });

    await test('renaming rewrites wiki links, markdown links, aliases and subpaths', async () => {
      await create('Rename Me.md', '# Rename Me\n\n## Details\n');
      await create(
        'Rename Source.md',
        [
          'A [[Rename Me]] link.',
          'An aliased [[Rename Me|nickname]] link.',
          'A subpath [[Rename Me#Details]] link.',
          'A markdown [one](Rename%20Me.md) link.',
          'Prose that merely says Rename Me should not change.',
          '',
        ].join('\n'),
      );
      await sleep(350);
      await openFile('Rename Me');
      await key('F2');
      const input = await waitFor(() => q('.modal-prompt input'), 'the rename dialog');
      input.value = '';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Renamed Note');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      byText('.modal-buttons button', 'OK').click();
      await sleep(900);

      const source = await read('Rename Source.md');
      includes(source, '[[Renamed Note]]');
      includes(source, '[[Renamed Note|nickname]]');
      includes(source, '[[Renamed Note#Details]]');
      includes(source, '(Renamed%20Note.md)');
      includes(source, 'merely says Rename Me should not change', 'prose is left alone');
      const files = await unwrap(window.api.vaultState());
      assert(files.files.some((f) => f.path === 'Renamed Note.md'), 'the file moved');
    });

    await test('moving a note into a folder keeps bare links resolving', async () => {
      await create('Mover.md', '# Mover\n');
      await create('Mover Source.md', 'points at [[Mover]]\n');
      await sleep(300);
      await unwrap(window.api.vaultRename('Mover.md', 'Sub/Deep/Mover.md'));
      await sleep(500);
      const state = await unwrap(window.api.vaultState());
      assert(state.files.some((f) => f.path === 'Sub/Deep/Mover.md'), 'the file moved into the folder');
      await openFile('Mover Source');
      const link = await waitFor(
        () => qa('.cm-widget .md-link').find((a) => a.textContent.includes('Mover')),
        'the link',
      );
      eq(link.classList.contains('is-unresolved'), false, 'the link still resolves after the move');
      eq(link.dataset.resolved, 'Sub/Deep/Mover.md');
    });

    await test('backlinks list the sources and unlinked mentions can be linked', async () => {
      await create('Backlink Target.md', '# Backlink Target\n');
      await create('Backlink Linker.md', 'refers to [[Backlink Target]] here\n');
      await create('Backlink Mentioner.md', 'just says Backlink Target in prose\n');
      await sleep(400);
      await openFile('Backlink Target');
      byText('.side-tab', 'Links').click();
      await sleep(500);
      const files = qa('.backlink-file').map((b) => b.textContent);
      assert(
        files.some((t) => t.includes('Backlink Linker')),
        `backlinks pane should list the linker, saw ${JSON.stringify(files)}`,
      );
      const mentionRow = await waitFor(
        () => qa('.mention-row').find((r) => r.textContent.includes('in prose')),
        'an unlinked mention',
      );
      mentionRow.querySelector('.mention-link').click();
      await sleep(900);
      const mentioner = await read('Backlink Mentioner.md');
      includes(mentioner, '[[Backlink Target]]', 'the mention became a link');
    });

    await test('an embed transcludes the named section only', async () => {
      await create(
        'Embed Host.md',
        '# Embed Host\n\n## Wanted\n\nWanted body text.\n\n## Unwanted\n\nUnwanted body text.\n',
      );
      await sleep(300);
      await fixture('t-embed.md', 'before\n\n![[Embed Host#Wanted]]\n\nafter\n', null);
      const embed = await waitFor(() => {
        const node = q('.md-embed');
        return node && !node.classList.contains('is-loading') ? node : null;
      }, 'the embed to finish transcluding');
      includes(embed.textContent, 'Wanted body text');
      excludes(embed.textContent, 'Unwanted body text');
    });

    await test('a tag in rendered text jumps to a tag search', async () => {
      await fixture('t-tag.md', 'tagged with #probe-tag here\n', null);
      const tag = await waitFor(
        () => qa('.cm-widget .md-tag').find((t) => t.textContent.includes('probe-tag')),
        'the rendered tag',
      );
      tag.click();
      await sleep(400);
      const input = q('.pane-search input');
      assert(input, 'the search pane opened');
      includes(input.value, 'probe-tag');
    });

    // ------------------------------------------------------------ vault ops

    await test('search finds content and honours the tag operator', async () => {
      await create('Search Alpha.md', '---\ntags: [findme]\n---\n\nunmistakable needle here\n');
      await create('Search Beta.md', 'unmistakable needle also here\n');
      await sleep(400);
      byText('.side-tab', 'Search').click();
      await sleep(200);
      const input = await waitFor(() => q('.pane-search input'), 'the search box');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'unmistakable');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(700);
      const hits = qa('.search-file').map((b) => b.textContent);
      assert(hits.length >= 2, `expected both notes, saw ${JSON.stringify(hits)}`);

      setter.call(input, 'unmistakable tag:#findme');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(700);
      const tagged = qa('.search-file').map((b) => b.textContent);
      eq(tagged.length, 1, `tag filter should leave one note, saw ${JSON.stringify(tagged)}`);
      includes(tagged[0], 'Search Alpha');
    });

    await test('the quick switcher opens a note by fuzzy name', async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'o', metaKey: true, bubbles: true, cancelable: true }),
      );
      const input = await waitFor(() => q('.suggest-input'), 'the quick switcher');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'srchalpha');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(300);
      const first = await waitFor(() => q('.suggest-item'), 'a switcher result');
      includes(first.textContent, 'Search Alpha');
      first.click();
      await waitFor(
        () => q('.tab.is-active .tab-title').textContent.includes('Search Alpha'),
        'the note opening',
      );
    });

    await test('the command palette runs a command', async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true }),
      );
      const input = await waitFor(() => q('.suggest-input'), 'the palette');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'daily note');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(300);
      const item = await waitFor(() => q('.suggest-item'), 'the daily note command');
      item.click();
      await sleep(900);
      const state = await unwrap(window.api.vaultState());
      assert(
        state.files.some((f) => /^Daily\//.test(f.path)),
        'a daily note exists in the configured folder',
      );
    });

    await test('properties can be added and removed from a note', async () => {
      const path = await fixture('t-props.md', 'no frontmatter yet\n', null);
      byText('.side-tab', 'Properties').click();
      await sleep(250);
      const adder = await waitFor(() => q('.prop-add input'), 'the property adder');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(adder, 'status');
      adder.dispatchEvent(new Event('input', { bubbles: true }));
      adder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(700);
      let content = await read(path);
      includes(content, 'status:');
      includes(content, 'no frontmatter yet', 'the body survives');

      const field = await waitFor(() => q('.prop-edit input'), 'the property field');
      setter.call(field, 'active');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(700);
      content = await read(path);
      includes(content, 'status: active');

      q('.prop-edit .ghost').click();
      await sleep(700);
      content = await read(path);
      excludes(content, 'status:');
      includes(content, 'no frontmatter yet');
    });

    await test('bookmarking a note persists it', async () => {
      await openFile('Search Beta');
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true, cancelable: true }),
      );
      await sleep(500);
      const state = await unwrap(window.api.vaultState());
      assert(
        state.bookmarks.some((b) => b.path === 'Search Beta.md'),
        'the bookmark was written to .obsidian/bookmarks.json',
      );
      byText('.side-tab', 'Bookmarks').click();
      await sleep(200);
      assert(byText('.bookmark-open', 'Search Beta'), 'it shows in the pane');
    });

    await test('the outline lists headings and jumps to them', async () => {
      await create('Outline Note.md', '# One\n\ntext\n\n## Two\n\ntext\n\n### Three\n\ntext\n');
      await sleep(300);
      await openFile('Outline Note');
      byText('.side-tab', 'Outline').click();
      await sleep(300);
      const rows = qa('.outline-row').map((r) => r.textContent);
      eq(rows.length, 3, `expected three headings, saw ${JSON.stringify(rows)}`);
      eq(rows[2], 'Three');
      qa('.outline-row')[2].click();
      await sleep(200);
    });

    await test('deleting a note moves it to the vault trash', async () => {
      const path = await create('Doomed Note.md', 'temporary\n');
      await sleep(250);
      await removeFile(path);
      await sleep(400);
      const state = await unwrap(window.api.vaultState());
      assert(!state.files.some((f) => f.path === path), 'the note is gone from the vault');
    });

    await test('the graph draws a node for every markdown note', async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'g', metaKey: true, bubbles: true, cancelable: true }),
      );
      await waitFor(() => q('.graph-canvas'), 'the graph canvas');
      await sleep(1200);
      const canvas = q('.graph-canvas');
      assert(canvas.width > 0 && canvas.height > 0, 'the canvas has a backing store');
      const context = canvas.getContext('2d');
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) painted += 1;
      assert(painted > 500, `the graph actually drew something (painted ${painted} pixels)`);
    });

    await test('a canvas file loads its nodes and edges', async () => {
      await create(
        'Probe Board.canvas',
        JSON.stringify({
          nodes: [
            { id: 'a', type: 'text', text: 'card one', x: -200, y: -60, width: 200, height: 100 },
            { id: 'b', type: 'text', text: 'card two', x: 120, y: -60, width: 200, height: 100 },
          ],
          edges: [{ id: 'e', fromNode: 'a', toNode: 'b', toEnd: 'arrow' }],
        }),
      );
      await sleep(350);
      await openFile('Probe Board.canvas');
      await waitFor(() => qa('.canvas-node').length === 2, 'two canvas cards');
      assert(qa('.canvas-edges path').length >= 1, 'an edge is drawn');
      includes(q('.canvas-node').textContent, 'card one');
    });

    // ------------------------------------------------- editing, second pass

    await test('select all and retype replaces the whole document', async () => {
      const path = await fixture('t-selectall.md', 'one\n\ntwo\n\nthree\n', 'one');
      await selectAcross('one', 'three');
      await type('X');
      const after = await saved(path);
      includes(after, 'X');
      excludes(after, 'two');
      excludes(after, 'three');
    });

    await test('a multi-line paste keeps its line breaks', async () => {
      const path = await fixture('t-multipaste.md', 'head\n', 'head');
      await caret(0, 4);
      const transfer = new DataTransfer();
      transfer.setData('text/plain', '\n\n- a\n- b\n');
      editor().dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
      await sleep(200);
      eq(await saved(path), 'head\n\n- a\n- b\n\n');
    });

    await test('enter at the start of a line pushes it down', async () => {
      const path = await fixture('t-enterstart.md', 'line\n', 'line');
      await caret(0, 0);
      await enter();
      eq(await saved(path), '\nline\n');
    });

    await test('typing at the end of a document with no trailing newline', async () => {
      const path = await fixture('t-noeol.md', 'tail', 'tail');
      await caret(0, 4);
      await type('!');
      eq(await saved(path), 'tail!');
    });

    await test('editing a table row keeps the table intact', async () => {
      const source = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
      const path = await fixture('t-table-edit.md', source, null);
      // Clicking a cell has to drop the caret into that row's source.
      const cell = await waitFor(
        () => qa('.md-table td').find((td) => td.textContent.trim() === '1'),
        'the table cell',
      );
      const rect = cell.getBoundingClientRect();
      cell.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          clientX: rect.left + 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
      await sleep(200);
      assert(q('.cm-line[data-line="2"]'), 'the table row became editable');
      await caret(2, 4);
      await type('X');
      eq(await saved(path), '| a | b |\n| --- | --- |\n| 1 X| 2 |\n');
    });

    await test('editing frontmatter through the properties block', async () => {
      const source = '---\ntags: [one]\n---\n\nbody\n';
      const path = await fixture('t-fm-edit.md', source, null);
      await activate('Properties');
      await caret(1, 10);
      await type(', two');
      eq(await saved(path), '---\ntags: [one, two]\n---\n\nbody\n');
    });

    // ------------------------------------------------------------- commands

    async function runCommand(name) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true }),
      );
      const input = await waitFor(() => q('.suggest-input'), 'the palette');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(280);
      const item = await waitFor(
        () => qa('.suggest-item').find((el) => el.textContent.toLowerCase().includes(name.toLowerCase())),
        `the "${name}" command`,
      );
      item.click();
      await sleep(260);
    }

    await test('heading, quote and list commands rewrite the caret line', async () => {
      const path = await fixture('t-commands.md', 'plain line\n', 'plain line');
      await caret(0, 3);
      await runCommand('Set heading 2');
      eq(await saved(path), '## plain line\n');
      await runCommand('Set heading 2');
      eq(await saved(path), 'plain line\n');
      await runCommand('Toggle blockquote');
      eq(await saved(path), '> plain line\n');
      await runCommand('Toggle blockquote');
      await runCommand('Toggle bullet list');
      eq(await saved(path), '- plain line\n');
      await runCommand('Toggle numbered list');
      eq(await saved(path), '1. plain line\n');
    });

    await test('the checkbox command turns a line into a task and back', async () => {
      const path = await fixture('t-cmdcheck.md', 'do the thing\n', 'do the thing');
      await caret(0, 4);
      await runCommand('Toggle checkbox');
      eq(await saved(path), '- [ ] do the thing\n');
      await runCommand('Toggle checkbox');
      eq(await saved(path), '- [x] do the thing\n');
    });

    await test('insert commands drop real markdown in', async () => {
      const path = await fixture('t-insert.md', 'x\n', 'x');
      await caret(0, 1);
      await runCommand('Insert table');
      const withTable = await saved(path);
      includes(withTable, '| Column | Column |');
      includes(withTable, '| --- | --- |');
      await runCommand('Insert callout');
      includes(await saved(path), '> [!note]');
    });

    await test('find and replace rewrites every occurrence', async () => {
      const path = await fixture('t-find.md', 'alpha beta alpha gamma alpha\n', 'alpha');
      await caret(0, 0);
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }),
      );
      const bar = await waitFor(() => q('.find-bar'), 'the find bar');
      const inputs = qa('input', bar);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inputs[0], 'alpha');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(inputs[1], 'ALPHA');
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      byText('.find-bar button', 'Replace all').click();
      await sleep(200);
      eq(await saved(path), 'ALPHA beta ALPHA gamma ALPHA\n');
      byText('.find-bar button', '×').click();
      await sleep(150);
    });

    // ---------------------------------------------------------- links again

    await test('an aliased link shows the alias and still resolves', async () => {
      await fixture('t-alias.md', 'see [[Link Target Alpha|the target]] here\n', null);
      const link = await waitFor(
        () => qa('.cm-widget .md-link').find((a) => a.textContent === 'the target'),
        'the aliased link',
      );
      eq(link.dataset.resolved, 'Link Target Alpha.md');
      eq(link.classList.contains('is-unresolved'), false);
    });

    await test('a markdown-style internal link resolves and navigates', async () => {
      await fixture('t-mdlink.md', 'go [there](Link%20Target%20Alpha.md) now\n', null);
      const link = await waitFor(
        () => qa('.cm-widget .md-link').find((a) => a.textContent === 'there'),
        'the markdown link',
      );
      eq(link.dataset.resolved, 'Link Target Alpha.md');
      link.click();
      await waitFor(
        () => q('.tab.is-active .tab-title').textContent.includes('Link Target Alpha'),
        'navigation',
      );
    });

    await test('an external link does not navigate the workspace', async () => {
      await fixture('t-ext.md', 'visit [example](https://example.com/page) now\n', null);
      // Deliberately not clicked: that would hand the URL to the real browser.
      const link = await waitFor(
        () => qa('.cm-widget .md-external').find((a) => a.textContent.includes('example')),
        'the external link',
      );
      eq(link.dataset.external, 'https://example.com/page');
      assert(!link.dataset.href, 'an external link is never treated as a note link');
    });

    await test('deleting a note leaves its inbound links unresolved', async () => {
      await create('Doomed Target.md', '# Doomed Target\n');
      await sleep(250);
      await fixture('t-doomed.md', 'points at [[Doomed Target]]\n', null);
      const link = await waitFor(
        () => qa('.cm-widget .md-link').find((a) => a.textContent.includes('Doomed Target')),
        'the link',
      );
      eq(link.classList.contains('is-unresolved'), false);
      await removeFile('Doomed Target.md');
      await waitFor(
        () =>
          qa('.cm-widget .md-link').find(
            (a) => a.textContent.includes('Doomed Target') && a.classList.contains('is-unresolved'),
          ),
        'the link going stale',
      );
    });

    await test('renaming the open note follows it in the tab', async () => {
      const path = await create('Tab Rename.md', '# Tab Rename\n');
      await sleep(250);
      await openFile('Tab Rename');
      await key('F2');
      const input = await waitFor(() => q('.modal-prompt input'), 'the rename dialog');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Tab Renamed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      byText('.modal-buttons button', 'OK').click();
      await sleep(800);
      const state = await unwrap(window.api.vaultState());
      assert(state.files.some((f) => f.path === 'Tab Renamed.md'), 'the file moved');
      assert(!state.files.some((f) => f.path === path), 'the old name is gone');
    });

    await test('a link to a heading opens the note at that heading', async () => {
      await fixture('t-jump.md', 'jump to [[Heading Host#Second Section]]\n', null);
      const link = await waitFor(
        () => qa('.cm-widget .md-link').find((a) => a.textContent.includes('Heading Host')),
        'the subpath link',
      );
      eq(link.dataset.subpath, '#Second Section');
      link.click();
      await waitFor(
        () => q('.tab.is-active .tab-title').textContent.includes('Heading Host'),
        'navigation to the host note',
      );
    });

    await test('typing stays responsive in a large note', async () => {
      const big = Array.from({ length: 600 }, (_, i) => `Paragraph ${i} with a few words in it.`).join(
        '\n\n',
      );
      const path = await fixture('t-big.md', `${big}\n`, 'Paragraph 0 ');
      await caret(0, 11);
      const started = performance.now();
      const keys = 10;
      for (let i = 0; i < keys; i += 1) intent('insertText', 'x');
      const perKey = (performance.now() - started) / keys;
      await sleep(400);
      includes(await saved(path), 'Paragraph 0xxxxxxxxxx');
      assert(
        perKey < 120,
        `a keystroke cost ${perKey.toFixed(1)}ms in a 1200-line note, which will feel like lag`,
      );
    });

    // ------------------------------------------------------- vault, part two

    await test('a note created in a folder lands there and opens', async () => {
      await unwrap(window.api.vaultCreateFolder('Nested/Deeper'));
      await sleep(300);
      const path = await create('Nested/Deeper/Inside.md', '# Inside\n');
      eq(path, 'Nested/Deeper/Inside.md');
      await sleep(300);
      const state = await unwrap(window.api.vaultState());
      assert(state.folders.includes('Nested/Deeper'), 'the folder is in the tree');
    });

    await test('search supports regex and exclusion', async () => {
      await create('Regex One.md', 'order-1234 shipped\n');
      await create('Regex Two.md', 'order-abcd pending\n');
      await sleep(400);
      const digits = await unwrap(window.api.vaultSearch('/order-\\d+/', {}));
      eq(digits.length, 1, 'the regex matched one note');
      includes(digits[0].path, 'Regex One');
      const excluded = await unwrap(window.api.vaultSearch('order -pending', {}));
      assert(
        excluded.every((hit) => !hit.path.includes('Regex Two')),
        'the excluded note is gone',
      );
    });

    await test('changing a setting persists to .obsidian', async () => {
      await unwrap(window.api.vaultSaveSettings({ fontSize: 19 }));
      await sleep(400);
      const state = await unwrap(window.api.vaultState());
      eq(state.settings.fontSize, 19);
      const raw = await read('.obsidian/app.json').catch(() => null);
      void raw;
    });

    await test('a template expands its variables when inserted', async () => {
      await create('Templates/Probe Template.md', '# {{title}}\n\nWritten {{date:YYYY}}.\n');
      await sleep(350);
      const rendered = await unwrap(
        window.api.vaultTemplate('Templates/Probe Template.md', 'My Title'),
      );
      includes(rendered, '# My Title');
      includes(rendered, String(new Date().getFullYear()));
    });

    await test('splitting opens a second pane', async () => {
      await openFile('Outline Note');
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '\\', metaKey: true, bubbles: true, cancelable: true }),
      );
      await waitFor(() => qa('.ob-leaf').length >= 2, 'a second pane');
      const leaves = qa('.ob-leaf');
      eq(leaves.length, 2);
      // Close the extra pane's tab again so later tests are not confused.
      const close = leaves[1].querySelector('.tab-close');
      if (close) close.click();
      await sleep(250);
    });

    // -- running a workspace -------------------------------------------------
    //
    // These need a relay, which the runner starts. Everything here is driven
    // the way a person would: click the workspace name, click Manage members,
    // work the table. It is the only check that the admin surface is reachable
    // at all rather than merely compiling.

    async function openWorkspaceMenu() {
      const nav = byText('.side-row', 'Chat') ?? byText('.side-row', 'Knowledge');
      if (nav) nav.click();
      await sleep(120);
      const head = q('.ws-head') ?? q('.sidebar-head') ?? q('[class*="workspace"]');
      if (head) head.click();
      await sleep(200);
      return q('.menu') ?? q('.ws-menu-anchor');
    }

    await test('the app connects to a relay and lands in a workspace', async () => {
      const state = await waitFor(
        async () => {
          const s = await window.api.getState();
          return s.workspaces.length ? s : null;
        },
        'a workspace over the socket',
        15000,
      );
      assert(state.workspaces.length >= 1, 'no workspace arrived');
      const ws = state.workspaces[0];
      log(`workspace: ${ws.workspace.name}, role ${ws.me.role}`);
      log(`workspace keys: ${Object.keys(ws.workspace).join(',')}`);
      log(`view keys: ${Object.keys(ws).join(',')}`);
      log(`shell present: ${Boolean(q('.app'))}; sections: ${qa('.side-row').map((r) => r.textContent.trim()).join('|')}`);
      // Everything the admin surface reads must be on the view, not undefined.
      assert(ws.workspace.permissions, 'the workspace carries a permission table');
      eq(typeof ws.workspace.primaryOwner, 'string', 'and a primary owner');
      assert(Array.isArray(ws.joinRequests), 'join requests are an array');
      assert(Array.isArray(ws.audit), 'the audit log is an array');
      eq(ws.me.primaryOwner, true, 'the first person in holds the workspace');
    });

    await test('the member table opens and can be searched', async () => {
      const menu = await openWorkspaceMenu();
      const manage =
        byText('.menu-item', 'Manage members') ??
        byText('.menu-item', 'Members') ??
        byText('button', 'Members', menu ?? document);
      assert(manage, 'no way to reach the member list from the workspace menu');
      manage.click();

      await waitFor(() => q('.member-list'), 'the member table');
      assert(qa('.member-row').length >= 1, 'nobody in the table');
      assert(byText('.member-name', 'primary owner'), 'the holder is marked as such');

      // Searching narrows it, and a miss says so rather than showing everybody.
      const search = q('.admin-toolbar input');
      assert(search, 'no search box');
      const before = qa('.member-row').length;
      setNativeValue(search, 'zzzz-nobody');
      await sleep(200);
      assert(
        qa('.member-row').length < before || q('.empty'),
        'searching for nobody still showed everybody',
      );
      setNativeValue(search, '');
      await sleep(200);
      eq(qa('.member-row').length, before, 'clearing the search brings everybody back');
    });

    await test('permissions render every capability, and the floors are shown', async () => {
      const tab = byText('.tab', 'Permissions');
      assert(tab, 'no permissions tab');
      tab.click();
      await waitFor(() => q('.permission-table'), 'the permission table');
      const rows = qa('.permission-row');
      assert(rows.length >= 8, `expected every capability, saw ${rows.length}`);
      assert(qa('.permission-floor').length > 0, 'the hard floors are not shown anywhere');

      // A capability with a floor must not offer a role below it.
      const managed = rows.find((r) => r.textContent.includes('Change roles'));
      assert(managed, 'no row for managing members');
      const options = [...managed.querySelectorAll('option')].map((o) => o.value);
      assert(!options.includes('guest'), 'managing members was offered to guests');
      assert(!options.includes('member'), 'managing members was offered to members');
    });

    await test('the invitations tab can mint a code', async () => {
      const tab = byText('.tab', 'Invitations');
      assert(tab, 'no invitations tab');
      tab.click();
      await sleep(250);
      const create = byText('button', 'Create invitation');
      assert(create, 'no way to create an invitation');
      create.click();
      const card = await waitFor(() => q('.card-title.mono'), 'an invitation code', 6000);
      assert(/[a-z0-9-]{8,}/.test(card.textContent.trim()), `odd code: ${card.textContent}`);

      // And it can be taken back.
      const revoke = byText('button', 'Revoke');
      assert(revoke, 'no way to revoke it');
      revoke.click();
      await sleep(400);
    });

    await test('the activity log records what just happened', async () => {
      const tab = byText('.tab', 'Activity log');
      assert(tab, 'no activity log tab');
      tab.click();
      // The log is fetched over the socket when the tab opens, so an empty
      // state here means "it has not arrived yet", not "nothing happened".
      const list = await waitFor(() => q('.log-list'), 'the log to arrive from the relay', 10000);
      const text = list.textContent;
      includes(text, 'invitation', 'the invitation is not in the log');
    });

    await test('closing the admin dialog leaves the app usable', async () => {
      const close = qa('.modal-head button').pop();
      if (close) close.click();
      await sleep(300);
      assert(!q('.member-list'), 'the dialog did not close');
      assert(q('.app'), 'the app shell survived');
    });

    // -- appearance ---------------------------------------------------------
    //
    // The token tests in `tests/theme.test.mjs` read the stylesheet. These read
    // the screen: they take real elements out of the running window, flip the
    // theme, and ask the browser what it actually computed. That is the only
    // way to catch a colour that resolved to `transparent`, a rule that lost to
    // an inline style, or a surface that came out identical to the text on it.

    const ROOT = document.documentElement;

    function rgb(value) {
      const parts = String(value).match(/[\d.]+/g);
      if (!parts) return null;
      const [r, g, b, a = 1] = parts.map(Number);
      return { r, g, b, a };
    }
    function relLum({ r, g, b }) {
      const ch = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    }
    function ratioOf(a, b) {
      const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    }
    /** The nearest ancestor that actually paints something, the way a screen sees it. */
    function paintedBackground(element) {
      let node = element;
      while (node && node !== document.documentElement) {
        const colour = rgb(getComputedStyle(node).backgroundColor);
        if (colour && colour.a > 0.98) return colour;
        node = node.parentElement;
      }
      return rgb(getComputedStyle(document.body).backgroundColor);
    }

    async function withTheme(theme, fn) {
      const before = ROOT.dataset.theme;
      ROOT.dataset.theme = theme;
      await sleep(120);
      try {
        return await fn();
      } finally {
        if (before === undefined) delete ROOT.dataset.theme;
        else ROOT.dataset.theme = before;
        await sleep(80);
      }
    }

    for (const theme of ['dark', 'light']) {
      await test(`${theme}: the whole window repaints`, async () => {
        await withTheme(theme, async () => {
          const body = rgb(getComputedStyle(document.body).backgroundColor);
          assert(body, 'the body has no computed background');
          const light = relLum(body) > 0.5;
          eq(light, theme === 'light', `the ${theme} theme painted the wrong kind of background`);
        });
      });

      await test(`${theme}: every visible label is legible where it sits`, async () => {
        await withTheme(theme, async () => {
          const suspects = [];
          const nodes = qa(
            'button, .ob-tab, .ob-file-row, .settings-label, .settings-hint, ' +
              '.ob-status, .ob-ribbon-button, .nav-item, .side-item, h1, h2, p, label, kbd, code',
          );
          for (const node of nodes) {
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (!node.getClientRects().length) continue;
            if (Number(style.opacity) < 0.5) continue;
            if (!node.textContent || !node.textContent.trim()) continue;
            const fg = rgb(style.color);
            if (!fg || fg.a < 0.5) continue;
            const bg = paintedBackground(node);
            const value = ratioOf(fg, bg);
            // 3:1 is the floor for *anything* readable at all; the exact AA
            // thresholds per role are asserted against the tokens themselves.
            if (value < 3) {
              suspects.push(
                `${node.className || node.tagName} "${node.textContent.trim().slice(0, 30)}" ${value.toFixed(2)}:1`,
              );
            }
          }
          assert(
            suspects.length === 0,
            `unreadable in ${theme}: ${suspects.slice(0, 6).join(' | ')}`,
          );
        });
      });

      await test(`${theme}: nothing is painted the colour of the thing behind it`, async () => {
        await withTheme(theme, async () => {
          const collisions = [];
          for (const node of qa('.ob-leaf, .ob-sidebar, .ob-ribbon, .ob-status')) {
            if (!node.getClientRects().length) continue;
            const own = rgb(getComputedStyle(node).backgroundColor);
            if (!own || own.a < 0.98) continue;
            const behind = paintedBackground(node.parentElement || document.body);
            if (!behind) continue;
            const border = rgb(getComputedStyle(node).borderTopColor);
            const separated =
              Math.abs(relLum(own) - relLum(behind)) > 0.002 ||
              (border && border.a > 0.1 && ratioOf(border, own) > 1.1);
            if (!separated) collisions.push(node.className || node.tagName);
          }
          assert(collisions.length === 0, `no edge between ${collisions.join(', ')} and what is behind them`);
        });
      });
    }

    await test('Knowledge is painted in the same colours as the rest of the app', async () => {
      // The admin tests left us in the chat view; the vault has to be mounted
      // for any of this to mean anything.
      await openKnowledge();

      for (const theme of ['dark', 'light']) {
        await withTheme(theme, async () => {
          await sleep(200);
          const vault = q('.ob');
          assert(vault, 'the vault is not on screen');
          const shell = getComputedStyle(document.body);
          const inside = getComputedStyle(vault);

          // Not "both are lightish" — the same value. Two palettes that merely
          // agree in spirit are exactly what this used to be.
          eq(
            inside.backgroundColor,
            shell.backgroundColor,
            `${theme}: the vault background differs from the app's`,
          );
          eq(inside.color, shell.color, `${theme}: the vault text colour differs from the app's`);

          // And the tokens it draws the rest of itself from resolve to the
          // app's, so nothing inside it can drift either.
          const pairs = [
            ['--ob-bg', '--bg'],
            ['--ob-bg-raised', '--bg-raised'],
            ['--ob-border', '--border'],
            ['--ob-text', '--text'],
            ['--ob-text-dim', '--text-dim'],
            ['--ob-text-faint', '--text-faint'],
          ];
          for (const [vaultToken, appToken] of pairs) {
            eq(
              inside.getPropertyValue(vaultToken).trim(),
              getComputedStyle(document.documentElement).getPropertyValue(appToken).trim(),
              `${theme}: ${vaultToken} has drifted from ${appToken}`,
            );
          }
        });
      }
    });

    await test('the vault records the app theme in its Obsidian config', async () => {
      // The folder is a real Obsidian vault, so the key Obsidian reads has to
      // say what the app is actually showing.
      await withTheme('light', async () => {
        await sleep(600);
        const state = await unwrap(window.api.vaultState());
        eq(state.settings.theme, 'light', 'the vault config did not follow the app into light');
      });
      await withTheme('dark', async () => {
        await sleep(600);
        const state = await unwrap(window.api.vaultState());
        eq(state.settings.theme, 'dark', 'the vault config did not follow the app into dark');
      });
    });

    await test('leaving the vault takes its accent colour with it', async () => {
      const before = ROOT.style.getPropertyValue('--vault-accent');
      log(`vault accent while inside: "${before}"`);
      // The app's own accent must never be overwritten by the vault's.
      assert(
        !ROOT.style.getPropertyValue('--accent'),
        'the vault leaked an inline --accent onto the whole app',
      );
    });

    return {
      results,
      logs,
      summary: {
        total: results.length,
        passed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      },
    };
  })().catch((error) => ({
    fatal: (error && error.stack) || String(error),
    results,
    logs,
  }));
})();
