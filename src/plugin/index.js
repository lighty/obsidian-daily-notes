// Obsidian Daily Notes — a Pebble app plugin.
//
// Exposes one action, `add_daily_memo`, that Index (or a watchapp via Pebble.invokeAction) calls with
// a memo text. The memo is written straight into today's Obsidian daily note inside a vault folder
// the user picked in the settings page; no Obsidian plugin is involved. The daily note is created
// (from the configured template) when it does not exist yet.
//
// Top-level declarations are `var`/`function` on purpose: the tests load this file into a vm context
// and call the helpers as globals.

var STORE_KEY = 'obsidian_daily_notes_config_v1';
var INSTANCE_ID = 'daily-note';
var DISPLAY_NAME = 'Obsidian Daily Notes';
var REFRESHED = ['notes/destination', 'notes/configured'];
var DEFAULT_FORMAT = 'YYYY-MM-DD';
var DEFAULT_SECTION = 'pebble';
var DEFAULT_LINE_FORMAT = '- {time} : {text}';
var OBSIDIAN_DIR = '.obsidian';
var writeQueue = Promise.resolve();

// ------------------------------------------------------------------ pure helpers

function pad(number, length) { return String(number).padStart(length || 2, '0'); }

/** Normalise a vault-relative path: forward slashes, no empty / `.` / `..` segments. */
function cleanPath(raw) {
  return String(raw || '').replace(/\\/g, '/').split('/').map(function (part) {
    return part.trim();
  }).filter(function (part) {
    return part && part !== '.' && part !== '..';
  }).join('/');
}

function pathSegments(path) { return cleanPath(path).split('/').filter(Boolean); }

function withMd(path) {
  var clean = cleanPath(path);
  if (!clean) return '';
  return /\.md$/i.test(clean) ? clean : clean + '.md';
}

var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ordinal(n) {
  var rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return n + 'th';
  var rem10 = n % 10;
  return n + (rem10 === 1 ? 'st' : rem10 === 2 ? 'nd' : rem10 === 3 ? 'rd' : 'th');
}

/** ISO-8601 week number and week-based year for a local date. */
function isoWeek(date) {
  var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { week: Math.ceil(((d - yearStart) / 86400000 + 1) / 7), year: d.getUTCFullYear() };
}

var MOMENT_TOKENS = /\[([^\]]*)\]|YYYY|GGGG|YY|Q|MMMM|MMM|MM|M|Do|DDDD|DD|D|dddd|ddd|dd|d|E|WW|W|HH|H|hh|h|mm|m|ss|s|A|a/g;

/**
 * Format a local date with the subset of Moment.js tokens that daily-note formats use
 * (English names; `[text]` is a literal). Unknown letters are left as they are.
 */
function formatMoment(format, date) {
  var hours12 = date.getHours() % 12 || 12;
  var dayOfYear = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / 86400000) + 1;
  return String(format).replace(MOMENT_TOKENS, function (token, literal) {
    if (literal !== undefined) return literal;
    switch (token) {
      case 'YYYY': return String(date.getFullYear());
      case 'GGGG': return String(isoWeek(date).year);
      case 'YY': return pad(date.getFullYear() % 100);
      case 'Q': return String(Math.floor(date.getMonth() / 3) + 1);
      case 'MMMM': return MONTHS[date.getMonth()];
      case 'MMM': return MONTHS[date.getMonth()].slice(0, 3);
      case 'MM': return pad(date.getMonth() + 1);
      case 'M': return String(date.getMonth() + 1);
      case 'Do': return ordinal(date.getDate());
      case 'DDDD': return pad(dayOfYear, 3);
      case 'DD': return pad(date.getDate());
      case 'D': return String(date.getDate());
      case 'dddd': return WEEKDAYS[date.getDay()];
      case 'ddd': return WEEKDAYS[date.getDay()].slice(0, 3);
      case 'dd': return WEEKDAYS[date.getDay()].slice(0, 2);
      case 'd': return String(date.getDay());
      case 'E': return String(date.getDay() || 7);
      case 'WW': return pad(isoWeek(date).week);
      case 'W': return String(isoWeek(date).week);
      case 'HH': return pad(date.getHours());
      case 'H': return String(date.getHours());
      case 'hh': return pad(hours12);
      case 'h': return String(hours12);
      case 'mm': return pad(date.getMinutes());
      case 'm': return String(date.getMinutes());
      case 'ss': return pad(date.getSeconds());
      case 's': return String(date.getSeconds());
      case 'A': return date.getHours() < 12 ? 'AM' : 'PM';
      case 'a': return date.getHours() < 12 ? 'am' : 'pm';
      default: return token;
    }
  });
}

