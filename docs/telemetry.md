# Telemetry

The official anywh app counts, anonymously, which features get used, so we
know what to improve and what to build next. This page lists exactly what is
sent, what never is, and how to turn it off.

## The short version

- **Only official builds send anything.** The analytics key is injected by
  the release workflow and is not in the repository. A build from source, a
  fork, or a dev run has no key, and its telemetry code never loads the
  analytics library.
- **Nothing is sent before you answer the first-launch notice.** Events
  wait in memory until you do. "Got it" or closing the notice turns sharing
  on; "Don't share" turns it off and throws away what was waiting.
- **Anonymous.** Events are keyed by a random installation ID created by
  the app. There is no account, name, email, hostname or relay address in
  them, and no person profile is created.
- **No content.** Prompts, agent output, terminal output, file contents,
  file and folder names, paths, repository and branch names, session titles,
  profile names, model IDs, error messages and URLs are never sent.
- **No location.** Every event asks the analytics server not to derive a
  location from the request's IP address, and the IP itself is discarded.
- **Only the app sends.** The relay never contacts any analytics service.

## Turning it off

Any one of these is enough:

- **In the app:** Settings → Privacy → turn off "Share anonymous usage
  counts". It takes effect immediately and is remembered.
- **`DO_NOT_TRACK=1`**: the cross-tool convention.
- **`ANYWH_TELEMETRY_DISABLED=1`**: the app's own switch, with the same
  effect.

Either variable counts when set to anything other than empty, `0` or
`false`. It overrides the saved choice without changing it: unset it and the
app goes back to what you chose in Settings. A variable is only seen when it
is in the app's environment, which in practice means launching the app from
a shell that has it exported; an app opened from the dock or the start menu
does not read your shell profile. While a variable is in effect, the Privacy
toggle shows why it is off.

Turning sharing off, from the notice or from Settings, sends one last
`telemetry_opted_out` event saying where you turned it off, so we know how
many people do. Nothing is sent after it.

## How it is enforced

The guarantees above live in the code, not in a promise:

- **A closed list of events.** `client/src/lib/telemetry/events.ts` is the
  only list of events the app may send, with the exact properties of each.
  An event that is not listed, or whose properties are not exactly its
  schema, is dropped. No property accepts free text: a value is a member of
  a closed list, a bounded number, a boolean, or a version number.
- **Unknown values become `other`.** A model, agent, effort level or
  permission mode the app does not know is counted as `other`, never named.
- **Nothing collected implicitly.** Automatic click capture, page views,
  session recording, heatmaps and exception capture are all off, and the
  analytics library's own properties (page URL, browser, screen size) are
  stripped before sending (`client/src/lib/telemetry/scrub.ts`).
- **A rate cap per event**, so a bug that fires an event in a loop cannot
  turn into a feed.

## What is sent

Every event carries the app version, the operating system and CPU
architecture, the OS's major version only (`14`, `11`, `6`), how the app was
installed (for example `app-bundle`, `nsis`, `appimage`), the app's language,
and the installation ID.

| Event | When | What it says |
|---|---|---|
| `app_opened` | The app starts | Number of profiles (local and remote), which agents the profiles use (Claude Code, Codex), update mode, whether push is on, built-in or imported theme, font size bucket |
| `app_active` | Once per day the app is open | Nothing beyond the common properties |
| `first_run_step_viewed` | Each first-run screen | Which screen, and which option it was opened with |
| `first_run_completed` | First run finishes | Install, adopt or remote; how long it took; which agents were installed |
| `first_prompt_sent` | The first prompt ever, once | Seconds since the app was first opened; which agent |
| `session_started` | A new conversation or room | Agent, model family (`opus`, `sonnet`, `haiku`, `gpt` or `other`), effort, permission mode, chat or room |
| `feature_used` | The first use of a feature each day | Which feature, from a fixed list: room, terminal, files panel, file viewer, voice, attachment, split tab, global search, Jira integration, MCP sign-in, slash command, theme import, plan usage refresh, open in editor, background jobs |
| `profile_added` | A profile is added | Local or remote; pairing by code or address |
| `error_shown` | An error is shown to you | Which kind, from a fixed list (for example agent install failed, relay unreachable, relay version mismatch); never its message |
| `update_installed` | First start after an update | Previous and new version; update mode |
| `telemetry_opted_out` | Sharing is turned off | Whether from the notice or from Settings |

## Where the data goes

- **Service:** PostHog Cloud, United States region, in a project used only
  for the app.
- **Retention:** PostHog's default for the plan; we set no custom window.
- **Access:** limited to the project's maintainers.
