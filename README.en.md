# dsh-skill-mcp-board — Armory

[中文](README.md) | English

> **Unified Skill + MCP board**: on top of MCP management, adds a Skill management panel — one place to manage both the agent's "skills" and "tools".
> This project is a fork of [Imzl-zl/dsh-mcp-manager-ui](https://github.com/Imzl-zl/dsh-mcp-manager-ui) (MIT),
> upgraded from a pure MCP panel into a dual Skill + MCP board and renamed to `dsh-skill-mcp-board`.

<p align="center">
  <a href="https://linux.do/" title="LINUX DO"><img src="docs/images/linux-do-logo.svg" alt="LINUX DO" width="40" height="40"></a>
</p>

<p align="center">
  <a href="https://github.com/2026heshao/dsh-skill-mcp-board/releases"><img src="https://img.shields.io/github/v/release/2026heshao/dsh-skill-mcp-board" alt="release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a>
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.1-blue" alt="DSH">
</p>

A **unified Skill + MCP board** for DeepSeek Harness Web: click the floating button (bottom-right) or the sidebar entry to inspect MCP connection status, add servers, edit configuration — and manage Skills in the same place. The panel floats above the session — **it never interrupts an ongoing conversation**.

Three boards:

| Board | Manages |
|---|---|
| **MCP** | MCP servers: connection status, tool list, enable/disable, import, market install |
| **Skill** | Skills: enable/disable of `SKILL.md` folders, source directories, session audit scan |
| **WB Market** | Direct access to the WorkBuddy connector market (300+ connectors) and the SkillHub skill market (190k+ skills): browse, search, one-click install |

> The Skill panel reads DSH's custom skill directory (default `~/.agents/skills`): each skill is a folder with a `SKILL.md`,
> whose frontmatter declares the invocation policy (`disable-model-invocation` / `user-invocable`).
> User-invocable skills automatically appear in the `/` command menu of the chat box.

## Screenshots

### Global panel

![MCP management panel](docs/images/mcp-manager-overview.png)

### Project scope (`.dsh/mcp.json`)

![Project MCP](docs/images/mcp-manager-workspace.png)

### Connection details and adding a server

![MCP connection details](docs/images/mcp-manager-detail.png)

![Add MCP](docs/images/mcp-manager-add.png)

## Features (MCP board)

- Inspect every MCP server's status, transport, connection parameters, and tool list; expand a tool to see its full input JSON Schema (required/optional, types, enums, defaults, raw JSON)
- Filter by transport (HTTP/stdio) and status, search by name/command/URL
- Enable, disable, reconnect, add, edit, remove; reveal masked credentials temporarily with the eye button and copy with one click
- **Global + project scopes**: global servers live in the Web profile and are available to every project; project servers live in that project's `.dsh/mcp.json` and are visible only to its sessions. A project can also hide any global MCP
- **Two entry points, one panel**: the draggable floating button (position remembered) and the official sidebar entry share the same state; the "Entry" control in the panel header can keep just one of them (never neither)
- **MCP market**: 47 services across 10 categories, each verified against first-party sources. Search-first, with category and "keyless only" filters, sorting, and one-click install from the card. Already-configured entries are detected and skipped, never overwritten
- **WB Market (direct installs)**: a third board tab with two markets in one place —
  - **Connectors (MCP)**: reads the official WorkBuddy distribution ZIP (`static.workbuddy.cn`, the same source the WorkBuddy desktop app uses) on demand — 316 connectors, 242 installable (mostly streamable-http), while 74 CLI-based or WorkBuddy-token-dependent ones are honestly labeled "view only" with the reason. Installing = merging the connector's `mcpServers` into your MCP config through the same pipeline as "Import JSON" (admission, duplicate skip, entry-id reservation), in either global or project scope. The ZIP is ETag-cached under `~/.dsh/wb-market/` and decompressed with Node's built-in zlib — **zero new runtime dependencies**
  - **Skills (SkillHub)**: reads the public SkillHub API (`api.skillhub.cn`, 190k+ skills) with keyword search, four sort orders, and pagination; details include publisher verification and security-scan status. Installing = downloading file-by-file, verifying each against the manifest's sha256, and writing into `~/.agents/skills/` (the same discovery scope as the official skill subsystem) — effective immediately. Installed skills show an "installed" badge, support one-click uninstall, and reinstalling updates them
  - Skills belong to their respective authors. Both upstreams are third-party interfaces whose fields may change; the panel carries a persistent note saying so
- Import MCP configuration from other clients installed on this machine: Claude Code, Codex (`config.toml`), OpenCode (including `.jsonc`), pi, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI, Roo Code, and the cross-tool shared config. Everything is previewed before writing, with "merge" and "replace" modes
- Follows the DSH dark/light theme and adapts to narrow/mobile widths
- Update notice and **one-click upgrade**: a dismissible banner when a newer release exists (at most one check per day; disable with `DSH_MCP_MANAGER_DISABLE_UPDATE_CHECK`). Nothing happens until you press Upgrade — it **never auto-updates**
- **What changed, said once**: after the version changes, the first time you open the panel a small card lists what's new; confirming it never shows it again, and it uses no network and sends nothing

## Install

```sh
# Install from GitHub (this fork's release channel)
dsh plugin --profile web add github:2026heshao/dsh-skill-mcp-board

# The upstream npm package (MCP panel only, no Skill board)
dsh plugin --profile web add dsh-mcp-manager-ui@^1.5.0
```

Then **restart `dsh web`**. To upgrade (GitHub installs: re-add with a new tag):

```sh
dsh plugin --profile web update dsh-skill-mcp-board
```

To uninstall (your configured MCP entries stay in place):

```sh
dsh plugin --profile web remove dsh-skill-mcp-board
```

Details, local development installs, and troubleshooting: [docs/installation.md](docs/installation.md) (Chinese).

> Do not add `skill-mcp-board` to the profile's `cordis.patch.yml`, an agent preset, or an extra `--patch` file by hand — the plugin command already does that, and duplicating it fails loudly on purpose.

## Usage

### Opening the panel

Two entry points, one panel:

- **Floating button (bottom-right)**: draggable, position remembered;
- **Sidebar entry at the bottom**: above "Settings" when expanded, icon-only in the 56px rail.

The panel floats above the session; closing it ("Close" or Esc) does not affect the conversation.

### Global vs project

Tabs switch between "Global" and each project:

| Tab | Stored in | Visible to | When changes take effect |
|---|---|---|---|
| Global | The Web profile's `cordis.patch.yml` | every project | DSH hot-reloads, usually immediately |
| A project | That project's `.dsh/mcp.json` | only that project's sessions | as soon as it is written |

`serverName` is scoped: different projects, and global vs project, **may reuse the same name** with independent connections; duplicates inside one scope are rejected.

### Adding a server

Three ways, all from the panel toolbar:

1. **Add MCP**: fill in `command`/`args`/`env`/`cwd` (stdio) or `url`/`headers` (HTTP), with presets for common servers.
2. **Import JSON**: paste another client's configuration, preview, then write. "Merge (update by name)" and "replace" modes; field mapping and limits in [docs/json-import.md](docs/json-import.md) (Chinese).
3. **Built-in MCP**: tick the servers you want (Exa, Tavily, Firecrawl, Chrome DevTools, Playwright). The first three work without a key and need no local dependencies; the last two are local tools requiring Node.js and a browser.

### Tools and credentials

The detail pane lists the tools a server currently registers; expand one for its full input schema. Credential fields are masked by default — the eye button asks the Host for the **effective runtime value** and shows it temporarily, with one-click copy. If you do not actually edit a field, saving keeps the original reference instead of writing secrets back into the configuration file.

## FAQ

**The panel says a server is "disabled", but the model reports `unknown tool "mcp__xxx__..."`.**
That server is disabled, so it registers no tools. Enable it in the panel.

**How do I upgrade? Why did the panel not notify me?**
GitHub tag-pinned installs never cross versions — re-add with the new tag (`github:2026heshao/dsh-skill-mcp-board#v1.6.0`). The banner only queries this repo's GitHub Releases, at most once a day, is dismissible, and never acts on its own.

**Will editing touch my other configuration?**
No. Global edits only rewrite the entries declared by `@deepseek-ai/dsh-mcp-client` that this plugin manages, preserving other plugin rows, comments, and `!!js` expressions.

**Does uninstalling remove my configured MCPs?**
No. Uninstalling the plugin leaves existing `@deepseek-ai/dsh-mcp-client` rows in the profile untouched.

## Compatibility

| Item | Verified |
|---|---|
| DeepSeek Harness | `0.1.5-rc.1` and above (verified through `0.2.0-rc.2`) |
| Node.js | whatever runtime DSH ships/supports |
| Platform | Windows; Linux/macOS share the same DSH Web contracts |

## Documentation

- [Installation and upgrades](docs/installation.md) (Chinese)
- [JSON import](docs/json-import.md) (Chinese)
- [Design and limits](docs/design.md) (Chinese)
- [MCP market design](docs/mcp-market-design.md) (Chinese)
- [Official DeepSeek Harness plugin publishing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)

## Links

- [LINUX DO](https://linux.do/)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [GitHub `dsh-plugin` topic](https://github.com/topics/dsh-plugin)

## License

MIT
