const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---------------------------------------------------------------- fake Pebble runtime

class NotFound extends Error { constructor(name) { super(`${name} not found`); this.name = 'NotFoundError'; } }

/** In-memory directory handle with the File System Access subset the plugin uses. */
class Dir {
  constructor(name) { this.kind = 'directory'; this.name = name; this.children = new Map(); }
  async queryPermission() { return 'granted'; }
  async getDirectoryHandle(name, opts) {
    let child = this.children.get(name);
    if (!child) {
      if (!opts || !opts.create) throw new NotFound(name);
      child = new Dir(name);
      this.children.set(name, child);
    }
    if (child.kind !== 'directory') { const e = new Error('not a directory'); e.name = 'TypeMismatchError'; throw e; }
    return child;
  }
  async getFileHandle(name, opts) {
    let child = this.children.get(name);
    if (!child) {
      if (!opts || !opts.create) throw new NotFound(name);
      child = new FileH(name, '');
      this.children.set(name, child);
    }
    if (child.kind !== 'file') { const e = new Error('not a file'); e.name = 'TypeMismatchError'; throw e; }
    return child;
  }
}
class FileH {
  constructor(name, content) { this.kind = 'file'; this.name = name; this.content = content; }
  async getFile() { const content = this.content; return { lastModified: 1, text: async () => content }; }
  async createWritable() {
    let buffer = '';
    return { write: async (data) => { buffer += data; }, close: async () => { this.content = buffer; }, abort: async () => {} };
  }
}

function makeVault(files) {
  const root = new Dir('Vault');
  for (const [p, content] of Object.entries(files || {})) {
    const parts = p.split('/');
    const name = parts.pop();
    let dir = root;
    for (const part of parts) {
      if (!dir.children.has(part)) dir.children.set(part, new Dir(part));
      dir = dir.children.get(part);
    }
    dir.children.set(name, new FileH(name, content));
  }
  return root;
}

function readVault(root, p) {
  let node = root;
  for (const part of p.split('/')) { node = node && node.children && node.children.get(part); }
  return node ? node.content : undefined;
}

