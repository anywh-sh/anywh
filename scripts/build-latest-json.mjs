// Composes the phase-B updater manifest (`latest.json`) once, in the
// `checksums` job, from the per-platform assets and `.sig` files every
// `build` matrix leg has already uploaded to the same draft release.
//
// tauri-action can generate this file itself (`uploadUpdaterJson`, on by
// default), but it does so by having *each* matrix leg read the release's
// current `latest.json`, merge its own platform in, and re-upload — a
// read-merge-write against the same GitHub release with no locking. Two
// legs finishing close enough together race, and the loser's write drops
// whatever key the winner hadn't merged in yet, silently. Building the
// manifest exactly once, after every leg has finished uploading, has no
// such race by construction. `release.yml`'s `build` job disables
// `uploadUpdaterJson` for this reason; this script is what replaces it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// {os}-{arch} -> the exact filename Tauri's bundler produces for it, with
// `createUpdaterArtifacts: true` on. Verified against a live `-rc` trial
// tag rather than guessed from docs — `windows-x86_64` in particular ships
// as a plain signed `.exe`, not the `.nsis.zip` an earlier draft of this
// plan assumed.
const PLATFORMS = {
  "darwin-aarch64": () => "anywh_aarch64.app.tar.gz",
  "darwin-x86_64": () => "anywh_x64.app.tar.gz",
  "linux-x86_64": (version) => `anywh_${version}_amd64.AppImage`,
  "linux-aarch64": (version) => `anywh_${version}_aarch64.AppImage`,
  "windows-x86_64": (version) => `anywh_${version}_x64-setup.exe`,
};

// The URL points at this tag specifically, never at the unversioned
// `releases/latest/download/` aliases `checksums` also publishes — those
// aliases are copies for install.sh's benefit and never get a `.sig` of
// their own, so half of a manifest built from them would 404 on verify.
export function buildLatestJson({ distDir, version, repoUrl, notes = "", pubDate = new Date().toISOString() }) {
  const platforms = {};
  for (const [key, fileNameFor] of Object.entries(PLATFORMS)) {
    const fileName = fileNameFor(version);
    const assetPath = join(distDir, fileName);
    const sigPath = `${assetPath}.sig`;
    if (!existsSync(assetPath) || !existsSync(sigPath)) {
      throw new Error(`missing ${assetPath} or its .sig — can't build latest.json's "${key}" entry`);
    }
    platforms[key] = {
      signature: readFileSync(sigPath, "utf8"),
      url: `${repoUrl}/releases/download/v${version}/${fileName}`,
    };
  }
  return { version, notes, pub_date: pubDate, platforms };
}

function main() {
  const distDir = process.argv[2] || "dist";
  const version = (process.env.GITHUB_REF_NAME || "").replace(/^v/, "");
  const repository = process.env.GITHUB_REPOSITORY;
  const notes = process.env.RELEASE_NOTES || "";

  if (!version || !repository) {
    console.error("GITHUB_REF_NAME and GITHUB_REPOSITORY must be set — this script only runs inside the release workflow");
    process.exit(1);
  }

  const manifest = buildLatestJson({ distDir, version, repoUrl: `https://github.com/${repository}`, notes });
  const outPath = join(distDir, "latest.json");
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`wrote ${outPath} for v${version}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
