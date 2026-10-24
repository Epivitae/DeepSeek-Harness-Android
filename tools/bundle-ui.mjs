#!/usr/bin/env node
/**
 * Bundle the DSH web UI into fully self-contained HTML files for the Android
 * WebView assets directory.
 *
 * Input : web/index.html (+ its local <link rel="stylesheet"> / <script src>
 *         files, and optionally web/setup.html)
 * Output: app/assets/ui/index.html (and setup.html when present)
 *
 * Why: the shell loads the HTML with
 *   WebView.loadDataWithBaseURL(serverOrigin, html, "text/html", "utf-8", null)
 * so the page is same-origin with the DSH server. In that mode the document may
 * only have a base URL, never relative asset requests: every local CSS/JS file
 * must be inlined. Remote URLs (https://...) are left untouched, but relative
 * local references are an error.
 *
 * Chrome 91 WebView target: no ES module imports, plain <script> tags.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = join(ROOT, "web");
const OUT_DIR = join(ROOT, "app", "assets", "ui");
const PLACEHOLDER_DIR = join(ROOT, "tools", "placeholders");

const TARGETS = [
  { name: "index.html", required: true, fallback: true },
  { name: "setup.html", required: false, fallback: false },
];

const errors = [];
const warnings = [];

function log(msg) {
  console.log("[bundle-ui] " + msg);
}
function warn(msg) {
  warnings.push(msg);
  console.warn("[bundle-ui] WARN " + msg);
}
function error(msg) {
  errors.push(msg);
  console.error("[bundle-ui] ERROR " + msg);
}

function stripQuery(ref) {
  return ref.replace(/[?#].*$/, "");
}

function isRemoteRef(ref) {
  return (
    /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(ref) || // http(s)://, //cdn...
    /^[a-z][a-z0-9+.-]*:/i.test(ref) || // data:, blob:, mailto:, javascript:
    ref.startsWith("#") ||
    ref === ""
  );
}

function resolveLocalRef(ref, baseDir) {
  if (isRemoteRef(ref)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return null;
  return resolve(baseDir, stripQuery(ref));
}

function fileToDataUri(file) {
  const ext = file.toLowerCase().split(".").pop();
  const mime = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
  }[ext];
  if (!mime) return null;
  return "data:" + mime + ";base64," + readFileSync(file).toString("base64");
}

/** Inline <link rel="stylesheet" href="local.css"> and local url(...) in CSS. */
function inlineLinks(html, baseDir) {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(tag);
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!rel || !href || !/stylesheet/i.test(rel[1]) || isRemoteRef(href[1])) {
      return tag;
    }
    const file = resolveLocalRef(href[1], baseDir);
    if (!file || !existsSync(file)) {
      error(`stylesheet not found: ${href[1]} (from ${baseDir})`);
      return tag;
    }
    let css = readFileSync(file, "utf8");
    css = inlineCssUrls(css, dirname(file));
    const media = /\bmedia\s*=\s*["']([^"']*)["']/i.exec(tag);
    const mediaAttr = media ? ` media="${media[1]}"` : "";
    log(`inlined <link> ${stripQuery(href[1])} (${css.length} bytes)`);
    return `<style${mediaAttr}>\n/* inlined from ${stripQuery(href[1])} */\n${css}\n</style>`;
  });
}

function inlineCssUrls(css, cssDir) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, ref) => {
    const trimmed = ref.trim();
    if (isRemoteRef(trimmed)) return match;
    const file = resolveLocalRef(trimmed, cssDir);
    if (!file || !existsSync(file)) {
      warn(`CSS url() not inlined (missing file): ${trimmed} (from ${cssDir})`);
      return match;
    }
    const dataUri = fileToDataUri(file);
    if (!dataUri) {
      warn(`CSS url() not inlined (unsupported type): ${trimmed}`);
      return match;
    }
    log(`inlined CSS url() ${trimmed}`);
    return `url("${dataUri}")`;
  });
}

