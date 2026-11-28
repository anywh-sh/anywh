// What the relay tells an agent about how its replies are displayed, for the
// one part of the display a model can't guess: an image or video file on
// this machine shows inline when written as a Markdown image.
//
// Without it the agent names a screenshot's path and the person has to go
// find the file. Markdown image syntax is what models already write
// unprompted, it still reads as plain text anywhere else, and it stays in
// the transcript, so a reloaded conversation shows the same images — which
// is why this is a line of prompt and not a tool the agent calls. The client
// renders only local files this way (`/files/media`); a remote image URL is
// shown as a link and never fetched, since fetching one is how a prompt
// injection smuggles data out in an image request.
//
// The wording is measured, not guessed (Claude Code 2.1.323, `claude -p` with
// the hint appended), on two kinds of turn: reading a simulator screenshot
// and reporting on it, and making a visual file without being asked to show
// it. A first version that only said the app shows images inline was ignored
// by Sonnet on the first kind: the CLI's own system prompt says output goes
// to a terminal. Saying replies are not read in a terminal fixed that (Sonnet
// and Opus then opened their report with the capture), but on the second
// kind Sonnet still answered "I didn't open it, so I haven't seen it" and gave
// only the path, 0 of 5. Making it a rule with a worked example, true
// whether or not the agent opened the file, took Sonnet to 5 of 5 for one
// file. Several files at once it still mostly lists by name (1 of 5), which
// is what the client's preview of named media covers (`MentionedMedia`).
// Renaming image files embeds nothing, as the rule says. Haiku follows none
// of it.
//
// Agent-agnostic on purpose; each agent gets it by the channel it has.
// Claude: appended to the system prompt on every turn (`session.ts`). Codex:
// a new thread's developer instructions, after the person's own
// (`codex.ts`). Kimi: a `<system-reminder>` block ahead of a session's first
// prompt (`kimi.ts`). The last two were measured on their real CLIs the same
// way: each opened its report with the capture embedded.
export const CHAT_MEDIA_HINT =
  "IMPORTANT, this app shows images: your replies are not read in a terminal but rendered as Markdown in " +
  "an app that displays image and video files from this machine inline, and that is usually the only way " +
  "the user gets to see them. Rule: every time you create, edit, capture or look at an image or video the " +
  "user cares about (a chart, icon, diagram or mockup you generated, a simulator or browser screenshot, a " +
  "screen recording), your reply must embed it with Markdown image syntax and its absolute path. Example: " +
  "after writing /tmp/report/chart.svg, your reply includes `![Monthly sales chart](/tmp/report/chart.svg)`. " +
  "Do it without being asked and whether or not you opened the file yourself; naming the path or describing " +
  "the picture is not enough. Skip image files you only moved or renamed. A path with spaces goes in angle " +
  "brackets, `![x](</path/my shot.png>)`. Videos (.mp4, .mov, .webm) take the same syntax, and images on " +
  "consecutive lines form a gallery. Save each new capture under its own file name rather than overwriting " +
  "one already shown, so earlier messages keep showing what they showed.";
