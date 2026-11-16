import type { StorybookConfig } from "@storybook/react-vite";

// Deliberately addon-free: the catalog exists to show every variant of a
// primitive side by side, and the stories double as unit tests through
// `composeStories` in the existing vitest tier — neither needs docs, a11y
// or interaction addons. Add one only when a story actually needs it.
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: "@storybook/react-vite",
  core: { disableTelemetry: true },
  // vite.config.ts is picked up as-is (aliases, React, Tailwind). Its Tauri
  // dev-server block pins port 1420 with strictPort, which would collide
  // with a running `tauri dev`; Storybook serves on its own port, so drop it.
  viteFinal: (viteConfig) => {
    delete viteConfig.server?.port;
    if (viteConfig.server) viteConfig.server.strictPort = false;
    return viteConfig;
  },
};

export default config;
