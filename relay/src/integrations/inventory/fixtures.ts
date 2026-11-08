// Recorded MCP inventory replies, redacted: connector ids are placeholders,
// icons and tool `_meta` are dropped, anything that could name a person or a
// workspace is replaced. A module rather than files under tests/fixtures/ so
// the pure tests stay free of `fs`; the .io tests hand the same objects to
// the fake `claude` and the fake `codex` as files.
//
// Versioned on purpose: these are the shapes the def's `inventory` contract
// was checked against, and a CLI release may change them.
// - Claude Code 2.1.303: `mcp_status` control responses on a `claude -p
//   --input-format stream-json` process in a profile with claude.ai
//   connectors, user and plugin servers, and a project `.mcp.json`;
// - codex-cli 0.154.0: `codex mcp list --json` and the app-server's
//   `mcpServerStatus/list` and `mcpServer/startupStatus/updated`.
// Anything marked SYNTHETIC was not observed as such: it follows the shapes
// that were, with values that were not.

export const CLAUDE_RECORDED_WITH = "2.1.303";
export const CODEX_RECORDED_WITH = "0.154.0";

// The 41 tools `claude.ai Atlassian` (the official remote server, v1)
// listed, with the `readOnly` annotation as reported. Order kept.
const ATLASSIAN_V1_TOOLS: [string, boolean][] = [
  ["atlassianUserInfo", true],
  ["getAccessibleAtlassianResources", true],
  ["getContentFormatGuide", true],
  ["getConfluencePage", true],
  ["searchConfluenceUsingCql", true],
  ["getConfluenceSpaces", true],
  ["getPagesInConfluenceSpace", true],
  ["getConfluencePageFooterComments", true],
  ["getConfluencePageInlineComments", true],
  ["getConfluenceCommentChildren", true],
  ["getConfluencePageDescendants", true],
  ["createConfluencePage", false],
  ["updateConfluencePage", false],
  ["createConfluenceFooterComment", false],
  ["createConfluenceInlineComment", false],
  ["getJiraIssue", true],
  ["editJiraIssue", false],
  ["createJiraIssue", false],
  ["getTransitionsForJiraIssue", true],
  ["getJiraIssueRemoteIssueLinks", true],
  ["getVisibleJiraProjects", true],
  ["getJiraProjectIssueTypesMetadata", true],
  ["getJiraIssueTypeMetaWithFields", true],
  ["addCommentToJiraIssue", false],
  ["transitionJiraIssue", false],
  ["searchJiraIssuesUsingJql", true],
  ["lookupJiraAccountId", true],
  ["addWorklogToJiraIssue", false],
  ["getIssueLinkTypes", true],
  ["createIssueLink", false],
  ["getCompassComponents", true],
  ["getCompassComponent", true],
  ["getCompassCustomFieldDefinitions", true],
  ["createCompassCustomFieldDefinition", false],
  ["createCompassComponent", false],
  ["createCompassComponentRelationship", false],
  ["getTeamworkGraphContext", true],
  ["getTeamworkGraphObject", true],
  ["addTeamworkGraphContext", false],
  ["search", true],
  ["fetch", true],
];

// A write tool comes with an empty `annotations` object, a read one with
// `{readOnly: true}`.
const atlassianTools = () => ATLASSIAN_V1_TOOLS.map(([name, readOnly]) => ({ name, annotations: readOnly ? { readOnly: true } : {} }));

/** `mcp_status` once the servers settled (8 s after start), in a project
 * folder whose `.mcp.json` declares the same Atlassian server again. The
 * real list had 50 servers (45 claude.ai connectors); the ones kept show
 * every scope and status. */
