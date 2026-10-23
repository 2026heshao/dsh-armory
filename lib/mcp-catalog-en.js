// en-US overlay for the generated built-in MCP catalog (lib/mcp-catalog.js).
//
// Why this file exists: `mcp-catalog.js` is generated from the upstream verified
// list (see its header) and is not a UI string table, so its Chinese `summary`,
// `access`, `authNote`, and category labels cannot go through client `t()`
// (the i18n dictionary is checked bidirectionally against client.js literals and
// would report every catalog key as an orphan). The host instead ships both
// languages with the `builtins` RPC, and the client selects by locale.
//
// Maintenance: when a catalog entry is added/removed upstream, the parity test
// (`test/mcp-catalog-i18n.mjs`) fails until this overlay is updated. Keep the
// English fields free of CJK so an English panel never leaks Chinese here.
// Proper nouns (Exa, GitHub, ClickHouse, ...) stay as-is.
export const CATEGORY_LABELS_EN = {
  search: 'Search',
  dev: 'Developer Tools',
  security: 'Security & Reverse Engineering',
  data: 'Databases & Data',
  ai: 'AI & Knowledge',
  browser: 'Browser Automation',
  cloud: 'Cloud & Infrastructure',
  productivity: 'Productivity',
  files: 'Files & Local',
  comms: 'Communication',
};

// Only display labels containing Chinese need an override; ASCII brand names are
// already language-neutral. `localizeBuiltinItem` falls back to `label`.
export const CATALOG_LABELS_EN = {
  'deepwiki-fetch': 'DeepWiki (local fetch)',
};

