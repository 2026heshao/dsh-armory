# dsh-armory — Armory

[中文](README.md) | English

> **The all-in-one control board for DeepSeek Harness**: MCP servers · Skills · Experts · Plugins · tool-usage ledger · four markets (WorkBuddy connectors ×316 / curated built-ins ×47 / SkillHub skills ×190k+ / WorkBuddy experts ×429, plus CodeBuddy official plugins and the DSH community list), with browsing, search, one-click install and one-click summon.
> This project is a fork of [Imzl-zl/dsh-mcp-manager-ui](https://github.com/Imzl-zl/dsh-mcp-manager-ui) (MIT, the original covered MCP only); this repo is [2026heshao/dsh-armory](https://github.com/2026heshao/dsh-armory),
> upgraded from a pure MCP panel into a **MCP + Skills + Experts + Plugins + Markets + Tool Tailor** board.
>
> **New in v2.0.0**: a Plugins page with three sources, one-click MCP OAuth authorization, credential prompts before install, an install-state ledger, and six categories for the skill board. See the [changelog](.github/release-notes/v2.0.0.md).
> **New in v2.1.0**: community plugins now render their README in place (fetched on demand, cached to disk for 7 days, `javascript:` pseudo-links downgraded to plain text), and two long-standing traps are fixed — the instant-open snapshot no longer shadows the real list, and update probing no longer reports failures on machines where the primary source is unreachable. See the [changelog](.github/release-notes/v2.1.0.md).

<p align="center">
  <a href="https://github.com/2026heshao/dsh-armory/stargazers"><img src="https://img.shields.io/github/stars/2026heshao/dsh-armory?style=social" alt="stars"></a>
  <a href="https://github.com/2026heshao/dsh-armory/releases"><img src="https://img.shields.io/github/v/release/2026heshao/dsh-armory?label=release" alt="release"></a>
  <a href="https://www.npmjs.com/package/dsh-armory"><img src="https://img.shields.io/npm/dt/dsh-armory?label=npm%20downloads" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a>
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.1-blue" alt="DSH">
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-8b5cf6" alt="topic: dsh-plugin"></a>
</p>

## Install in one line

```sh
# npm (recommended: no build-approval step, ready to use)
dsh plugin --profile web add dsh-armory

# GitHub
dsh plugin --profile web add github:2026heshao/dsh-armory
```

Restart DSH, then open **Skills · MCP · Experts** from the global panel list at the top of the sidebar (or the floating button bottom-right). Desktop users on the `desktop` profile: swap `--profile web` for `--profile desktop`.

## What it solves

| Pain point | How this plugin helps |
|---|---|
| MCP config means hand-editing YAML with no feedback on whether it connects | Visual panel: status, tool schemas, enable/disable, reconnect — global & per-project scopes, project changes apply to live sessions instantly |
| Installing skills means hunting for `SKILL.md` repos everywhere | **Direct markets**: SkillHub (190k+ skills), WorkBuddy connectors (316), 47 first-party-verified built-ins — search, filter, one-click install with per-file sha256 verification |
| Every MCP's tool descriptions eat context tokens; zero-use tools sit there for free | **Tool Tailor**: scans local session logs for call counts / errors / latency per tool; prune dead tools with one click |
| Migrating from Claude/Cursor/VS Code means copying config by hand | Detects local configs from 11 clients and imports them with a preview |
| OAuth-protected or key-protected servers and plugins just fail, with no hint why | **Plugin market** (CodeBuddy official + DSH community list) with per-entry source and installability, **one-click MCP OAuth** (RFC 9728 → 8414 → 7591 → 7636 PKCE → 8707, three callback fallbacks ending at "paste a token"), and a **credential prompt before install** that fills `${...}` placeholders so the server works on first connect |


A **unified board** for DeepSeek Harness (Web and desktop): six top-level tabs — **MCP**, **Skill**, **Expert**, **Plugins**, **Tool Tailor** and **Market** — reachable from the global panel list at the top of the sidebar or the floating button. The panel floats above the session — **it never interrupts an ongoing conversation**.

| Tab | Manages |
|---|---|
| **MCP** | MCP servers: connection status, tool list, enable/disable, import, market install |
| **Skill** | Skills: enable/disable of `SKILL.md` folders, source directories, session audit scan, six categories (dev / design & creative / docs & office / productivity / ops / uncategorised), grid or list view |
| **Expert** | WorkBuddy expert directory (429 experts / 15 industries, including 53 expert **teams**): browse, search, and "summon" one into a new session as an independent agent preset. Team experts summon with their full roster — member personas are materialised locally and the lead is handed a runtime bridge that maps WorkBuddy's `TeamCreate` / `Agent(name=…)` onto DSH's `subagent` |
| **Plugins** | Three sources in one searchable directory: DSH built-ins (shipped with the host, display-only), CodeBuddy official (ZIP distribution, manifest parsed from `marketplace.json` / `plugin.json`), DSH community (`awesome-dsh-plugins`). Install goes through the host's `pluginManager.installBundle` and **needs a host restart to take effect** |
| **Tool Tailor** | Per-tool call counts, error rates, latency and context-token cost from local session logs; dead tools shown inline and prunable. Shows **all tools with their real call counts by default** — toggle "zero-call only (N)" to narrow. A persistent "showing N/M tools" read-out makes the filter state unmistakable |
| **Market** | Four sub-tabs: WorkBuddy connectors (316), curated built-ins (47), SkillHub skills (190k+), WorkBuddy experts (429) — browse, search, one-click install. Installed state is remembered across pages in `~/.dsh/armory/install-state.json` |

> The Skill panel reads DSH's custom skill directory (default `~/.agents/skills`): each skill is a folder with a `SKILL.md`,
> whose frontmatter declares the invocation policy (`disable-model-invocation` / `user-invocable`).
> User-invocable skills automatically appear in the `/` command menu of the chat box.

## Screenshots

One shot per main board tab (captured on the Windows desktop app, light theme). The v2.0.0 Plugins page, the OAuth flow and the v2.1.0 README preview are not pictured yet:

### MCP — global board

Global / per-project scope tabs, inline enable/disable toggles; global and project servers may share a name while staying independent:

![MCP global board](docs/images/mcp-overview.png)

### MCP — connection details

Transport, connection parameters, call timeout and config source at a glance; below is the server's registered tool list (170 here — expand any row for its full input JSON Schema):

![MCP connection details](docs/images/mcp-detail.png)

### Tool Tailor — tool-usage ledger

Four metric cards for the 30-day window (total calls / tools seen / zero-call MCP tools / overall error rate), one row per tool with calls, errors, error rate, Schema context tax and last use, and a persistent tailor suggestion at the bottom. Shows all tools with real call counts by default; "zero-call only (N)" narrows the view:

![Tool Tailor ledger](docs/images/tool-ledger.png)

### Experts — summoned list

One card per summoned expert / expert team: bundled skills, details, dismiss; team experts expose a "roster" block in the detail dialog (each member's duty and persona file path):

![Experts panel](docs/images/experts.png)

### Market — three direct sources

Connectors (official WorkBuddy distribution, 316 entries; installable ones are labeled "install", CLI-based / token-dependent ones honestly show "view only" with the reason):

![WB connector market](docs/images/market-connectors.png)

Skills (public SkillHub API, 190k+ skills; search + sort + pagination, installed ones show an "installed" badge with one-click uninstall):

![SkillHub market cards](docs/images/market-skills.png)

Experts (WorkBuddy expert center, 429 experts / 15 industries; category filter + keyword search, "summon" straight from the card):

![Expert market cards](docs/images/market-experts.png)

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
- **Experts (direct, 1.9.0)** — a dedicated board tab (the sidebar entry is renamed **Skills · MCP · Experts**):
  - **Directory**: reads the official WorkBuddy expert center distribution (`expert_center.json`, 429 experts / 15 industries, ETag-cached under `~/.dsh/wb-market/experts/`) with category filter, keyword search, and a detail dialog (persona, bundled skills, sample prompts) before you summon
  - **Summoning** = appending one independent **agent preset** row to the profile patch (a `@deepseek-ai/dsh-agent-preset` entry that mirrors the built-in `standard` preset, with only the persona prefix swapped for the expert's full persona). New sessions then offer **WorkBuddy Expert · …** and that expert takes over the session, while the standard tools / planning / compaction / delegation stay intact. Multiple experts coexist; writes go through the existing patch pipeline (file lock + version check + atomic write), preserving other rows, comments and `!!js` expressions
  - **Bundled skills**: tick to install them too — a full local WorkBuddy cache (`~/.workbuddy/plugins/cache/experts/`) is copied wholesale into `~/.agents/skills/` (prefixed `wbexpert__`, discovered by the skill registry immediately); without a cache it falls back to the CDN's single `SKILL.md` and labels the source honestly
  - **Team experts (summonable since 1.9.4)**: WorkBuddy's 53 "expert teams" assume `TeamCreate` and `Agent(name=…)`, neither of which DSH has. Summoning now also writes one file per member persona under `~/.dsh/wb-market/experts/teams/<expert>/`, and appends a **runtime adaptation** block to the lead's persona: creating the team becomes a no-op (the roster is fixed at summon time); dispatching a member becomes `subagent` (after `read`-ing that member's persona into the prompt), with sequential SOPs passing `run_in_background: false` so the lead waits for the result; follow-ups use `send_message`. The original rules — never ghost-write a member's output, never connect members directly, everything relayed through the lead — are preserved verbatim. Member personas stay **out of the system prompt** (otherwise every turn would pay for all five), and are read only when dispatching
  - **Dismissing** removes that preset, its skill directory and the team member personas (hot-reloaded, no restart)
- **Summon menu (in-session quick access, enhanced in 1.9.3)** — the small board icon at the right of the composer toolbar opens three categories (**Skills / MCP / Experts**); hovering a category expands its submenu, and clicking an entry writes a reference into the composer (skills = `/skill-name`, MCP = names the `mcp__server__*` tools, experts = attaches to the current session):
  - **Six rows per screen, scrollable**: a submenu shows six entries at a time and scrolls for the rest (thin themed scrollbar), while the **Manage skills / MCP / experts…** button stays pinned to the bottom instead of scrolling away
  - **Most-recently-used first**: entries you just used float to the top with a "recent" badge, the rest keep their original order; the recency pool holds 40 entries
  - **Experts attach / swap / detach at any time**: click one to take over the current session (including one already mid-conversation), click another to replace it, click the chip's × to drop it. It affects **only that session** — no tool catalog changes, nothing persisted
  - **What you see is what's active**: once an expert is attached, the session header shows the expert that is **actually in effect** (the host's "preset chosen at session creation" label steps aside while an expert is attached); the header badge, the composer chip and the menu stay in sync within the same frame after attach / swap / detach
- **Plugins page (new in 2.0.0)**: three sources in one searchable, filterable directory, each entry labelled with its source and whether it can be installed —
  - **Built-in**: components shipped with the DSH host; display-only
  - **CodeBuddy official**: ZIP distribution, manifests parsed from `.codebuddy-plugin/marketplace.json` and `external_plugins/<name>/.codebuddy-plugin/plugin.json` (`MAX_ZIP_BYTES = 64MB`, ETag-cached)
  - **DSH community**: the `awesome-dsh-plugins` list (a single bare-JSON file, 5000+ entries, jsdelivr primary → fastly fallback), slimmed to `SLIM_MAX_BYTES = 3MB` before caching
  - **Installing** goes through the host's `pluginManager.installBundle`, and **the host must be restarted** for the plugin to load. A missing `pluginManager`, an entry with no npm package name, and an entry with no repository each produce a specific message instead of failing silently
- **One-click MCP OAuth (new in 2.0.0)**: `@deepseek-ai/dsh-mcp-client` accepts only `requestInit.headers` and has no authProvider, so OAuth has to complete **before** install — this plugin runs the flow and writes `authorization: Bearer <token>` into the patch headers, then refreshes it —
  - Implements **RFC 9728** (protected-resource metadata) → **RFC 8414** (authorization-server metadata) → **RFC 7591** (dynamic client registration) → **RFC 7636 PKCE** (S256 only) → **RFC 8707** (`resource` parameter)
  - **Three callback fallbacks**: a local `127.0.0.1:<random port>/callback` captures the code automatically (the common case) → when the registered client only accepts a custom scheme, it asks for the full callback URL to be pasted → otherwise it falls back to "paste an access token"
  - A 401 from the server pops the "Authorize {server}" dialog and opens the browser for you
- **Credential prompts before install (new in 2.0.0)**: scans `mcpServers` for `${...}` placeholders, opens "Fill in {connector}'s credentials", and installs with them; leaving a field blank means "I'll do it later" and the panel says "N placeholders left as-is". Connectors with no placeholders install straight through
- **Install-state ledger (new in 2.0.0)**: `~/.dsh/armory/install-state.json` (`INSTALL_STATE_VERSION = 1`) records each connector / skill / plugin's `source {marketplace, url, kind}`, so the market can filter installed entries **across pages** and distinguishes "installed by this plugin" from "configured by hand elsewhere". A failed registration never blocks the install
- **Skill board categories (new in 2.0.0)**: skills are grouped into **dev / design & creation / docs & office / productivity & automation / ops / uncategorised**, with grid and list views, a category filter and a persistent "showing N/M skills" line. Details add the category, source directory and file location, with one-click "copy SKILL.md path" and "copy @session reference". The board stays read-only (the host only exposes `listSkills` / `skillDetail`)
- **Marketplace registry (new in 2.0.0)**: market sources are no longer hard-coded — they live in `~/.dsh/armory/marketplaces.json` (`REGISTRY_VERSION = 1`), fall back to the built-in defaults when missing or corrupt, persist on first read, and can be added / edited / removed. Writes are staging + atomic rename
- **Instant community list (new in 2.0.0)**: the last successful slim list is mirrored into `localStorage` (7 days / 4MB cap, older snapshot kept on quota errors), so the first paint renders the snapshot before the real result silently replaces it (zero network, zero IPC). When no source is reachable it says "showing the local cache" instead of an empty list
- **Community README preview (new in 2.1.0)**: click any card under Plugins → DSH community and the plugin fetches and renders that repository's README in place (headings, paragraphs, lists, tables, code blocks, quotes, and `<p align="center"><img …>` banners) —
  - **On demand, fetched once**: the README is deliberately kept out of the slim directory cache and only fetched when you open a card; it tries `README.md` / `readme.md` / `Readme.md` / `README.MD` / `README.markdown` / `README_EN.md` in that order, and when the repository field holds an npm package name it asks `registry.npmjs.org` for `repository` first, then fetches the raw text from GitHub
  - **Limits and cache**: 20s per fetch, 160k characters of body (truncated and labelled when longer); successful reads are cached to disk per repository / npm name for 7 days, so reopening the same plugin is instant, and when the network is down / rate-limited / the repository is gone it falls back to the cache and says so
  - **Images and safety**: `http(s)` images go through the read-only `wsrv.nl` proxy (`output=webp&q=72&w=880`, allow-listed hosts only); relative paths are resolved against the repository URL and skipped when they cannot be; the body is turned into React elements by a small hand-written parser — **never `dangerouslySetInnerHTML`** — and `javascript:` / `data:` / `vbscript:` pseudo-links are downgraded to plain text
- **Community directory and update-probe fixes (2.1.0)**: the instant-open snapshot no longer shadows the real list (previously the real result was dropped once the snapshot painted, leaving the directory stuck on the old snapshot), and update probing now follows the same source chain as the directory itself (it asks the source the cache actually came from, then falls back to the others, first ETag wins) — fixing the "directory opens but every update check says `probe-failed`" trap on machines where the primary source is unreachable
- Import MCP configuration from other clients installed on this machine: Claude Code, Codex (`config.toml`), OpenCode (including `.jsonc`), pi, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI, Roo Code, and the cross-tool shared config. Everything is previewed before writing, with "merge" and "replace" modes
- Follows the DSH dark/light theme and adapts to narrow/mobile widths
- Update notice and **one-click upgrade**: a dismissible banner when a newer release exists (at most one check per day; disable with `DSH_ARMORY_DISABLE_UPDATE_CHECK`). Nothing happens until you press Upgrade — it **never auto-updates**; the upgrade itself is executed by DSH's official pluginManager, which handles version checks and rollback. Local dev copies installed via `link:` / `file:` / `github:` get no button (it would replace your link with an npm package)
- **What changed, said once**: after the version changes, the first time you open the panel a small card lists what's new; confirming it never shows it again, and it uses no network and sends nothing

## Install (details)

```sh
# npm (recommended)
dsh plugin --profile web add dsh-armory

# GitHub
dsh plugin --profile web add github:2026heshao/dsh-armory
```

Then **restart DSH** (restart the desktop app, or `dsh web` for the browser GUI; desktop users: swap `--profile web` for `--profile desktop`). To upgrade: npm installs can click the in-panel upgrade banner; GitHub installs re-add with a new tag:

```sh
dsh plugin --profile web update dsh-armory
```

To uninstall (your configured MCP entries stay in place):

```sh
dsh plugin --profile web remove dsh-armory
```

Details, local development installs, and troubleshooting: [docs/installation.md](docs/installation.md) (Chinese).

> Do not add `dsh-armory` to the profile's `cordis.patch.yml`, an agent preset, or an extra `--patch` file by hand — the plugin command already does that, and duplicating it fails loudly on purpose.

## Usage

### Opening the panel

Two entry points, one panel:

- **Floating button (bottom-right)**: draggable, position remembered;
- **Sidebar entry "Skills · MCP · Experts"**: above "Settings" when expanded, icon-only in the 56px rail.

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
GitHub tag-pinned installs never cross versions — re-add with the new tag (`github:2026heshao/dsh-armory#v1.9.0`). The banner only queries this repo's GitHub Releases, at most once a day, is dismissible, and never acts on its own.

**Will editing touch my other configuration?**
No. Global edits only rewrite the entries declared by `@deepseek-ai/dsh-mcp-client` that this plugin manages, preserving other plugin rows, comments, and `!!js` expressions.

**Does uninstalling remove my configured MCPs?**
No. Uninstalling the plugin leaves existing `@deepseek-ai/dsh-mcp-client` rows in the profile untouched.

## Compatibility

| Item | Verified |
|---|---|
| DeepSeek Harness | `0.1.5-rc.1` and above (verified through `0.2.1-rc.2`, DSH 44.7.0) |
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
