import type { Decorator, Preview } from "@storybook/react-vite";
import { BUILTIN_THEMES, DEFAULT_THEME } from "@/lib/theme/builtinThemes";
import { applyTheme } from "@/lib/theme/themeApply";
import "../src/index.css";

// Paints the canvas through the same path the app uses (`applyTheme` writes
// the resolved tokens on :root), so a story under "Papel" is what the app
// shows under "Papel" — not a hand-copied palette that drifts.
const withTheme: Decorator = (Story, context) => {
  const id = context.globals.theme as string | undefined;
  applyTheme(BUILTIN_THEMES.find((theme) => theme.id === id) ?? DEFAULT_THEME);
  return <Story />;
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: "Built-in theme",
      toolbar: {
        title: "Theme",
        icon: "paintbrush",
        items: BUILTIN_THEMES.map((theme) => ({ value: theme.id, title: theme.name })),
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: DEFAULT_THEME.id },
  parameters: { layout: "centered" },
};

export default preview;
