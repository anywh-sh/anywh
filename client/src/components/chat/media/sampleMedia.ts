// Pictures for the stories: SVG drawn here, so the catalog needs no asset
// file and no relay. Named colors on purpose, not hex: this is a fixture
// standing in for someone's screenshot, not a color the app applies.

function svgUrl(width: number, height: number, body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const FONT = 'font-family="-apple-system, Helvetica, Arial, sans-serif"';

/** A phone screen at the proportion of a simulator screenshot (393×852
 * points): a status bar, a title, a few rows and a button in `accent`. */
export function phoneScreenshot(title: string, accent: string): string {
  const rows = [0, 1, 2, 3]
    .map(
      (row) =>
        `<rect x="24" y="${String(170 + row * 92)}" width="345" height="76" rx="14" fill="white"/>` +
        `<circle cx="62" cy="${String(208 + row * 92)}" r="18" fill="${accent}" opacity="0.25"/>` +
        `<rect x="94" y="${String(194 + row * 92)}" width="${String(180 - row * 22)}" height="12" rx="6" fill="gainsboro"/>` +
        `<rect x="94" y="${String(214 + row * 92)}" width="120" height="10" rx="5" fill="whitesmoke"/>`,
    )
    .join("");
  return svgUrl(
    393,
    852,
    `<rect width="393" height="852" fill="whitesmoke"/>` +
      `<text x="32" y="38" ${FONT} font-size="17" font-weight="600" fill="black">9:41</text>` +
      `<text x="24" y="132" ${FONT} font-size="32" font-weight="700" fill="black">${title}</text>` +
      rows +
      `<rect x="24" y="742" width="345" height="54" rx="14" fill="${accent}"/>` +
      `<text x="196" y="776" ${FONT} font-size="17" font-weight="600" fill="white" text-anchor="middle">Continue</text>`,
  );
}

/** A wide picture, like a desktop capture or a generated chart. */
export function landscapeChart(title: string): string {
  const bars = [0.35, 0.6, 0.45, 0.8, 0.7, 0.95]
    .map((share, index) => {
      const height = Math.round(share * 300);
      return `<rect x="${String(120 + index * 180)}" y="${String(560 - height)}" width="110" height="${String(height)}" fill="steelblue"/>`;
    })
    .join("");
  return svgUrl(
    1280,
    720,
    `<rect width="1280" height="720" fill="white"/>` +
      `<text x="80" y="110" ${FONT} font-size="44" font-weight="700" fill="black">${title}</text>` +
      `<line x1="80" y1="560" x2="1200" y2="560" stroke="silver" stroke-width="2"/>` +
      bars,
  );
}

/** The stories' stand-in for the relay: `files` maps a path to the picture
 * served for it, and a path missing from it is a file the relay no longer
 * has. `direct` hands out URLs the way a direct profile does; off, every
 * picture is "fetched" after `delayMs`, the way a tailnet profile's are —
 * which is also how a story shows a tile waiting, or one that failed. */
export function simulatedMediaSource(files: Record<string, string>, { direct = true, delayMs = 0 }: { direct?: boolean; delayMs?: number } = {}) {
  return {
    url: (path: string): string | undefined => (direct ? files[path] : undefined),
    load: (path: string): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        window.setTimeout(() => {
          const file = files[path];
          if (file) resolve(file);
          else reject(new Error(`no such file: ${path}`));
        }, delayMs);
      }),
  };
}

/** A source that never answers: every tile and the viewer stay loading. */
export const pendingMediaSource = {
  url: (): string | undefined => undefined,
  load: (): Promise<string> => new Promise<string>(() => {}),
};

/** A real PNG, 4×4 and one colour (every other picture here is an SVG
 * drawn above): what a test that copies the bytes as they are needs, since
 * the test DOM has no canvas to redraw an SVG with. */
export const SWATCH_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR42mNwzHz4HxkzkC4AAFA/KKEUvz3gAAAAAElFTkSuQmCC";

export const SAMPLE_FILES: Record<string, string> = {
  "/tmp/sim/01-sign-in.png": phoneScreenshot("Sign in", "royalblue"),
  "/tmp/sim/02-home.png": phoneScreenshot("Home", "seagreen"),
  "/tmp/sim/03-settings.png": phoneScreenshot("Settings", "darkorange"),
  "/tmp/sim/04-error.png": phoneScreenshot("Couldn't sign in", "crimson"),
  "/tmp/sim/usage-chart.png": landscapeChart("Requests per day"),
  "/tmp/sim/checkout-frame.jpg": phoneScreenshot("Checkout", "slateblue"),
  "/tmp/sim/swatch.png": SWATCH_PNG,
};