export const CLAUDE_MCP_STATUS_SETTLED = {
  mcpServers: [
    { name: "plugin:context7:context7", status: "needs-auth", config: { type: "http", url: "https://mcp.context7.com/mcp?client=claude-code-plugin" }, scope: "dynamic", source: "plugin" },
    {
      name: "plugin:playwright:playwright",
      status: "connected",
      serverInfo: { name: "Playwright", version: "1.65.0-alpha-2026-10-30" },
      config: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"] },
      scope: "dynamic",
      source: "plugin",
      tools: [
        { name: "browser_close", annotations: { destructive: true, openWorld: true } },
        { name: "browser_console_messages", annotations: { readOnly: true, openWorld: true } },
      ],
    },
    { name: "simplelocalize", status: "connected", config: { type: "stdio", command: "npx", args: ["-y", "@simplelocalize/simplelocalize-mcp"] }, scope: "user", source: "user" },
    {
      name: "sentry",
      status: "connected",
      serverInfo: { name: "Sentry MCP", title: "Sentry", version: "0.42.0", websiteUrl: "https://mcp.sentry.dev" },
      config: { type: "http", url: "https://mcp.sentry.dev/mcp" },
      scope: "user",
      source: "user",
      tools: [
        { name: "whoami", annotations: { readOnly: true, openWorld: true } },
        { name: "find_organizations", annotations: { readOnly: true, openWorld: true } },
      ],
    },
    {
      name: "claude.ai Atlassian MCP",
      status: "needs-auth",
      config: { type: "claudeai-proxy", url: "https://mcp.atlassian.com/v2/mcp", id: "mcpsrv_00000000000000000000000002" },
      scope: "claudeai",
      source: "claudeai",
    },
    {
      name: "claude.ai Atlassian",
      status: "connected",
      serverInfo: { name: "atlassian-mcp-server", version: "1.0.0" },
      config: { type: "claudeai-proxy", url: "https://mcp.atlassian.com/v1/mcp", id: "mcpsrv_00000000000000000000000001" },
      scope: "claudeai",
      source: "claudeai",
      tools: atlassianTools(),
    },
    // SYNTHETIC name and url: one of the other connectors, needing auth.
    { name: "claude.ai Notion", status: "needs-auth", config: { type: "claudeai-proxy", url: "https://mcp.notion.com/mcp", id: "mcpsrv_00000000000000000000000003" }, scope: "claudeai", source: "claudeai" },
    // The project's `.mcp.json`: `needs-auth` in `-p` even though the
    // interactive `claude mcp list` shows it as pending approval.
    { name: "atlassian", status: "needs-auth", config: { type: "sse", url: "https://mcp.atlassian.com/v1/sse" }, scope: "project", source: "project" },
    // Observed against an unreachable address in a throwaway home.
    {
      name: "figma",
      status: "failed",
      error: "ECONNREFUSED: Unable to connect. Is the computer able to access the url?",
      config: { type: "http", url: "http://127.0.0.1:9/mcp" },
      scope: "project",
      source: "project",
    },
  ],
};

/** The same process 3 s after start: servers still coming up are
 * `pending`, with no catalog yet. */
export const CLAUDE_MCP_STATUS_STARTING = {
  mcpServers: CLAUDE_MCP_STATUS_SETTLED.mcpServers.map((server) =>
    server.name === "claude.ai Atlassian MCP" || server.name === "plugin:context7:context7"
      ? server
      : { name: server.name, status: "pending", config: server.config, scope: server.scope, source: server.source },
  ),
};

/** A control request the CLI has no handler for. */
export const CLAUDE_CONTROL_UNSUPPORTED = {
  type: "control_response",
  response: { subtype: "error", request_id: "bad", error: "Unsupported control request subtype: no_such_thing" },
};

/** A turn's `system`/`init`, trimmed to the MCP part. */
export const CLAUDE_INIT_EVENT = {
  type: "system",
  subtype: "init",
  mcp_servers: [
    { name: "claude.ai Atlassian MCP", status: "needs-auth" },
    { name: "claude.ai Atlassian", status: "pending" },
    { name: "sentry", status: "pending" },
  ],
};

/** `codex mcp list --json`. The `atlassian` entry is the official server
 * with no login yet (its `auth_status` as observed against it); `off` is
 * turned off in the config. */
