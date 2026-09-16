import { deleteTheme, listThemes, saveTheme, ThemeValidationFailure } from "../host/themeRegistry.js";
import { isValidThemeId } from "../host/theme.js";
import { readJsonBody } from "../protocol/httpBody.js";
import type { RouteHandler } from "./context.js";

// Themes are registered per host, not per profile (themeRegistry.ts): the
// same custom theme has to be selectable from every profile, and every
// device that syncs against this host sees the same list. Which theme a
// given profile uses is `themeId` on its own metadata, patched through the
// profiles route.
export const handleThemeRoutes: RouteHandler = async (req, res) => {
  if (req.method === "GET" && req.url === "/control/themes") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      res.end(JSON.stringify({ themes: listThemes() }));
    } catch (error) {
      console.error("[relay] failed to list themes:", error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "failed to list themes" }));
    }
    return true;
  }

  if (req.method === "PUT" && req.url?.startsWith("/control/themes/")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const id = decodeURIComponent(req.url.slice("/control/themes/".length).split("?")[0]);
    // The id becomes a filename, so it's checked before anything reaches the
    // filesystem — `saveTheme` validates the body's own id again, but the
    // path here would be built from this one either way.
    if (!isValidThemeId(id)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid theme id" }));
      return true;
    }
    await readJsonBody(req)
      .then((body) => {
        if (typeof body !== "object" || body === null || (body as { id?: unknown }).id !== id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "theme id does not match the url" }));
          return;
        }
        try {
          res.end(JSON.stringify(saveTheme(body)));
        } catch (error) {
          if (error instanceof ThemeValidationFailure) {
            // The per-field errors travel back so the import UI can point at
            // the offending line instead of saying "invalid theme".
            res.writeHead(422);
            res.end(JSON.stringify({ error: "invalid theme", errors: error.errors }));
            return;
          }
          console.error("[relay] failed to save theme:", error);
          res.writeHead(500);
          res.end(JSON.stringify({ error: "failed to save theme" }));
        }
      })
      .catch(() => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
      });
    return true;
  }

  if (req.method === "DELETE" && req.url?.startsWith("/control/themes/")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const id = decodeURIComponent(req.url.slice("/control/themes/".length).split("?")[0]);
    try {
      if (!deleteTheme(id)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "theme not found" }));
        return true;
      }
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      console.error("[relay] failed to delete theme:", error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "failed to delete theme" }));
    }
    return true;
  }

  return false;
};