export const MCP_CATALOG_EN = {
  exa: {
    summary: 'Web search and content reading',
    access: 'Usable without a key (rate-limited); add x-api-key to headers to raise the quota',
    authNote: 'The keyless signal is an empty x-api-key header (rate limit measured in testing); set EXA_API_KEY for a higher quota',
  },
  tavily: {
    summary: 'AI-optimized search and web extraction',
    access: 'Free keyless mode has rate limits (responses are identical with a key); the official free key gives 1,000 credits/month, no credit card required',
  },
  firecrawl: {
    summary: 'Web scraping, search, and document parsing',
    access: 'Usable without a key (daily limit); set an API key for a higher quota. For sites requiring browser login, use /v2/mcp-oauth',
    authNote: 'Sends an empty Bearer token in keyless mode; set FIRECRAWL_API_KEY for keyed mode',
  },
  'brave-search': {
    summary: 'Independent web and local search index',
    access: 'Requires your own Brave Search API key (free tier available; paid beyond it)',
    authNote: 'BRAVE_API_KEY is required; there is no keyless path',
  },
  perplexity: {
    summary: 'Real-time web search and deep research',
    access: 'Requires a paid Perplexity API key (Bearer); no free quota',
    authNote: 'PERPLEXITY_API_KEY is required (Bearer); no free quota',
  },
  'google-maps': {
    summary: 'Google Maps platform developer documentation search',
    access: 'Free during the experimental phase, no authentication required (testing returned 2 documentation-search tools from tools/list)',
  },
  fetch: {
    summary: 'Fetch web pages and convert them to LLM-friendly text',
    access: 'Open source and free; no key required',
  },
  github: {
    summary: 'Repositories, issues, pull requests, and code search',
    access: 'Requires a GitHub account with OAuth authorization; a PAT also works. Available features depend on your plan',
    authNote: 'Skip OAuth: configure GITHUB_PERSONAL_ACCESS_TOKEN (a PAT) and connect directly with Bearer',
  },
  gitlab: {
    summary: 'Projects, issues, and merge request access',
    access: 'Available on Free and higher plans; OAuth dynamic registration, including self-hosted instances | WARNING: static token auth is not officially confirmed (official MCP docs only describe OAuth/DCR; issue 586184 requests PAT support and was answered as not on the near-term roadmap), so authorization may fail in DSH',
    authNote: 'Only OAuth dynamic registration is supported; static tokens are not officially supported, so this host will stall during authorization and stay disconnected after installation',
  },
  sentry: {
    summary: 'Error search, performance analysis, and issue triage',
    access: 'Requires Sentry account OAuth authorization (free-tier accounts work)',
    authNote: 'Official docs only mention OAuth; if you issue SENTRY_AUTH_TOKEN in Sentry settings, Bearer may work (not guaranteed by the docs)',
  },
  git: {
    summary: 'Read and write local Git repositories',
    access: 'Open source and free; operates only on local repositories',
  },
  serena: {
    summary: 'Symbol-level code search and refactoring',
    access: 'Open source and free (MIT), runs locally; install first with uv tool install -p 3.13 serena-agent',
  },
  everything: {
    summary: 'Official reference implementation for connectivity checks',
    access: 'Open source and free; intended for demos and testing',
  },
  'fast-context': {
    summary: 'Windsurf-powered semantic code search',
    access: 'Open source and free; if Windsurf is installed its key is picked up automatically, otherwise set WINDSURF_API_KEY',
    authNote: 'Key is picked up automatically when Windsurf is installed; otherwise set WINDSURF_API_KEY',
  },
  jshook: {
    summary: 'JS analysis and security research: hooks, CDP debugging, deobfuscation',
    access: 'Open source and free (AGPL-3.0), runs locally; requires Node 22.12+. Tool profiles are controlled by MCP_TOOL_PROFILE (search ~3K tokens / workflow / full ~40K+); the default profile is sufficient',
  },
  'ida-pro': {
    summary: 'Drive IDA Pro for reverse engineering',
    access: 'Requires IDA Pro installed locally; the service is fetched on demand, no prior pip install needed',
  },
  'frida-mcp': {
    summary: 'Frida dynamic instrumentation: hook functions and trace calls',
    access: 'Open source and free (MIT), runs locally; requires Frida and the target on this machine. Tested with uvx startup and a successful initialize/tools/list handshake; enumerate_processes returned local processes',
  },
  dbx: {
    summary: 'Multi-database queries (Postgres / MySQL / SQLite, etc.)',
    access: 'Open source and free; native local binary. Data sources are configured in the DBX app',
  },
  postgres: {
    summary: 'Postgres queries, indexes, and health analysis',
    access: 'Open source and free; requires your own database connection string (DATABASE_URI)',
    authNote: 'Set DATABASE_URI (the database connection string, including the password)',
  },
  sqlite: {
    summary: 'Local SQLite queries and data analysis',
    access: 'Open source and free; operates only on local .db files. Note: the official project is archived and receives maintenance fixes only',
  },
  redis: {
    summary: 'Redis key-value, vector, and stream operations',
    access: 'Open source and free (MIT); requires your own Redis instance',
    authNote: 'Set REDIS_HOST / REDIS_PORT; include the password if the instance requires one',
  },
  clickhouse: {
    summary: 'ClickHouse queries and schema exploration',
    access: 'Open source and free, read-only by default; requires your own ClickHouse connection details',
    authNote: 'Set CLICKHOUSE_HOST / PORT / USER and CLICKHOUSE_PASSWORD',
  },
  mongodb: {
    summary: 'MongoDB and Atlas data access',
    access: 'Open source and free (Apache-2.0); requires your own connection string',
    authNote: 'Set MDB_MCP_CONNECTION_STRING (a connection string including the password)',
  },
  supabase: {
    summary: 'Supabase project and database management',
    access: 'Requires Supabase account OAuth authorization; parameters such as ?read_only=true can restrict permissions',
    authNote: 'Official docs specify OAuth; if you have SUPABASE_ACCESS_TOKEN, Bearer may work (not guaranteed by the docs)',
  },
  neon: {
    summary: 'Neon project management and queries',
    access: 'Requires Neon account OAuth or an API key; optional read-only mode and single-project scoping',
    authNote: 'Official recommendation is OAuth; set NEON_API_KEY as a Bearer token to connect directly',
  },
  'deepwiki-fetch': {
    summary: 'Fetch DeepWiki pages and convert them to Markdown',
    access: 'Completely free, no authentication; fetches locally and overlaps with the official remote version, so pick one as needed',
  },
  memory: {
    summary: 'Persistent memory backed by a knowledge graph',
    access: 'Open source and free; data is stored in local files',
  },
  'sequential-thinking': {
    summary: 'Step-by-step reasoning and dynamic problem decomposition',
    access: 'Open source and free; no key required',
  },
  context7: {
    summary: 'Real-time documentation for the latest library versions',
    access: 'Usable without a key; a free API key is available on the website to raise the rate limit',
  },
  deepwiki: {
    summary: 'Repository documentation and Q&A',
    access: 'Completely free, no authentication; accesses public repositories only',
  },
  huggingface: {
    summary: 'Model, dataset, and Spaces search',
    access: 'Basic tools work without a key; sign in to use your configured personal Apps and tools',
  },
  arxiv: {
    summary: 'Paper search and full-text access',
    access: 'Open source and free; no key required',
  },
  'chrome-devtools': {
    summary: 'Drive a real Chrome instance for debugging and performance analysis',
    access: 'Open source and free, runs locally; requires Chrome installed',
  },
  playwright: {
    summary: 'Browser automation based on accessibility snapshots',
    access: 'Open source and free (Apache-2.0), runs locally; requires Node.js 18+',
  },
  'cloudflare-api': {
    summary: 'Call the full Cloudflare API',
    access: 'Requires Cloudflare account OAuth authorization; an API token can also be used as a Bearer token',
    authNote: 'Official recommendation is OAuth; set CLOUDFLARE_API_TOKEN as a Bearer token to connect directly',
  },
  'cloudflare-docs': {
    summary: 'Semantic search over official Cloudflare documentation',
    access: 'Usable without a key; no account required',
  },
  aws: {
    summary: 'Access AWS services through mcp-proxy-for-aws',
    access: 'Open source and free; credentials come from the local AWS configuration (~/.aws) and Bedrock access is required',
    authNote: 'Credentials come from local ~/.aws, so no key is needed here; the account must have Bedrock access',
  },
  kubernetes: {
    summary: 'Cluster resources, pods, and Helm management',
    access: 'Open source and free (Apache-2.0); uses the local kubeconfig',
    authNote: 'Uses local kubeconfig credentials, so no key is needed here; the cluster must be reachable',
  },
  docker: {
    summary: 'Run MCP servers uniformly in isolated containers',
    access: 'Open source and free (MIT); requires Docker Desktop or the docker CLI plugin',
  },
  netlify: {
    summary: 'Site builds, deployments, and the Netlify CLI',
    access: 'Requires Netlify account OAuth authorization | WARNING: static token auth is not officially confirmed (NETLIFY_PERSONAL_ACCESS_TOKEN in the official docs is an environment variable for the local stdio package; the remote endpoint only documents OAuth), so authorization may fail in DSH',
    authNote: 'The remote endpoint only documents OAuth; static tokens are not officially confirmed, so this host will stall during authorization and stay disconnected after installation',
  },
  linear: {
    summary: 'Issue, project, and comment management',
    access: 'Requires Linear account OAuth; read-only access is available at https://mcp.linear.app/mcp/readonly',
    authNote: 'Official docs specify OAuth; LINEAR_API_KEY as a Bearer token is not documented, so it will most likely fail to connect after installation',
  },
  atlassian: {
    summary: 'Jira and Confluence read/write',
    access: 'Free tier available (no credit card); requires Atlassian account OAuth authorization',
    authNote: 'Official docs specify OAuth; ATLASSIAN_API_TOKEN as a Bearer token is not documented, so it will most likely fail to connect after installation',
  },
  airtable: {
    summary: 'Read and write Airtable bases and records',
    access: 'Available on all plans (including free); requires Airtable OAuth authorization',
    authNote: 'Official docs specify OAuth; AIRTABLE_TOKEN as a Bearer token is not documented, so it will most likely fail to connect after installation',
  },
  'microsoft-learn': {
    summary: 'Search official Microsoft documentation and code samples',
    access: 'Completely free; no authentication or account required',
  },
  time: {
    summary: 'Time queries and timezone conversion',
    access: 'Open source and free; purely local computation',
  },
  filesystem: {
    summary: 'File read/write within allowed directories',
    access: 'Open source and free; can access only directories explicitly allowed on the command line',
  },
  slack: {
    summary: 'Search messages, send messages, and manage canvases',
    access: 'Create your own Slack app and complete one OAuth flow to obtain an xoxp- user token, then configure it here; the token can be reused long-term',
    authNote: 'Create a Slack app and complete one OAuth flow to obtain an xoxp- user token; set SLACK_USER_TOKEN to reuse it long-term',
  },
};
