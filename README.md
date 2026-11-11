# Obsidian Daily Notes (Pebble plugin)

A plugin for the Pebble mobile app's **Plugins** system that adds memos
straight into today's [Obsidian](https://obsidian.md) daily note. No
Obsidian plugin and no server: the Pebble app writes the file in your vault
folder on the phone.

```markdown
## pebble

- 20:01 : Feeling good today
- 20:54 : Apparently the One Piece manga is great
```

It follows the same output format as
[pebble-daily-drain](https://github.com/lighty/pebble-daily-drain), but
skips the `Pebble Index.md` middle step: each memo goes into the daily note
as soon as it arrives.

## How it works

1. Index 01 (or a watchapp) calls the plugin action `add_daily_memo` with
   the memo text.
2. The plugin works out today's daily note path. Each setting comes from the
   plugin settings if you set it, else from the vault's
   `.obsidian/daily-notes.json` (folder, date format, template), else a
   default (`YYYY-MM-DD.md` at the vault root).
3. If the note does not exist, it is created from the template. The core
   Templates variables `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FMT}}`
   and `{{time:FMT}}` are expanded, using the formats in
   `.obsidian/templates.json` when present.
4. The memo is added as one line at the end of the `## pebble` section. If
   the note has no such section, it is added at the end of the note. Line
   breaks in the memo become spaces. If the same line is already in the
   section (for example, when the agent retries), it is not added again.

The date and time come from the phone's clock when the action runs.

## Setup

1. Pebble app → Settings → Plugins → turn on **Plugins / permissions
   preview** (app 1.16 or later).
2. Install this plugin (sideload the `.pbw`; see Development).
3. Open the plugin's settings and tap **Choose vault folder**. Pick the
   vault's top folder (the one that contains `.obsidian`) and allow changes.
4. Tap **Show where today's memo goes** to check the resolved path and
   template.
5. Ask Index to add something to your daily note.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Vault folder | none | Chosen with the system folder picker. |
| Folder | empty | Empty = Daily notes setting, else the vault root. |
| Date format | empty | Empty = Daily notes setting, else `YYYY-MM-DD`. May contain `/` for subfolders. |
| Template file | empty | Empty = Daily notes setting. Vault-relative; `.md` is optional. |
| Section heading | `pebble` | Memos go under `## <heading>`. |
| Line format | `- {time} : {text}` | `{time}` (HH:mm), `{date}` (YYYY-MM-DD), `{text}`. |

## Limitations

- Date formats support the common Moment.js tokens (`YYYY MM DD ddd dddd
  MMM MMMM Do WW HH mm`, `[literal]`, …) with English names only.
- Templater syntax (`<% %>`) is not run; it stays in the note as written.
- It has not been confirmed yet that the plugin file API can read files in
  `.obsidian`. If it cannot, set the folder, date format and template in the
  plugin settings. The **Show where today's memo goes** check shows whether
  the Obsidian config was found.
- Other devices get the memo when Obsidian on this phone next opens and
  syncs.

## Action

### `add_daily_memo(instanceId?, text)`

Add a short memo as one line to today's Obsidian daily note. The note is
created if needed.

- `instanceId` (string, optional): `daily-note`
- `text` (string)

Errors: `INVALID_ARGS` (empty text), `AUTH_REQUIRED` (no vault, or access
withdrawn), `PERMISSION_DENIED` (read-only), `PLUGIN_UNAVAILABLE` (write
failed; nothing is half-written).

### Sources

- `notes/destination`: name, configured, path (today's daily note)
- `notes/configured`: name, configured

## Development

```sh
npm test        # node:test, with an in-memory vault
npm run pack    # build/obsidian-daily-notes.pbw
```

- `src/plugin/index.js`: the plugin script (plain JS, no build step)
- `src/config.html`: the settings page
- `scripts/pack-plugin-pbw.py`: packages the pbw without the SDK. The
  released pebble-tool cannot build plugin-only projects yet. With the
  SDK's plugins branch, `pebble build` also works (`wscript`).

Reference: [Pebble Plugins guide](https://developer.repebble.com/guides/plugins/preview/).

## License

MIT. See [LICENSE](LICENSE).
