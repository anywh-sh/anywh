import { createServer as createNetServer } from "node:net";

// Below every OS's ephemeral range (Linux 32768+, macOS/Windows 49152+): a
// port taken from the OS (`listen(0)`) is released before the relay binds it,
// and in that window another test process's outbound connection, or its own
// relay, can be handed the very same one — the first then "listens" on
// somebody else's server, or not at all (EADDRINUSE). Ports in this range are
// never handed out as the source port of a connection, so only another test
// process picking the same number in the same instant can collide.
const FIRST_PORT = 20_000;
const PORT_SPAN = 10_000;

function isFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const probe = createNetServer();
    probe.once("error", () => resolveFree(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolveFree(true)));
  });
}

/** A port nothing listens on now, picked at random outside the ephemeral range. */
export async function getFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = FIRST_PORT + Math.floor(Math.random() * PORT_SPAN);
    if (await isFree(port)) return port;
  }
  throw new Error(`no free port found in ${FIRST_PORT}-${FIRST_PORT + PORT_SPAN - 1}`);
}