export const CODEX_MCP_LIST_STDOUT = JSON.stringify(
  [
    {
      name: "atlassian",
      enabled: true,
      disabled_reason: null,
      transport: { type: "streamable_http", url: "https://mcp.atlassian.com/v1/mcp", bearer_token_env_var: null, http_headers: null, env_http_headers: null, http_headers_helper: null },
      startup_timeout_sec: null,
      tool_timeout_sec: null,
      auth_status: "not_logged_in",
    },
    {
      name: "deepwiki",
      enabled: true,
      disabled_reason: null,
      transport: { type: "streamable_http", url: "https://mcp.deepwiki.com/mcp", bearer_token_env_var: null, http_headers: null, env_http_headers: null, http_headers_helper: null },
      startup_timeout_sec: null,
      tool_timeout_sec: null,
      auth_status: "unsupported",
    },
    {
      name: "jira-local",
      enabled: true,
      disabled_reason: null,
      transport: { type: "stdio", command: "uvx", args: ["mcp-atlassian"], env: null, env_vars: ["JIRA_URL", "JIRA_API_TOKEN"], cwd: null },
      startup_timeout_sec: null,
      tool_timeout_sec: null,
      auth_status: "unsupported",
    },
    {
      name: "off",
      enabled: false,
      disabled_reason: null,
      transport: { type: "stdio", command: "node", args: ["x.js"], env: null, env_vars: [], cwd: null },
      startup_timeout_sec: null,
      tool_timeout_sec: null,
      auth_status: "unsupported",
    },
  ],
  null,
  2,
);

const tool = (name: string, readOnlyHint: boolean) => ({
  name,
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint, destructiveHint: !readOnlyHint, idempotentHint: readOnlyHint, openWorldHint: true },
});

/** `mcpServerStatus/list {detail: "toolsAndAuthOnly", threadId}`. The
 * `atlassian` entry is the observed not-logged-in reply; `jira-local`'s
 * catalog is SYNTHETIC (the community server's `jira_*` names). */
export const CODEX_MCP_STATUS_LIST = {
  data: [
    {
      name: "atlassian",
      runtimeStatus: "authenticationRequired",
      pluginId: null,
      serverInfo: null,
      tools: {},
      toolsError: "MCP startup failed: handshaking with MCP server failed: Auth required, when send initialize request",
      resources: [],
      resourceTemplates: [],
      authStatus: "notLoggedIn",
    },
    {
      name: "deepwiki",
      runtimeStatus: "connected",
      pluginId: null,
      serverInfo: { name: "DeepWiki", title: null, version: "0.0.1", description: null, icons: null, websiteUrl: null },
      tools: { read_wiki_structure: tool("read_wiki_structure", true) },
      toolsError: null,
      resources: [],
      resourceTemplates: [],
      authStatus: "unsupported",
    },
    {
      name: "jira-local",
      runtimeStatus: "connected",
      pluginId: null,
      serverInfo: { name: "mcp-atlassian", title: null, version: "0.11.0", description: null, icons: null, websiteUrl: null },
      tools: { jira_search: tool("jira_search", true), jira_get_issue: tool("jira_get_issue", true), jira_create_issue: tool("jira_create_issue", false) },
      toolsError: null,
      resources: [],
      resourceTemplates: [],
      authStatus: "unsupported",
    },
  ],
  nextCursor: null,
};

/** The same read while the thread's servers are still starting. */
export const CODEX_MCP_STATUS_LIST_STARTING = {
  data: CODEX_MCP_STATUS_LIST.data.map((server) => ({ ...server, runtimeStatus: "starting", tools: {}, toolsError: null, serverInfo: null })),
  nextCursor: null,
};

/** `mcpServer/startupStatus/updated` for a server with no login. */
export const CODEX_STARTUP_NOT_LOGGED_IN = {
  threadId: "00000000-0000-4000-8000-000000000010",
  name: "atlassian",
  status: "failed",
  error: "The atlassian MCP server is not logged in. Run `codex mcp login atlassian`.",
  failureReason: null,
};
