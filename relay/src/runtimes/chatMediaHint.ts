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
// The wording is measured, not guessed (Claude Code 2.1.323, a turn that
// reads a simulator screenshot and is asked to report on how it looks). A
// first version that only said the app shows images inline was ignored by
// Sonnet: the CLI's own system prompt tells the model its output is shown
// in a terminal, so it concluded no image could display and described the
// screen in prose. Saying outright that replies are not read in a terminal,
// that the app is the only way the person sees the file, and that this
// holds even when asked only to check or describe it, made Sonnet and Opus
// open their report with the capture. Haiku still answered in prose with
// every wording tried.
//
// Agent-agnostic on purpose. Claude reads it on every turn (`session.ts`);
// the other agents have no channel for it yet.
export const CHAT_MEDIA_HINT =
  "Your replies are not read in a terminal: they are rendered as Markdown in an app that also displays " +
  "image and video files from this machine inline, and that is usually the only way the user gets to see " +
  "them. Whenever you take, generate or look at an image or video the user would want to see (a simulator " +
  "or browser screenshot, a screen recording, a chart you rendered), embed it in your reply with Markdown " +
  "image syntax and its absolute path, `![what it shows](/absolute/path/to/file.png)`, right before what " +
  "you say about it. Do this even when you were only asked to check or describe it: the user wants to see " +
  "what you saw, and a description or a bare path is no substitute. A path with spaces goes in angle " +
  "brackets, `![x](</path/my shot.png>)`. Videos (.mp4, .mov, .webm) take the same syntax, and images on " +
  "consecutive lines form a gallery. Save each new capture under its own file name rather than overwriting " +
  "one already shown, so earlier messages keep showing what they showed.";