/** Vault-relative path of the daily note for `date`. The format may contain `/` (e.g. `YYYY/MM/YYYY-MM-DD`). */
function dailyNotePath(folder, format, date) {
  var name = cleanPath(formatMoment(format || DEFAULT_FORMAT, date));
  if (!name) name = formatMoment(DEFAULT_FORMAT, date);
  return withMd(cleanPath(folder) ? cleanPath(folder) + '/' + name : name);
}

/** Expand the core Templates plugin's variables: {{title}}, {{date}}, {{time}}, {{date:FMT}}, {{time:FMT}}. */
function expandTemplate(template, title, date, formats) {
  var dateFormat = (formats && formats.dateFormat) || DEFAULT_FORMAT;
  var timeFormat = (formats && formats.timeFormat) || 'HH:mm';
  return String(template).replace(/\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/gi, function (match, key, fmt) {
    var name = key.toLowerCase();
    if (name === 'title') return title;
    var custom = fmt !== undefined ? fmt.trim() : '';
    return formatMoment(custom || (name === 'date' ? dateFormat : timeFormat), date);
  });
}

/** Memo text as one line: line breaks become spaces. */
function flattenText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

function cleanLineFormat(raw) {
  var value = String(raw || '').replace(/[\r\n]+/g, ' ');
  return value.indexOf('{text}') !== -1 ? value : DEFAULT_LINE_FORMAT;
}

