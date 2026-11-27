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
// Agent-agnostic on purpose. Claude reads it on every turn (`session.ts`);
// the other agents have no channel for it yet.
export const CHAT_MEDIA_HINT =
  "Replies are shown in an app that displays image and video files from this machine inline. To " +
  "show the user one (a screenshot, a simulator capture, a screen recording, a generated chart), " +
  "embed it with Markdown image syntax and its absolute path, `![what it shows](/absolute/path/to/file.png)`, " +
  "instead of only naming the path; a path with spaces goes in angle brackets, `![x](</path/my shot.png>)`. " +
  "Videos (.mp4, .mov, .webm) take the same syntax, and images on consecutive lines form a gallery. Do " +
  "this whenever you produce or point to a visual result the user would want to see. Save each new " +
  "capture under its own file name rather than overwriting one already shown, so earlier messages keep " +
  "showing what they showed.";
