import { addPluginListener } from "@tauri-apps/api/core";

/** Subscribes every handler of `handlers` to the plugin event of the same
 * name. Resolves to one function that removes them all. */
export async function listenPluginEvents<H extends { [K in keyof H]: (event: never) => void }>(
  plugin: string,
  handlers: H,
): Promise<() => void> {
  const names = Object.keys(handlers) as (keyof H & string)[];
  const listeners = await Promise.all(names.map((name) => addPluginListener(plugin, name, (event: never) => handlers[name](event))));
  return () => {
    for (const listener of listeners) void listener.unregister();
  };
}