function cleanSection(raw) {
  var value = String(raw || '').replace(/[\r\n]+/g, ' ').replace(/^#+\s*/, '').trim();
  return value || DEFAULT_SECTION;
}

/** The line written for one memo, e.g. `- 20:01 : Feeling good today`. */
function formatMemoLine(lineFormat, text, date) {
  var values = { time: formatMoment('HH:mm', date), date: formatMoment(DEFAULT_FORMAT, date), text: flattenText(text) };
  return cleanLineFormat(lineFormat).replace(/\{(time|date|text)\}/g, function (match, key) { return values[key]; });
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Add `line` to the `## <section>` section of a note.
 *
 * - The section exists: the line goes after its last non-blank line (the section ends at the next
 *   `#` or `##` heading). If the exact line is already in the section, nothing changes.
 * - It does not: `## <section>` and the line are appended at the end of the note.
 *
 * Returns `{ content, added }`. The content always ends with exactly one newline.
 */
function insertMemo(content, line, section) {
  var text = String(content || '').replace(/\r\n/g, '\n');
  var title = cleanSection(section);
  var lines = text.split('\n');
  var headingRe = new RegExp('^##\\s+' + escapeRegExp(title) + '\\s*$', 'i');
  var start = -1;
  for (var i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) { start = i; break; }
  }

  if (start === -1) {
    var base = text.replace(/\s+$/, '');
    var block = '## ' + title + '\n\n' + line + '\n';
    return { content: base ? base + '\n\n' + block : block, added: true };
  }

  var end = lines.length;
  for (var j = start + 1; j < lines.length; j++) {
    if (/^#{1,2}\s/.test(lines[j])) { end = j; break; }
  }
  for (var k = start + 1; k < end; k++) {
    if (lines[k].replace(/\s+$/, '') === line) return { content: text, added: false };
  }

  var last = -1;
  for (var m = end - 1; m > start; m--) {
    if (lines[m].trim() !== '') { last = m; break; }
  }
  if (last === -1) {
    // Empty section: heading, blank line, memo, and a blank line before the next heading.
    var replacement = end < lines.length ? ['', line, ''] : ['', line];
    lines.splice.apply(lines, [start + 1, end - (start + 1)].concat(replacement));
  } else {
    lines.splice(last + 1, 0, line);
  }
  return { content: lines.join('\n').replace(/\s+$/, '') + '\n', added: true };
}

/**
 * Where the daily note lives. Each value comes from the plugin settings when set, else from the
 * vault's Daily notes core plugin config (`.obsidian/daily-notes.json`), else a default.
 */
function resolveDailySettings(current, dailyNotesConfig, templatesConfig) {
  var obsidian = dailyNotesConfig || {};
  var templates = templatesConfig || {};
  function pick(own, fromObsidian, fallback) {
    if (own) return { value: own, from: 'plugin' };
    if (typeof fromObsidian === 'string' && fromObsidian.trim()) return { value: fromObsidian.trim(), from: 'obsidian' };
    return { value: fallback, from: 'default' };
  }
  var folder = pick(cleanPath(current.dailyFolder), cleanPath(obsidian.folder), '');
  var format = pick(current.dateFormat, obsidian.format, DEFAULT_FORMAT);
  var template = pick(withMd(current.templatePath), withMd(obsidian.template), '');
  return {
    folder: folder.value,
    format: format.value,
    template: template.value,
    from: { folder: folder.from, format: format.from, template: template.from },
    dateFormat: typeof templates.dateFormat === 'string' && templates.dateFormat.trim() ? templates.dateFormat.trim() : DEFAULT_FORMAT,
    timeFormat: typeof templates.timeFormat === 'string' && templates.timeFormat.trim() ? templates.timeFormat.trim() : 'HH:mm',
  };
}

// ------------------------------------------------------------------ settings

function storedValue() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
}

function config() {
  var value = storedValue();
  return {
    // Grant id from Pebble.showDirectoryPicker; the vault root every path is resolved under.
    folderId: typeof value.folderId === 'string' ? value.folderId : '',
    folderName: typeof value.folderName === 'string' ? value.folderName : '',
    // Empty = take it from .obsidian/daily-notes.json.
    dailyFolder: cleanPath(value.dailyFolder),
    dateFormat: typeof value.dateFormat === 'string' ? value.dateFormat.trim() : '',
    templatePath: cleanPath(value.templatePath),
    section: cleanSection(value.section),
    lineFormat: cleanLineFormat(value.lineFormat),
  };
}

function store(value) { localStorage.setItem(STORE_KEY, JSON.stringify(value)); }

function saveConfig(candidate) {
  var current = config();
  var next = {
    folderId: current.folderId,
    folderName: current.folderName,
    dailyFolder: cleanPath(candidate.dailyFolder),
    dateFormat: typeof candidate.dateFormat === 'string' ? candidate.dateFormat.trim() : '',
    templatePath: cleanPath(candidate.templatePath),
    section: cleanSection(candidate.section),
    lineFormat: cleanLineFormat(candidate.lineFormat),
  };
  store(next);
  return config();
}

function setFolder(id, name) {
  var current = config();
  current.folderId = id;
  current.folderName = name;
  store(current);
}

function clearFolder() {
  var current = config();
  current.folderId = '';
  current.folderName = '';
  store(current);
}

// ------------------------------------------------------------------ file access
//
// Pebble.fileSystem.getHandle(grantId) gives a File System Access style directory handle
// (getDirectoryHandle / getFileHandle / getFile / createWritable / queryPermission). There is no
// append, so a note is updated by reading it whole and writing it back.

function isNotFound(error) {
  return !!error && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError' || error.code === 'NOT_FOUND');
}
function isNotAllowed(error) { return !!error && (error.name === 'NotAllowedError' || error.code === 'PERMISSION_DENIED'); }
function errorText(error) { return error && error.message ? error.message : String(error || 'Unknown error'); }

/** Run `work` after every earlier write has finished, so two memos never race on one note. */
function serialized(work) {
  var run = writeQueue.then(work, work);
  writeQueue = run.then(function () {}, function () {});
  return run;
}

async function vaultStatus() {
  var current = config();
  var status = { configured: false, writable: false, withdrawn: false, name: current.folderName, handle: null };
  if (!current.folderId) return status;
  var handle;
  try { handle = await Pebble.fileSystem.getHandle(current.folderId); }
  catch (error) {
    if (isNotAllowed(error) || isNotFound(error)) { status.withdrawn = true; return status; }
    throw error;
  }
  if (!handle || handle.kind !== 'directory') { status.withdrawn = true; return status; }
  var readable = (await handle.queryPermission({ mode: 'read' })) === 'granted';
  var writable = readable && (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  status.name = handle.name || current.folderName;
  status.configured = readable;
  status.withdrawn = !readable;
  status.writable = writable;
  status.handle = readable ? handle : null;
  return status;
}

async function fileHandle(root, path, create) {
  var parts = pathSegments(path);
  if (!parts.length) throw new Error('A file path is required.');
  var name = parts.pop();
  var dir = root;
  for (var i = 0; i < parts.length; i++) dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
  return dir.getFileHandle(name, { create: !!create });
}

async function readText(root, path) {
  var file = await (await fileHandle(root, path, false)).getFile();
  var text = await file.text();
  if (typeof text !== 'string') throw new Error('The file could not be read as text.');
  return text;
}

/** The file's text, or null when it does not exist. */
async function readIfExists(root, path) {
  try { return await readText(root, path); }
  catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function readJson(root, path) {
  try {
    var text = await readIfExists(root, path);
    return text === null ? null : JSON.parse(text);
  } catch (error) {
    // A missing or unreadable Obsidian config only means we fall back to defaults.
    console.log('Could not read ' + path + ': ' + (error && error.name));
    return null;
  }
}

async function writeText(root, path, content) {
  var handle = await fileHandle(root, path, true);
  var writable = await handle.createWritable();
  try { await writable.write(content); }
  catch (error) {
    try { await writable.abort(); } catch (ignored) {}
    throw error;
  }
  await writable.close();
  var check = await readText(root, path);
  if (check !== content) throw new Error('The daily note changed while it was being saved; check it before retrying.');
}

async function loadDailySettings(root) {
  var dailyNotes = await readJson(root, OBSIDIAN_DIR + '/daily-notes.json');
  var templates = await readJson(root, OBSIDIAN_DIR + '/templates.json');
  var resolved = resolveDailySettings(config(), dailyNotes, templates);
  resolved.obsidianConfigFound = !!dailyNotes;
  return resolved;
}

/** Initial content for a new daily note: the expanded template, or empty. */
async function newNoteContent(root, daily, path, now) {
  if (!daily.template) return { content: '', templateMissing: false };
  var template = await readIfExists(root, daily.template);
  if (template === null) return { content: '', templateMissing: true };
  var title = pathSegments(path).pop().replace(/\.md$/i, '');
  return { content: expandTemplate(template, title, now, daily), templateMissing: false };
}

/**
 * Write one memo into the daily note for `now`, creating the note when needed.
 * Returns `{ path, created, added, templateMissing }`.
 */
async function addMemo(root, text, now) {
  var current = config();
  var daily = await loadDailySettings(root);
  var path = dailyNotePath(daily.folder, daily.format, now);
  var line = formatMemoLine(current.lineFormat, text, now);
  return serialized(async function () {
    var existing = await readIfExists(root, path);
    var created = existing === null;
    var templateMissing = false;
    var base = existing;
    if (created) {
      var fresh = await newNoteContent(root, daily, path, now);
      base = fresh.content;
      templateMissing = fresh.templateMissing;
    }
    var result = insertMemo(base, line, current.section);
    if (created || result.added) {
      if (!created) {
        // Re-read right before writing: Obsidian or Sync may have changed the note meanwhile.
        var again = await readIfExists(root, path);
        if (again !== existing) throw new Error('The daily note changed while preparing the update. Nothing was written; try again.');
      }
      await writeText(root, path, result.content);
    }
    return { path: path, created: created, added: result.added, templateMissing: templateMissing };
  });
}

// ------------------------------------------------------------------ Pebble handlers

function shortText(text) { return { shortText: { text: String(text) } }; }
function longText(text) { return { longText: { text: String(text) } }; }
function boolText(value) { return { boolean: { value: !!value }, shortText: { text: value ? 'Connected' : 'Not connected' } }; }

async function todayPath(vault) {
  if (!vault.configured) return '';
  try {
    var daily = await loadDailySettings(vault.handle);
    return dailyNotePath(daily.folder, daily.format, new Date());
  } catch (error) { return ''; }
}

if (typeof Pebble !== 'undefined') {
  Pebble.registerSourceHandler(async function (request, respond) {
    var vault = await vaultStatus();
    var ready = vault.configured && vault.writable;
    if (request.category === 'notes' && request.item === 'configured') {
      respond.data({
        validUntilMs: Date.now() + 60000,
        instances: [{ instanceId: INSTANCE_ID, properties: { name: shortText(DISPLAY_NAME), configured: boolText(ready) } }],
      });
      return;
    }
    if (request.category === 'notes' && request.item === 'destination') {
      respond.data({
        validUntilMs: Date.now() + 60000,
        instances: [{
          instanceId: INSTANCE_ID,
          properties: {
            name: shortText('Obsidian daily note'),
            configured: boolText(ready),
            path: longText((await todayPath(vault)) || 'Choose your vault in plugin settings'),
          },
        }],
      });
      return;
    }
    respond.error('INVALID_REQUEST', 'Unsupported Obsidian Daily Notes source.');
  });

  Pebble.registerActionHandler(async function (request, respond) {
    if (request.action !== 'add_daily_memo') {
      respond.error('INVALID_REQUEST', 'Unsupported Obsidian Daily Notes action.');
      return;
    }
    var args = request.args || {};
    if (args.instanceId !== undefined && args.instanceId !== INSTANCE_ID) {
      respond.error('INVALID_ARGS', 'Unknown daily note destination.');
      return;
    }
    var text = typeof args.text === 'string' ? flattenText(args.text) : '';
    if (!text) { respond.error('INVALID_ARGS', 'The memo text cannot be empty.'); return; }

    var vault = await vaultStatus();
    if (!vault.configured) {
      respond.error('AUTH_REQUIRED', vault.withdrawn
        ? 'Access to the Obsidian vault was withdrawn. Choose it again in plugin settings.'
        : 'Choose your Obsidian vault in plugin settings first.');
      return;
    }
    if (!vault.writable) {
      respond.error('PERMISSION_DENIED', 'The Obsidian vault folder is read-only. Choose it again in plugin settings.');
      return;
    }

    var result;
    try { result = await addMemo(vault.handle, text, new Date()); }
    catch (error) {
      // Not the message itself in the log: it can carry vault file names.
      console.error('Saving the memo failed: ' + (error && error.name));
      if (isNotAllowed(error)) respond.error('PERMISSION_DENIED', 'Could not save the memo: access to the vault was withdrawn.');
      else respond.error('PLUGIN_UNAVAILABLE', 'Could not save the memo: ' + errorText(error));
      return;
    }
    var name = result.path.split('/').pop().replace(/\.md$/i, '');
    var message = result.added ? 'Added to daily note ' + name + '.' : 'Already in daily note ' + name + '.';
    if (result.templateMissing) message += ' (Template not found; created without it.)';
    respond.ok({ text: message, refreshed: REFRESHED });
  });

  Pebble.registerConfigHandler(async function (message, respond) {
    var type = message && message.type;
    if (!type || type === 'status') {
      var vault = await vaultStatus();
      respond({ vault: publicVault(vault), config: config() });
      return;
    }
    if (type === 'setFolder') {
      var id = typeof message.id === 'string' ? message.id : '';
      if (!id) { respond({ error: 'No folder was chosen.' }); return; }
      var handle;
      try { handle = await Pebble.fileSystem.getHandle(id); }
      catch (error) { respond({ error: 'Could not open the chosen folder: ' + errorText(error) }); return; }
      if (handle.kind !== 'directory') { respond({ error: 'Choose a folder, not a file.' }); return; }
      setFolder(id, handle.name || (typeof message.name === 'string' ? message.name : ''));
      respond({ ok: true, vault: publicVault(await vaultStatus()), config: config() });
      return;
    }
    if (type === 'clearFolder') {
      clearFolder();
      respond({ ok: true, config: config() });
      return;
    }
    if (type === 'save') {
      respond({ ok: true, config: saveConfig(message.config || {}) });
      return;
    }
    if (type === 'preview') {
      // What a memo sent now would do, without writing anything.
      var current = await vaultStatus();
      if (!current.configured) { respond({ error: 'Choose your vault first.' }); return; }
      try {
        var daily = await loadDailySettings(current.handle);
        var now = new Date();
        var path = dailyNotePath(daily.folder, daily.format, now);
        var exists = (await readIfExists(current.handle, path)) !== null;
        var templateFound = daily.template ? (await readIfExists(current.handle, daily.template)) !== null : false;
        respond({
          path: path,
          exists: exists,
          template: daily.template,
          templateFound: templateFound,
          from: daily.from,
          obsidianConfigFound: daily.obsidianConfigFound,
          sampleLine: formatMemoLine(config().lineFormat, 'Example memo', now),
          section: config().section,
        });
      } catch (error) {
        respond({ error: 'Could not check the daily note: ' + errorText(error) });
      }
      return;
    }
    respond({ error: 'Unknown configuration message.' });
  });
}

function publicVault(vault) {
  return { configured: vault.configured, writable: vault.writable, withdrawn: vault.withdrawn, name: vault.name };
}
