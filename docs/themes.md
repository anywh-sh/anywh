# Themes

A theme is a JSON file with six colors in it. Everything else — the surface
stack, faint text, the terminal and syntax palettes, button ink — is derived
from those six, and any derived token can be overridden individually if you
disagree with what was derived.

Picking a theme is an app-level choice: one selection per installation,
applied to every profile in that app. It does not sync between devices —
choosing one on your laptop leaves the app on your phone painting whatever
it was already using.

## The minimum viable theme

```json
{
  "version": 1,
  "id": "my-theme",
  "name": "My theme",
  "appearance": "dark",
  "colors": {
    "background": "#2e3440",
    "foreground": "#eceff4",
    "muted-foreground": "#8f9bb0",
    "primary": "#88c0d0",
    "destructive": "#bf616a",
    "border": "#434c5e"
  }
}
```

`appearance` is `"dark"` or `"light"` and tells the app which direction to
derive in. All six keys under `colors` are required, and between them they
decide almost everything else:

| Key | What it sets |
|---|---|
| `background` | The base surface. The whole panel and card stack is derived from it. |
| `foreground` | Default text, and the text on cards, popovers and secondary surfaces. |
| `muted-foreground` | Secondary text — labels, timestamps, anything deliberately quieter. |
| `primary` | The accent: focus rings, selected states, filled buttons, links. |
| `destructive` | Danger — delete actions and error states. |
| `border` | Default divider and outline color. |

## Overriding what was derived

Every color key maps 1:1 to the CSS custom property of the same name —
`background` becomes `--background` — so adding an optional key to `colors`
replaces exactly that token and nothing else. There are thirty-two, and they
group by what they touch:

| Group | Keys | Covers |
|---|---|---|
| Surfaces | `bg-sidebar`, `bg-chrome`, `bg-elevated`, `surface-hover`, `card`, `bubble-user` | The panel stack derived from `background`, plus your own chat bubble |
| Text | `text-faint` | A third tier, quieter still than `muted-foreground` |
| Accent ink | `primary-soft`, `primary-ink`, `primary-foreground`, `destructive-foreground` | Tinted accent backgrounds, and the label colors that have to stay readable on them |
| Borders | `border-soft`, `context-ring-warn` | A quieter divider, and the midpoint of the context-usage ring as it runs from `primary` to `destructive` |
| Depth | `overlay`, `glass-tint`, `media-scrim`, `media-scrim-foreground`, `shadow-color` | Modal backdrops, translucent chrome, the wash over media previews, shadows |
| Code | `syntax-comment`, `syntax-keyword`, `syntax-string`, `syntax-number`, `syntax-title`, `diff-add` | Highlighting in code blocks, and the added-line tint in diffs |
| Room | `state-run`, `canvas-grid` | A room's "running" tone (an agent's status label, its live link), and the grid drawn behind the cards — declared translucent, it is the dots at full strength and the canvas fades it by zoom |
| Profiles | `profile-1` … `profile-6` | The accents that tell profiles apart in the switcher |

You don't have to look any of this up to start. Use **Create copy** on an
existing theme to get its full JSON with every token spelled out at its real
value, then edit from there — that is the intended way to write a theme, and
it's why the dialog exists.

One derived token worth knowing about: `primary-foreground`, the label on a
filled button, is derived from the accent itself rather than defaulting to
`foreground`, because `foreground` is unreadable on any mid-tone accent.
Declare it yourself if your accent sits somewhere the derivation guesses
wrong.

### How the rest is derived

Derivation runs in the direction of your `background`'s brightness, not of
the declared `appearance`: a pale background gets a surface stack that
climbs toward white and darkens toward the sidebar, and the tokens that keep
a built-in hue (`diff-add`, `context-ring-warn`, `state-run`, the syntax
string/number colors and the terminal's ANSI 16) come from the built-in of
the same direction — Papel's on a light page, Noite's on a dark one.

Every derived ink is then held to WCAG AA: `text-faint`, `primary-ink` (on
`primary-soft`), `diff-add`, `context-ring-warn` and `state-run` must read at
4.5:1 on every surface text can land on (`background`, `bg-sidebar`,
`bg-chrome`, `bg-elevated`, `surface-hover`, `card`, `bubble-user`). One that
doesn't is moved toward your `foreground` until it does. That floor applies
only to what was derived — a color you declare is used as written, so a
theme that wants a fainter faint tier can still have one.

The two built-ins are measured against the same bar in
`client/src/lib/theme/themeContrast.test.ts`, alongside two six-color custom
themes (one light, one dark) resolved through the real derivation.

## Adding one

**Settings → Appearance → Add theme**, then either paste the JSON or pick a
file. The dialog validates before saving and reports one message per field,
so a broken theme tells you exactly which key is wrong rather than failing
as a whole.

The theme file itself is stored on the relay machine, under
`~/.config/anywh/themes/*.json`, and is host-wide: add a theme once and it
becomes selectable from every profile on that machine — by any app that
connects to it, each still making its own choice about whether to use it.

The built-in theme ships inside the app and always works, even with the
relay unreachable.

## Deleting one

Deleting a theme file that an app is currently painting leaves that
selection dangling on purpose. The app falls back to the built-in theme
rather than having its choice silently rewritten to something nobody picked,
and the same happens whenever the relay holding the file is unreachable.