/** Inline local <script src="local.js"></script>. */
function inlineScripts(html, baseDir) {
  return html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (tag, attrs) => {
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (!src || isRemoteRef(src[1])) return tag;
    const file = resolveLocalRef(src[1], baseDir);
    if (!file || !existsSync(file)) {
      error(`script not found: ${src[1]} (from ${baseDir})`);
      return tag;
    }
    const js = readFileSync(file, "utf8");
    const keptAttrs = attrs.replace(/\s*src\s*=\s*["'][^"']*["']/i, "");
    log(`inlined <script> ${stripQuery(src[1])} (${js.length} bytes)`);
    return `<script${keptAttrs}>\n// inlined from ${stripQuery(src[1])}\n${js}\n</script>`;
  });
}

/** Inline local <img src> as data URIs. */
function inlineImages(html, baseDir) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!src || isRemoteRef(src[1])) return tag;
    const file = resolveLocalRef(src[1], baseDir);
    if (!file || !existsSync(file)) {
      warn(`image not found, left as-is: ${src[1]}`);
      return tag;
    }
    const dataUri = fileToDataUri(file);
    if (!dataUri) {
      warn(`image type not inlinable, left as-is: ${src[1]}`);
      return tag;
    }
    log(`inlined <img> ${stripQuery(src[1])}`);
    return tag.replace(src[0], src[0].replace(src[1], dataUri));
  });
}

function ensureViewport(html) {
  if (/<meta[^>]+name\s*=\s*["']viewport["']/i.test(html)) return html;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    warn("no viewport meta; injected width=device-width");
    return html.replace(
      /<head(\s[^>]*)?>/i,
      (m) => `${m}\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
    );
  }
  return html;
}

function ensureFavicon(html) {
  if (/rel\s*=\s*["'](?:shortcut )?icon["']/i.test(html)) return html;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n<link rel="icon" href="data:,">`);
  }
  return html;
}

/** Any local src/href that survived inlining would 404 against the server base. */
function findUnresolvedLocalRefs(html, label) {
  const leftovers = [];
  const re =
    /<(script|link|img|source|audio|video|iframe|input)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const ref = match[2];
    if (isRemoteRef(ref)) continue;
    leftovers.push(`${label}: <${match[1]}> still references local "${ref}"`);
  }
  return leftovers;
}

function writeBundled(name, html, sourceLabel) {
  const header =
    `<!-- BUNDLED by tools/bundle-ui.mjs from ${sourceLabel}; DO NOT EDIT. ` +
    `All CSS/JS is inlined because this HTML is loaded with ` +
    `loadDataWithBaseURL(DSH server origin). -->\n`;
  const outPath = join(OUT_DIR, name);
  writeFileSync(outPath, header + html, "utf8");
  log(`wrote ${outPath} (${header.length + html.length} chars)`);
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  for (const target of TARGETS) {
    const sourcePath = join(WEB_DIR, target.name);
    const placeholderPath = join(PLACEHOLDER_DIR, target.name);
    let source;
    let sourceLabel;

    if (existsSync(sourcePath)) {
      source = readFileSync(sourcePath, "utf8");
      sourceLabel = `web/${target.name}`;
    } else if (target.fallback && existsSync(placeholderPath)) {
      source = readFileSync(placeholderPath, "utf8");
      sourceLabel = `tools/placeholders/${target.name} (web/${target.name} not present)`;
      warn(`web/${target.name} not found; using ${sourceLabel}`);
    } else {
      if (target.required) {
        error(`required source missing: web/${target.name}`);
      } else {
        log(`skip ${target.name}: web/${target.name} not present`);
      }
      if (!target.required) {
        const stale = join(OUT_DIR, target.name);
        if (existsSync(stale)) {
          rmSync(stale);
          log(`removed stale ${stale}`);
        }
      }
      continue;
    }

    let html = source;
    html = inlineLinks(html, WEB_DIR);
    html = inlineScripts(html, WEB_DIR);
    html = inlineImages(html, WEB_DIR);
    html = ensureViewport(html);
    html = ensureFavicon(html);

    for (const ref of findUnresolvedLocalRefs(html, `web/${target.name}`)) {
      error(ref);
    }

    writeBundled(target.name, html, sourceLabel);
  }

  if (warnings.length) {
    log(`${warnings.length} warning(s)`);
  }
  if (errors.length) {
    console.error(`[bundle-ui] FAILED with ${errors.length} error(s)`);
    process.exit(1);
  }
  log("OK");
}

main();