function loadPlugin() {
  const store = {};
  const handlers = {};
  const grants = {};
  const context = {
    console: { log() {}, error() {} },
    Promise,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    Pebble: {
      registerSourceHandler: (fn) => { handlers.source = fn; },
      registerActionHandler: (fn) => { handlers.action = fn; },
      registerConfigHandler: (fn) => { handlers.config = fn; },
      fileSystem: { getHandle: async (id) => { if (!grants[id]) throw new NotFound(id); return grants[id]; } },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/plugin/index.js'), 'utf8'), context);
  return { plugin: context, handlers, grants };
}

/** Call the action handler and collect what it responds with. */
function invoke(handlers, args, action) {
  return new Promise((resolve) => {
    handlers.action({ action: action || 'send_to_Obsidian_Daily_Notes', args }, {
      ok: (value) => resolve({ ok: value }),
      error: (code, message) => resolve({ error: code, message }),
    });
  });
}

function config(handlers, message) {
  return new Promise((resolve) => handlers.config(message, resolve));
}

const date = new Date(2026, 10, 11, 20, 1, 30); // 2026-11-11 (Wed) 20:01:30 local

// ---------------------------------------------------------------- pure helpers

test('formatMoment covers common daily-note formats', () => {
  const { plugin } = loadPlugin();
  assert.strictEqual(plugin.formatMoment('YYYY-MM-DD', date), '2026-11-11');
  assert.strictEqual(plugin.formatMoment('YYYY/MM/YYYY-MM-DD', date), '2026/11/2026-11-11');
  assert.strictEqual(plugin.formatMoment('YYYY-MM-DD ddd', date), '2026-11-11 Wed');
  assert.strictEqual(plugin.formatMoment('dddd, MMMM Do YYYY', date), 'Wednesday, November 11th 2026');
  assert.strictEqual(plugin.formatMoment('[Week] WW, YY', date), 'Week 46, 26');
  assert.strictEqual(plugin.formatMoment('HH:mm', date), '20:01');
  assert.strictEqual(plugin.formatMoment('h:mm A', date), '8:01 PM');
  assert.strictEqual(plugin.formatMoment('YYYY年M月D日', date), '2026年11月11日');
});

test('dailyNotePath joins folder and formatted name', () => {
  const { plugin } = loadPlugin();
  assert.strictEqual(plugin.dailyNotePath('', 'YYYY-MM-DD', date), '2026-11-11.md');
  assert.strictEqual(plugin.dailyNotePath('Daily/', 'YYYY-MM-DD', date), 'Daily/2026-11-11.md');
  assert.strictEqual(plugin.dailyNotePath('Journal', 'YYYY/MM/YYYY-MM-DD', date), 'Journal/2026/11/2026-11-11.md');
  assert.strictEqual(plugin.dailyNotePath('../x', '', date), 'x/2026-11-11.md');
});

test('expandTemplate fills core Templates variables', () => {
  const { plugin } = loadPlugin();
  const out = plugin.expandTemplate('# {{title}}\n{{date}} {{time}} {{date:dddd}} {{ date : YYYY }}', '2026-11-11', date, {});
  assert.strictEqual(out, '# 2026-11-11\n2026-11-11 20:01 Wednesday 2026');
  assert.strictEqual(plugin.expandTemplate('{{date}}', 't', date, { dateFormat: 'DD/MM' }), '11/11');
});

test('formatMemoLine flattens text and applies the format', () => {
  const { plugin } = loadPlugin();
  assert.strictEqual(plugin.formatMemoLine('- {time} : {text}', ' line one\n  line two ', date), '- 20:01 : line one line two');
  assert.strictEqual(plugin.formatMemoLine('- [{date} {time}] {text}', 'x', date), '- [2026-11-11 20:01] x');
  // A format without {text} would lose the memo, so the default is used.
  assert.strictEqual(plugin.formatMemoLine('- {time}', 'x', date), '- 20:01 : x');
});

test('insertMemo appends a new section at the end', () => {
  const { plugin } = loadPlugin();
  assert.deepStrictEqual({ ...plugin.insertMemo('', '- 20:01 : a', 'pebble') }, { content: '## pebble\n\n- 20:01 : a\n', added: true });
  assert.strictEqual(plugin.insertMemo('# Today\n\nnotes\n\n\n', '- 20:01 : a', 'pebble').content,
    '# Today\n\nnotes\n\n## pebble\n\n- 20:01 : a\n');
});

test('insertMemo adds to an existing section before the next heading', () => {
  const { plugin } = loadPlugin();
  const note = '## pebble\n\n- 08:00 : first\n\n## Log\n\nstuff\n';
  assert.strictEqual(plugin.insertMemo(note, '- 20:01 : second', 'Pebble').content,
    '## pebble\n\n- 08:00 : first\n- 20:01 : second\n\n## Log\n\nstuff\n');
  // ### subheadings stay inside the section.
  const nested = '## pebble\n- a\n### sub\n- b\n';
  assert.strictEqual(plugin.insertMemo(nested, '- c', 'pebble').content, '## pebble\n- a\n### sub\n- b\n- c\n');
});

test('insertMemo fills an empty section', () => {
  const { plugin } = loadPlugin();
  assert.strictEqual(plugin.insertMemo('## pebble\n\n\n## Log\n', '- x', 'pebble').content, '## pebble\n\n- x\n\n## Log\n');
  assert.strictEqual(plugin.insertMemo('intro\n## pebble\n', '- x', 'pebble').content, 'intro\n## pebble\n\n- x\n');
});

test('insertMemo does not duplicate a line already in the section', () => {
  const { plugin } = loadPlugin();
  const note = '## pebble\n\n- 20:01 : a\n';
  const result = plugin.insertMemo(note, '- 20:01 : a', 'pebble');
  assert.strictEqual(result.added, false);
  assert.strictEqual(result.content, note);
});

test('resolveDailySettings prefers plugin settings, then Obsidian, then defaults', () => {
  const { plugin } = loadPlugin();
  const obsidian = { folder: 'Daily', format: 'YYYY/MM/DD', template: 'Templates/Daily' };
  const fromObsidian = plugin.resolveDailySettings({ dailyFolder: '', dateFormat: '', templatePath: '' }, obsidian, null);
  assert.strictEqual(fromObsidian.folder, 'Daily');
  assert.strictEqual(fromObsidian.format, 'YYYY/MM/DD');
  assert.strictEqual(fromObsidian.template, 'Templates/Daily.md');
  assert.strictEqual(fromObsidian.from.folder, 'obsidian');
  const own = plugin.resolveDailySettings({ dailyFolder: 'J', dateFormat: 'YYYYMMDD', templatePath: 'T.md' }, obsidian, null);
  assert.deepStrictEqual([own.folder, own.format, own.template], ['J', 'YYYYMMDD', 'T.md']);
  const none = plugin.resolveDailySettings({}, null, null);
  assert.deepStrictEqual([none.folder, none.format, none.template, none.from.format], ['', 'YYYY-MM-DD', '', 'default']);
});

// ---------------------------------------------------------------- end to end through the handlers

async function connectedPlugin(files) {
  const loaded = loadPlugin();
  const vault = makeVault(files);
  loaded.grants.g1 = vault;
  const result = await config(loaded.handlers, { type: 'setFolder', id: 'g1' });
  assert.ok(result.ok);
  return { ...loaded, vault };
}

function todayName() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

test('action fails with AUTH_REQUIRED before a vault is chosen', async () => {
  const { handlers } = loadPlugin();
  const res = await invoke(handlers, { text: 'hi' });
  assert.strictEqual(res.error, 'AUTH_REQUIRED');
});

test('action rejects empty text', async () => {
  const { handlers } = await connectedPlugin({});
  assert.strictEqual((await invoke(handlers, { text: '  \n ' })).error, 'INVALID_ARGS');
  assert.strictEqual((await invoke(handlers, {})).error, 'INVALID_ARGS');
  assert.strictEqual((await invoke(handlers, { text: 'x', instanceId: 'other' })).error, 'INVALID_ARGS');
});

test('action creates the daily note from Obsidian settings and template', async () => {
  const { handlers, vault } = await connectedPlugin({
    '.obsidian/daily-notes.json': JSON.stringify({ folder: 'Daily', format: 'YYYY-MM-DD', template: 'Templates/Daily' }),
    'Templates/Daily.md': '---\ntags: [daily]\n---\n# {{title}}\n',
  });
  const res = await invoke(handlers, { text: 'Feeling good\ntoday' });
  assert.ok(res.ok, JSON.stringify(res));
  const content = readVault(vault, `Daily/${todayName()}.md`);
  assert.match(content, new RegExp(`^---\\ntags: \\[daily\\]\\n---\\n# ${todayName()}\\n\\n## pebble\\n\\n- \\d\\d:\\d\\d : Feeling good today\\n$`));
});

test('action appends to an existing note and creates intermediate folders', async () => {
  const name = todayName();
  const [y, m] = name.split('-');
  const { handlers, vault } = await connectedPlugin({
    '.obsidian/daily-notes.json': JSON.stringify({ folder: 'Journal', format: 'YYYY/MM/YYYY-MM-DD' }),
  });
  await invoke(handlers, { text: 'one' });
  await invoke(handlers, { text: 'two' });
  const content = readVault(vault, `Journal/${y}/${m}/${name}.md`);
  const lines = content.trim().split('\n');
  assert.strictEqual(lines[0], '## pebble');
  assert.match(lines[2], / : one$/);
  assert.match(lines[3], / : two$/);
});

test('concurrent memos are both written', async () => {
  const { handlers, vault } = await connectedPlugin({});
  await Promise.all([invoke(handlers, { text: 'a' }), invoke(handlers, { text: 'b' }), invoke(handlers, { text: 'c' })]);
  const content = readVault(vault, `${todayName()}.md`);
  for (const t of ['a', 'b', 'c']) assert.match(content, new RegExp(` : ${t}$`, 'm'));
});

test('a missing template still creates the note and says so', async () => {
  const { handlers, vault } = await connectedPlugin({
    '.obsidian/daily-notes.json': JSON.stringify({ template: 'Nope' }),
  });
  const res = await invoke(handlers, { text: 'x' });
  assert.match(res.ok.text, /Template not found/);
  assert.match(readVault(vault, `${todayName()}.md`), /^## pebble\n\n- \d\d:\d\d : x\n$/);
});

test('plugin settings override the section and line format', async () => {
  const { handlers, vault } = await connectedPlugin({ [`${todayName()}.md`]: '# Day\n' });
  await config(handlers, { type: 'save', config: { section: '## Memo', lineFormat: '- [ ] {text}' } });
  await invoke(handlers, { text: 'buy milk' });
  assert.strictEqual(readVault(vault, `${todayName()}.md`), '# Day\n\n## Memo\n\n- [ ] buy milk\n');
});

test('preview reports where the memo would go without writing', async () => {
  const { handlers, vault } = await connectedPlugin({
    '.obsidian/daily-notes.json': JSON.stringify({ folder: 'Daily' }),
  });
  const res = await config(handlers, { type: 'preview' });
  assert.strictEqual(res.path, `Daily/${todayName()}.md`);
  assert.strictEqual(res.exists, false);
  assert.strictEqual(res.obsidianConfigFound, true);
  assert.strictEqual(res.from.folder, 'obsidian');
  assert.strictEqual(readVault(vault, `Daily/${todayName()}.md`), undefined);
});

test('a withdrawn grant reports AUTH_REQUIRED', async () => {
  const { handlers, grants } = await connectedPlugin({});
  delete grants.g1;
  const res = await invoke(handlers, { text: 'x' });
  assert.strictEqual(res.error, 'AUTH_REQUIRED');
  assert.match(res.message, /withdrawn/);
});

test('the 0.1.0 action name still works; unknown names are rejected', async () => {
  const { handlers, vault } = await connectedPlugin({});
  assert.ok((await invoke(handlers, { text: 'old name' }, 'add_daily_memo')).ok);
  assert.match(readVault(vault, `${todayName()}.md`), / : old name$/m);
  assert.strictEqual((await invoke(handlers, { text: 'x' }, 'nope')).error, 'INVALID_REQUEST');
});
