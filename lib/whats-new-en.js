// en-US overlay for the in-app update notes (lib/whats-new.js).
//
// The Chinese list is the content source of truth and the release contract is
// pinned to it (last version == package.json, release notes must exist). This
// file only adds translations, keyed by version and item index, so the source
// list keeps its append-only order and release tests stay untouched.
//
// The host sends both languages in `whatsNew`; the client selects by locale and
// falls back to Chinese item by item. `test/whats-new-i18n.mjs` enforces that
// every version and item here has a translation with no CJK characters, so a
// newly appended release cannot ship with a missing English note.
//
// Keep Markdown (**bold**, `code`, ~/ paths) intact; only prose is translated.
export const WHATS_NEW_EN = {
  '1.3.0': [
    {
      text: 'New "Entry visibility" switch: keep just one of the floating button and the sidebar entry',
      where: '"Entry" at the top right of the panel',
    },
    {
      text: 'Fixed a DSH 0.1.6-alpha.2 issue where a typert codec contract change prevented the panel from opening at all',
    },
  ],
  '1.4.0': [
    {
      text: 'New "Import from local clients": automatically detects Claude Code, Codex, OpenCode (including .jsonc), pi, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI, Roo Code, and cross-tool shared configs; click one to import. Read-only, and secrets from the source are never sent to the browser',
      where: 'Panel -> "Import MCP"',
    },
    {
      text: 'Fixed an import bug that could prevent the host from starting: unset `${VAR}` variables no longer evaluate to undefined (which made the whole plugin tree fail to load and the panel unopenable)',
    },
    {
      text: 'Duplicate MCP names no longer fail an entire import batch: only the conflicting entry is skipped, and the preview and results say which one (previously it could write config the host could not load, or silently drop an entry from a project file)',
      where: 'Import preview -> "Hints"',
    },
    {
      text: 'Codex http_headers / env_http_headers / bearer_token_env_var placed on a mismatched transport now produce per-entry warnings instead of being silently dropped',
    },
  ],
  '1.4.1': [
    {
      text: 'Fixed collapsed project tabs ("...N") that could not be opened or selected: the popover was rendered inside the horizontally scrolling tab strip and was clipped to zero height, making collapsed projects unclickable; it now renders outside the strip',
      where: 'Project tabs at the top of the panel',
    },
    {
      text: 'Compatibility verified through DSH `0.2.0-rc.2` (including real-device checks for panel rendering, project-scope writes, and built-in MCP installation)',
    },
  ],
  '1.4.2': [
    {
      text: 'Fixed 1.4.1\'s "visible but overflowing" collapsed-project popover: rows reused the tab chip box model (content-box plus its own padding/margin), making each row wider than the popover and pushing it past the right edge; now uses border-box',
      where: 'Project tabs at the top of the panel -> "...N"',
    },
  ],
  '1.5.0': [
    {
      text: '"Built-in MCP" became the **MCP market**: 47 services in 10 categories, each verified hands-on (the package exists and starts). Search is the primary action, with category filters, sorting, and "keyless only"; cards install directly instead of select-then-confirm',
      where: 'Market at the top of the panel',
    },
    {
      text: 'New "Security & Reverse Engineering" category: JS Hook, IDA Pro, Frida, and similar reverse-engineering / dynamic instrumentation tools used to be mixed into Developer Tools and required scrolling the whole category',
      where: 'Market -> "Security & Reverse Engineering"',
    },
    {
      text: 'Every card now states what you need up front: a key, connection details (Redis / ClickHouse HOST/PORT are not secrets), post-install parameter edits (entries with `<placeholders>`), and the free quota where applicable',
      where: 'Badges on market cards',
    },
    {
      text: 'Credentials never enter the browser: the market only carries variable names; values stay in the host configuration',
    },
    {
      text: '**One-click upgrade**: when a new version is shown at the top of the panel, click "Upgrade" to install it without running `dsh plugin update`. The official DSH pluginManager performs the upgrade (and restores config on failure); restart the host afterwards to apply it',
      where: 'Update notice at the top of the panel',
    },
    {
      text: '**Project-level MCP changes take effect immediately**: additions attach to running sessions, removals detach tools, and config edits reload connections in place, with no need to restart sessions or the host (previously you had to wait for all sessions to end and the panel showed "pending")',
      where: 'This project tab',
    },
    {
      text: 'Project connections are no longer torn down when sessions end: the last session keeps the connection for 5 minutes (`idleTimeoutMs` configurable, `0` = never reap) and the next session reuses it; new sessions see project tools on the **first turn**',
      where: 'Row status in the This project tab',
    },
    {
      text: 'Project MCPs gained a "Reconnect" button: once mcp-client exhausts reconnects it unregisters tools and stops; previously only a config reload or host restart recovered it. Now one click tears down and recreates the connection (the next session mount also rebuilds it automatically)',
      where: 'Project MCP details page',
    },
    {
      text: 'Project row status no longer compresses "is it connected" and "how many sessions use it" into one line: `Connected - no active sessions (connection kept, ready for next use)` and `Connected - N sessions active` are shown separately; the misleading "waiting for session mount" and "config pending" labels are gone',
      where: 'Secondary text on rows in the This project tab',
    },
  ],
  '1.6.0': [
    {
      text: 'Entry moved to the top-left: the sidebar global panel now includes "Skills - MCP - Experts" next to "Plugins"; click it to switch pages like switching chats instead of opening an overlay. The bottom-right floating button and sidebar-bottom entry remain and also switch pages',
      where: 'Global panel at the top of the sidebar',
    },
    {
      text: 'Unified Skill + MCP board: a new Skill category groups all local skills by source (project / user / custom / bundled with DSH) with descriptions, when-to-use guidance, invocation policy, and full instructions',
      where: 'Skill at the top of the board',
    },
    {
      text: 'Skill details can open the containing directory (read-only reveal through the host file manager); when the skill registry is absent it says so instead of failing',
      where: 'Skill details -> "Open directory" at the top right',
    },
    {
      text: 'All MCP capabilities (market, import, project scope, one-click upgrade, update notice) are unchanged; only the host location moved from an overlay to a main panel page',
    },
  ],
  '1.7.0': [
    {
      text: 'New "Tool Tailor": scans local session logs and reports per-tool calls, error rate, and last use over the past 7/30/90 days, plus an estimate of the context tokens each tool schema costs per request. Every installed MCP adds its tool descriptions to every request, so unused tools are pure context tax',
      where: 'Tool Tailor at the top of the board',
    },
    {
      text: 'Dead-tool list with one-click trimming: MCP tools with zero calls in the window are flagged, and the row can disable/enable the owning server (through the official write path, reversible at any time); tool names are annotated with their MCP server',
      where: 'Table rows on the Tool Tailor page',
    },
    {
      text: 'The ledger is read-only and contains no conversation content: it parses only tool/call and tool/result counts and pairing, never config or message bodies; multi-frame zstd logs are parsed frame by frame (a damaged frame is skipped without stopping)',
    },
  ],
  '1.8.0': [
    {
      text: 'New "WB Market": direct access to the official WorkBuddy connector market (static.workbuddy.cn, 316 connectors) and the SkillHub skill market (api.skillhub.cn, 190k+ skills) for browsing, search, details, and one-click install',
      where: 'WB Market at the top of the board',
    },
    {
      text: 'Installing a connector merges its mcpServers into the MCP config (same path as Import JSON: admission, duplicate skipping, and entry-id reservation). 74 CLI-only connectors or those needing WorkBuddy token injection are marked "display only" with the reason',
      where: 'Connector card -> "Install"',
    },
    {
      text: 'Installing a skill downloads each file, verifies sha256, and writes it under ~/.agents/skills/ (the same discovery scope as the official skill subsystem), effective immediately; installed cards show "Installed" with one-click uninstall, and reinstalling updates',
      where: 'Skill card -> "Install / Uninstall"',
    },
    {
      text: 'Connector ZIPs are cached under ~/.dsh/wb-market/ by ETag, so an unchanged upstream does not re-download 24 MB; ZIP extraction uses Node built-in zlib (no new runtime dependencies)',
    },
    {
      text: 'Market pages merged: the old "MCP market" dialog retired and the 47-item built-in MCP catalog became the third market tab, "Built-in MCP" (search / category / keyless-only, one-click install). The MCP page header is now "MCP" and its "Market" button is gone; the board "Market" tab now combines connectors, built-in MCPs, and skills',
      where: 'Market -> "Built-in MCP" tab at the top of the board',
    },
  ],
  '1.8.1': [
    {
      text: 'The Market tab now has three sub-pages (Connectors / Built-in MCP / Skills): the 47 verified built-in MCPs moved from a dialog into the market page with category and keyless-only filters; connectors (316) and skills (190k+) support search, sort, and paging, and detail dialogs show publisher verification and security scan status',
      where: 'Market at the top of the board',
    },
  ],
  '1.8.2': [
    {
      text: 'Market search box redesigned: pill shape, inset magnifier, focus highlight, and one-click clear. Fixed two skill-search defects: the "Search" button did nothing (it was type=button and did not submit the form) and typing did not apply until Enter; it now searches as you type (550ms debounce), Enter searches immediately, and clearing restores the full list',
      where: 'Search box on the Market page',
    },
  ],
  '1.9.0': [
    {
      text: 'Expert direct connect (aligned with the WorkBuddy Expert Center): the board adds an "Experts" category that reads the official WorkBuddy Expert Center distribution (429 experts / 15 industry categories, ETag-cached). "Summon" writes an agent preset into the profile patch (persona = the full expert persona; standard tools unchanged) - choose "WorkBuddy Expert - ..." when creating a session and the expert takes over; multiple experts coexist. "Return" removes the preset (hot reload, no restart)',
      where: 'Experts category at the top of the board',
    },
    {
      text: 'Summon can also install bundled skills: if the local WorkBuddy cache has the full skill tree, copy it recursively (discovered immediately by the skill registry); otherwise fall back to the single SKILL.md and say so. Skill directories use the wbexpert__ prefix and are cleaned up on return',
      where: 'Checkbox in the expert details dialog',
    },
    {
      text: 'Sidebar entry renamed "Skills - MCP - Experts"; the market no longer embeds an Experts sub-tab (Experts is now a top-level board category)',
      where: 'Sidebar bottom entry / global panel row',
    },
    {
      text: 'Composer summon menu: clicking a category opens its submenu (without navigating); clicking an entry inserts the reference at the caret, and "Manage..." sits at the bottom. Fixed field misalignment in the MCP list. Menu and submenu fade/slide in over 120ms (opacity/transform only, respects reduced-motion) to remove the flash; submenus are vertically centered on the anchor row and flip at viewport edges. Submenu order puts recently used entries first (marked "Recent", newest first) and keeps the rest in their original order. Reference semantics fixed: skills use /name slash references (actually invoke the skill instead of being treated as a file and failing with "file not found"); MCP uses the mcp__server__* tool prefix',
      where: 'Board icon at the right of the composer toolbar',
    },
    {
      text: 'Expert market gained paging (60/page, same as connectors) and fixed "missing experts": searches now match the whole library instead of being swallowed by the selected category (testing found only 1 result under a category where the full library had 42)',
      where: 'Market -> Experts (Summon) tab',
    },
    {
      text: 'Fixed Tool Tailor being completely unusable: the host method existed all along, but the Remote contract was missing on both client and host, so panel calls always returned 404. With the contract restored the ledger works immediately (tested: 11 sessions / 2,313 calls / 400ms). Board category order adjusted: Tool Tailor now sits to the right of Experts',
      where: 'Tool Tailor at the top of the board',
    },
    {
      text: 'Expert summon upgraded to WorkBuddy-style "mounting": clicking an expert in the menu mounts it to the current session (via official agentPresets.select; effective immediately in a blank session, with the expert persona taking over the whole session), and an expert chip appears above the composer (mount state plus one-click removal back to the default preset). If the session has already started, the UI clearly says it will apply to a new session',
      where: 'Composer summon menu -> Experts',
    },
  ],
  '1.9.1': [
    {
      text: 'Fixed "Mount failed: Unknown agent preset": preset rows were written as bare entries at the top level of the patch, which the host interpreted as overriding an existing row and skipped entirely (so the preset was never registered). They now use the host insert directive and old-format rows are migrated automatically - the first panel open or summon after upgrading fixes it, and existing sessions keep working',
      where: 'Composer summon menu -> Experts',
    },
    {
      text: 'Experts now work in already-started sessions: the host does not allow changing presets mid-session, so the UI offers a one-click "New session with this expert" (create a new session -> mount the expert -> jump to it) instead of a dead end',
      where: 'Summon menu -> Experts -> button below the hint',
    },
    {
      text: 'Two summon-menu UX fixes: moving the mouse over "Skills" no longer closes the menu (open/close is owned by the whole menu, and the hint area is no longer misread as "leave"); the composer no longer jitters when the hint bar makes the menu taller (the menu is a viewport overlay and no longer expands the session scroll area)',
      where: 'Board icon at the right of the composer toolbar',
    },
    {
      text: 'Safer one-click upgrade: it used to decide "is this installed from npm?" from a field the host never returned, so users with local file:/link: installs would replace their development copy with the npm package. It now asks the host for the real install source from the profile; local and unknown sources only show a hint and never write',
      where: 'Update notice at the top of the panel',
    },
  ],
  '1.9.2': [
    {
      text: 'Experts upgraded to WorkBuddy-style "mount / switch / unmount anytime": any session, including one already in progress, can mount an expert, switch by clicking another, and unmount by clicking the chip X. No more "session already started, cannot mount" dead end, and a conversation is no longer limited to one reference',
      where: 'Board icon at the right of the composer toolbar -> Experts',
    },
    {
      text: 'Switching experts clearly says "replaced the previous expert"; after cancelling you can mount another expert again. Chip state reconciles with the host when the component remounts or the session changes, so it always reflects reality (experts mounted through the preset picker or other entry points included)',
      where: 'Expert chip and hint bar in the summon menu',
    },
  ],
  '1.9.3': [
    {
      text: 'Summon submenus for Skills / MCP / Experts now show **the full list with scrolling**: six rows per screen with a themed thin scrollbar; the "Manage skills/MCP/experts..." button stays pinned at the bottom. Previously only the first six of each type were listed, so a seventh skill was simply unreachable',
      where: 'Board icon at the right of the composer toolbar',
    },
    {
      text: 'Submenus are sorted by **recent use**: what you just used moves to the top with a "Recent" marker (first six), the rest keep their original order. The recent-use pool grows from 8 to 40 entries',
      where: 'Summon menu -> Skills / MCP / Experts',
    },
    {
      text: 'Fixed "after switching experts, the session header still shows the first one": the **preset label** in the header reflects session creation and does not change when the expert changes (the host is read-only). Once an expert is mounted, that label yields to a badge showing the **currently effective** expert, updated on every switch',
      where: 'Session title bar (after mounting an expert)',
    },
    {
      text: 'Fixed the "three places disagree" expert display: the preset label, composer chip, and session header each queried state separately, so a switch only appeared after a remount. They now update in the same frame, with a 5-second reconciliation fallback (covering experts mounted through the preset picker or elsewhere)',
      where: 'Session title bar + composer expert chip',
    },
    {
      text: 'Expert mounting no longer uses the "preset channel": that path wrote a **never-updated** expert name into the session projection, the root cause of "header shows A while B is active". It now uses the session-level persona channel - mount/switch/unmount anytime, with display and effect finally in sync',
      where: 'Summon menu -> Experts',
    },
  ],
  '1.9.4': [
    {
      text: '**Team experts can now be summoned**: 53 expert teams (software development team, content factory, etc.) used to show "team type, read-only for now"; clicking "Summon team" now works. Summoning writes the lead preset and also materializes each member persona into local files (`~/.dsh/wb-market/experts/teams/<expert>/`), all removed on return',
      where: 'Experts -> any card marked "Team"',
    },
    {
      text: 'The team lead **dispatches members automatically according to the roster**: WorkBuddy team personas rely on `TeamCreate` and `Agent(name=...)`, which DSH does not have. Summoning now appends a runtime adaptation that maps both to DSH `subagent` (member personas are read and embedded into the prompt) while keeping the original rules such as "never write member output for them" and "members do not talk directly"',
      where: 'Experts -> team details dialog ("Team roster" lists each member and role)',
    },
    {
      text: 'Member personas **do not count toward the system prompt**: putting five personas into the preset would charge context for them on every request. They are written to disk and read on demand by the lead; the preset still contains only the lead persona',
      where: '- (implementation detail affecting per-turn token cost)',
    },
    {
      text: 'Fixed "Tool Tailor reports zero calls for every tool": that was a filtering illusion - the table defaulted to "dead tools only", so every count on screen was 0. It now **shows all tools with real call counts by default**, shading zero-call rows; the button becomes "Zero-call only (N)" and is opt-in, and a persistent "Showing N/M tools" readout prevents mistaking the filter for broken detection',
      where: 'Tool Tailor tab',
    },
  ],
  '1.10.0': [
    {
      text: '**The English UI actually works now**: the `t()` framework had promised since 1.9.x that "translations can be merged into the dictionary without touching call sites", but the dictionary was empty. It now contains **720 keys**, covering all 685 Chinese source strings; language falls back through `localStorage["dsh-armory.locale"]` -> `navigator.language` -> `zh-CN`, so users whose host is English get an English panel. Also fixed `fmtInt` / `fmtTax` hard-coding `en-US` thousands separators',
      where: '- (follows the host language; set dsh-armory.locale in localStorage to force English)',
    },
    {
      text: '**Fixed "I chose sidebar-only, why did the floating button come back?"**: `whatsNew.seen` used to store a bare version string, so an upgrade cleared the whole key and the entry-visibility preference with it. Both preferences are now structured (`whatsNew.state` / `updateHint.state`) with fallback to the old bare keys (no state loss on upgrade); only the "show dialog" flag resets per version',
      where: 'Update dialog + update banner in the panel header',
    },
    {
      text: '**Connection diagnostics card**: a new section in server details lists connection state (including session slots), session reuse count, idle-reap countdown, last teardown duration (red on timeout), whether config changed, and duplicate project names - data from `projectConnections`, which was registered long ago but never called by the panel. When state is not ready, the card offers "Reconnect this server". Fetched on demand, not polled, with a refresh button',
      where: 'MCP -> Project scope -> any server details',
    },
    {
      text: '**Teardown residue is now visible**: to be clear, **this plugin does not spawn any MCP child processes** (zero hits for `SIGTERM` / `SIGKILL` / `taskkill` under `lib/`), so "the plugin kills the process tree itself" is architecturally impossible; that is the host mcp-client job. This release adds local observability: teardown duration and outcome are recorded (>5s = stuck, last 64 entries, expire after 10 minutes) and exposed through the existing `projectConnections` row as a `teardown` field, **with no new RPC**; an upstream proposal is in `docs/host-proposal-mcp-teardown.md`',
      where: '- (diagnostics appear in the "Last teardown" row of the connection diagnostics card)',
    },
    {
      text: '**VS Code configs with `${input:xxx}` no longer fail as a whole**: a single interactive input reference used to reject the entire file. Now each entry degrades individually - entries whose core fields (`url` / `command` / `cwd`) contain input go to an "unsupported" group with a reason (removing them would invent a guessed value, a silent error), while input in `env.*` / `headers.*` / `args` elements only drops that item with a warning and the entry remains importable. The preview dialog groups results by "importable / unsupported"',
      where: 'MCP -> Import -> Scan sources (VS Code config)',
    },
    {
      text: '**Three Tool Tailor improvements**: (1) a "Today" time window for checking same-day effects without switching to 7 days; (2) on Node < 22.15, zstd stats are all zero and looked like "no calls"; these now render as `-` (missing data), distinct from a real 0; (3) the panel adds a "Cache: x MB / 32 entries" line with a "Clear ledger cache" button, refreshing from the returned report without another scan',
      where: 'Tool Tailor tab',
    },
    {
      text: '**Expert details no longer stop at 4,000 characters**: the truncated persona now has "Expand full text (N characters) / Collapse", with the magic number promoted to `PERSONA_PREVIEW_MAX` (both summoned and market dialogs); quickPrompts over 3 get "Show all N / Collapse"; card descriptions truncated at 48 characters now have a `title` for hover',
      where: 'Experts -> any expert details dialog',
    },
    {
      text: '**Auth badges, page jumping, and a clear read-only board**: (1) the built-in MCP catalog has long carried `auth` / `authNote` metadata; badges are now colored by type - interactive authorization (OAuth / OAuth-or-PAT) in a warning color, key-only in neutral, `none` hidden; these are display metadata only and are never written to user config. (2) all three pagers now use the same `Pager` component with first/last and page-number jump plus a persistent "Page x / y - N items" count. (3) the skill board states up front that it is read-only: the host only provides `listSkills` / `skillDetail`; edit `SKILL.md` to change content',
      where: 'MCP -> Built-in catalog / Market connectors / Market skills; Skills tab',
    },
    {
      text: '**Four general UX improvements**: (1) a light skeleton on first load (shimmer disabled under `prefers-reduced-motion`) instead of a blank half-second that looks frozen; (2) `FAB_SIZE` / `FAB_EDGE` moved before the CSS and interpolated, eliminating "change one place, forget the other"; (3) all 9 `role="dialog"` surfaces use `useFocusTrap` - focus the first interactive element, Tab cycles inside, and focus is restored on close; (4) the crash panel adds "Copy error details" (`error.stack` + componentStack + time and locale) to make reporting easier',
      where: '- (anywhere in the panel; crash panel appears on error)',
    },
    {
      text: '**Tests grew from 13 suites to 18**, locking down contracts that were "promised in comments but untested": three-way contract consistency, import-source degradation shape, bidirectional i18n dictionary diff (the gap behind Chinese leaking into English UI), persona threshold, Tailor default window, copyable crash details, and teardown residue diagnostics. Every suite includes mutation self-tests proving the assertions are not vacuously true',
      where: '- (developer view: `npm test`)',
    },
  ],
  '2.0.0': [
    {
      text: '**A third market source: the Plugins page**: a new "Plugins" page combines three sources into one searchable, filterable catalog - **Official** (components bundled with the DSH host, not separately installable), **CodeBuddy Official** (ZIP distribution), and **DSH Community** (`awesome-dsh-plugins` list via jsdelivr CDN). Installation goes through the host `pluginManager`, and **a host restart is required**; if the host does not provide `pluginManager`, it reports an explicit error instead of pretending to succeed. Entries without an npm package name or repository say "installation not supported" / "display only" rather than guessing',
      where: 'Plugins page in the panel',
    },
    {
      text: '**Connectors that need a token now prompt during install**: before installing, `${...}` placeholders in `mcpServers` are detected and a "Credentials for {connector}" dialog asks for each slot; leaving one blank means you will fill it later, and after install it notes "N placeholders left blank, kept as-is in the config". Connectors without placeholders install directly',
      where: 'MCP market -> any connector with placeholders -> Install',
    },
    {
      text: '**One-click MCP OAuth**: remote MCPs previously only honored `requestInit.headers` and had no authProvider, so OAuth setups could not be installed without hand-crafting a token. The full flow now follows RFC 9728 / 8414 / 7591 / 7636 / 8707: protected-resource and authorization-server discovery -> dynamic client registration -> PKCE(S256) -> browser authorization -> code-for-token exchange -> write into patch headers, with automatic refresh. The callback path has **three fallbacks**: local loopback (most implementations), pasting the full callback URL when the server only accepts a custom scheme, or pasting a Bearer token',
      where: 'MCP market -> connector returning 401 -> Authorize',
    },
    {
      text: '**Install-state ledger + cross-page "Installed" filter**: new `~/.dsh/armory/install-state.json` records who installed each connector / skill / plugin and from which market; the market uses it to separate "installed by this plugin" from "installed elsewhere" and supports **cross-page** filtering of installed items (skills still filter the current page only, and the UI says so). A failed registration does not fail the install; it only adds "installed, but state registration failed"',
      where: 'Filters / installed counts at the top of each market page',
    },
    {
      text: '**The skill board categorizes skills**: skills are grouped into **Programming & Development / Design & Creation / Documents & Office / Productivity & Automation / DevOps / Uncategorized**, with grid and list views and category filtering; details add the category, source directory, and file location, plus one-click "Copy SKILL.md path" and "Copy @session reference"',
      where: 'Skills tab',
    },
    {
      text: '**Community catalog opens instantly**: the last successful community index is mirrored into browser `localStorage` (7 days / 4 MB, keeping the old snapshot if quota is exceeded); the first render uses the snapshot and is silently replaced by the live result - **zero network, zero IPC**. When the source is unreachable it explicitly says "catalog cache expired, showing local cache" instead of an empty list',
      where: 'Plugins -> DSH Community',
    },
    {
      text: '**Lightweight install toast + read-only injection rules**: installs show an overlay that survives panel unmount (plain DOM, `textContent` only, no `createPortal`, top 64px); connector details parse `auth_injection_rules` from `connectors.json` and mark connectors that rely on WB account "proxy injection" - **DSH does not proxy-inject; it only parses and displays**, and the boundary is stated in both code comments and UI',
      where: 'Any install action / MCP -> Connector details',
    },
    {
      text: '**Multi-market registry**: market sources are no longer hard-coded; they live in `~/.dsh/armory/marketplaces.json` (falls back to built-in defaults if missing or corrupt, written on first read) and can be added, edited, or removed; writes use staging + rename for atomic replacement',
      where: '- (`~/.dsh/armory/marketplaces.json`)',
    },
  ],
  '2.1.0': [
    {
      text: '**Community plugins now show READMEs**: clicking any card in DSH Community fetches that repository README and renders it as readable content (headings, paragraphs, lists, code blocks, tables, quotes) without leaving the app. Fetched once on demand (20s timeout / 160k character cap) and cached to disk by "repository or npm package name" for 7 days, so reopening is instant and works offline. Images use a read-only proxy to bypass hotlink protection; the renderer is custom and **never touches `dangerouslySetInnerHTML`**, and pseudo-protocol links such as `javascript:` degrade to plain text',
      where: 'Plugins -> DSH Community -> any card',
    },
    {
      text: '**Community catalog no longer gets stuck on an old snapshot**: the first render uses the localStorage snapshot (zero network, zero IPC), but the live catalog result must replace it. Previously the live result was dropped once the snapshot rendered, so the catalog stayed stale; now both paths feed the same state, giving instant open and fresh data',
      where: 'Plugins -> DSH Community',
    },
    {
      text: '**Fixed "update probe failed"**: the probe used to query only the primary source, so machines where the primary source was down but the catalog loaded from a backup saw repeated probe failures. The probe now follows the same source chain as the catalog - first ask which source the cache actually came from (ETags are comparable only from the same source), then fall back through the others; the first source that returns an ETag wins, and only total failure reports `probe-failed`',
      where: 'Plugins -> DSH Community -> Check for updates',
    },
  ],
  '2.2.0': [
    {
      text: '**Custom suites**: package frequently used skills into a suite; one click in the summon menu expands it into multiple `/name` references in your draft in member order. Create and edit under "Suites" in the Skill board toolbar: click + or drag skills in, reorder by dragging, and confirm deletion in place; saving replaces the whole collection and writes `~/.dsh/armory/suites.json` (staging + rename atomic write). Limits: 100 suites / 40 members each',
      where: 'Skills -> "Suites"; composer summon menu -> Skills -> suite group',
    },
    {
      text: '**Uninstall skills from the board**: skills in user-level or project-level directories can be uninstalled from details (in-place confirmation; permanent deletion, not Trash); skills bundled with DSH, runtime-registered, or in custom directories remain read-only. Uninstall uses this plugin `removeSkill` with source allow-listing, root containment, and symlink-only-link deletion checks',
      where: 'Skills -> any local skill -> Details',
    },
    {
      text: '**Instant refresh after install / uninstall**: after installing or uninstalling a skill in the market, the top **Skill** count badge and the skill board list update immediately without switching pages or reopening the panel; async refreshes carry sequence guards so rapid clicks cannot be rolled back by a stale response',
      where: 'Market <-> Skills',
    },
    {
      text: '**Tool Tailor gains a time dimension**: samples the tool list **actually sent** in `request/header` per day, computes the real wire tax, and reports "how many times the list changed in the window" and "last change time"; when it differs from the registry snapshot it says whether the change is "not taking effect" or "more tools are sent than registered". If local logs span less than the selected window or calls lack timestamps, the note says so',
      where: 'Tool Tailor -> tax trend below the metric cards',
    },
    {
      text: '**SkillHub "downloads" sorting no longer hangs**: upstream `sortBy=downloads` now accepts the request but never responds, so the plugin no longer sends it and instead sorts the current page locally by downloads; other sorts still go remote. Requests are abandoned after 15 seconds and Node English timeout is replaced with a clear message',
      where: 'Market -> Skills -> Sort',
    },
    {
      text: 'Tool Tailor ledger cache row is now read-only: removed the "Clear cache" button (testing showed it reclaimed no space, fixed nothing, and stayed at "Clearing cache..." forever)',
      where: 'Tool Tailor -> Ledger info',
    },
  ],
  '2.2.1': [
    {
      text: '**The UI now truly follows DSH**: switching the host to English under Settings -> General -> Language updates the sidebar entry, the five tabs, toolbar, forms, dialogs and update notices immediately - no restart, and no dependency on the OS locale. Precedence is explicit override -> host -> browser -> Chinese; locales such as `ja` / `de` / `fr` fall back to English until a translation exists, instead of showing Chinese to people who cannot read it',
      where: 'DSH Settings -> General -> Language',
    },
    {
      text: 'Release notes and the built-in MCP catalog are translated too: 20 versions / 84 update items, plus 47 built-in services and 10 categories. Missing translations fall back field by field to Chinese - never empty strings or `undefined`',
      where: 'Update notice modal / Market -> Built-in MCPs',
    },
    {
      text: "Third-party content (connectors, skills, expert descriptions and community READMEs) stays in the publisher's original language - that is data, not UI copy",
    },
  ],
  '2.3.0': [
    {
      text: '**Skill ledger**: the Tool Tailor now parses the skill name from `skill` calls in the same log scan, tracks calls / errors / last use per skill, and adds zero-call rows for registered skills that were never invoked - see at a glance which skills are registered but unused',
      where: 'Tool Tailor -> below the tool table -> "Skills (skill tool)"',
    },
    {
      text: 'Calls whose arguments carry no skill name are counted separately instead of being dropped; when the registry is unavailable, the panel lists only skills seen in logs instead of faking a zero',
      where: 'Tool Tailor -> note under the skill table',
    },
  ],
  '2.3.1': [
    {
      text: '**Fixed two dead ends in the market caches; offline degradation now keeps its promise**: with a corrupted or cleaned local cache and an unchanged upstream, the expert catalog and connector market crashed on an empty 304 response and failed on every call; offline, a perfectly good disk cache was thrown away and the panel went empty. Both cases now degrade correctly: a broken cache triggers a full re-download without the stale ETag, and a network outage keeps serving the disk cache (loadedFrom=disk)',
      where: 'Market / Experts',
    },
    {
      text: '**Network data is validated before it is written**: catalog / ZIP responses must pass a structure check first (a missing experts array or a corrupt ZIP directory counts as a download failure), so a proxy interstitial that parses as JSON can no longer overwrite a good cache; writes go through a unique temp file + rename, so an interrupted run never leaves a truncated cache body',
      where: 'Market / Experts',
    },
    {
      text: '**Expert persona path now follows the marketplace manifest**: the manifest-provided promptFile was dropped during projection, so experts whose plugin.json could not be fetched failed with "no persona file path" or installed the wrong persona file; the authoritative path takes effect directly now',
      where: 'Experts -> Detail / Summon',
    },
    {
      text: '**Fixed a write race in local caches**: the multi-market registry, custom suites, install state, community meta and npm downloads now write through a unique temp file, so concurrently returning detail cards no longer trample each other into corrupt files - the worst case previously lost user-defined marketplace entries',
      where: 'Global panel',
    },
    {
      text: 'Awesome cold start no longer discards data fetched from source 2 when source 1 fails; removed 19 one-off developer patch scripts and two dead exports',
    },
  ],
};

/**
 * Attach `textEn` / `whereEn` to each item without changing the Chinese source
 * or the release-order contract. Missing translations fall back to Chinese, so
 * an out-of-date overlay degrades gracefully at runtime (the parity test is what
 * prevents that state from shipping).
 */
export function attachWhatsNewEnglish(entries) {
  return entries.map((entry) => {
    const translated = WHATS_NEW_EN[entry.version] || [];
    return {
      ...entry,
      items: entry.items.map((item, index) => {
        const en = translated[index];
        if (!en) return { ...item };
        return {
          ...item,
          textEn: en.text,
          ...(en.where ? { whereEn: en.where } : {}),
        };
      }),
    };
  });
}
