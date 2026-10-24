#!/usr/bin/env node
// Screenshot the DSH client UI (served by tools/dev-proxy.mjs on :8099) with
// Playwright's Chromium at the two form factors the Android client targets.
//
// Usage:
//   node tools/dev-proxy.mjs &
//   node tools/shot.mjs                    # -> /tmp/dsh-ui-390.png, /tmp/dsh-ui-960.png
//   node tools/shot.mjs --url 'http://127.0.0.1:8099/index.html?demo'
//
// Waits for '#app[data-ready="1"]' when the page exposes it (max 8s), prints
// console/page errors so UI breakage is visible in the terminal.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireUiTools = createRequire('/root/ui-tools/index.js');
let playwright;
try {
  playwright = requireUiTools('playwright-core');
} catch (e) {
  try {
    playwright = createRequire('/root/ui-tools/node_modules/playwright-core/package.json')('playwright-core');
  } catch (e2) {
    console.error('playwright-core not found under /root/ui-tools/node_modules');
    process.exit(2);
  }
}
const { chromium } = playwright;

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const URL = opt('url', 'http://127.0.0.1:8099/index.html');
const OUT_DIR = opt('out', '/tmp');
const SIZES = [
  { name: '390', width: 390, height: 844 },
  { name: '960', width: 960, height: 540 },
];
const CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/root/.cache/ms-playwright/chromium-1200/chrome-linux/chrome',
];
function findExecutable() {
  const explicit = opt('executable', '');
  if (explicit) return explicit;
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  // Any playwright-cached chromium.
  const base = '/root/.cache/ms-playwright';
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

async function main() {
  const executablePath = findExecutable();
  if (!executablePath) {
    console.error('no chromium binary found (looked at /usr/bin/chromium and playwright cache)');
    process.exit(2);
  }
  const browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const outputs = [];
  for (const size of SIZES) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 1,
      // Chrome 91-era UA to approximate the Android WebView target.
      userAgent: 'Mozilla/5.0 (Linux; Android 13; DSH-Client) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Mobile Safari/537.36',
    });
    const page = await context.newPage();
    const logs = [];
    page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') logs.push('[console.' + msg.type() + '] ' + msg.text()); });
    page.on('pageerror', (err) => logs.push('[pageerror] ' + err.message));
    const response = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => {
      logs.push('[goto] ' + e.message);
      return null;
    });
    const status = response ? response.status() : 0;
    // Wait for the app to declare readiness when it exposes the hook.
    const hasApp = await page.$('#app').catch(() => null);
    if (hasApp) {
      try {
        await page.waitForSelector('#app[data-ready="1"]', { timeout: 8000 });
      } catch (e) {
        logs.push('[ready] #app did not reach data-ready="1" within 8s');
      }
    } else {
      logs.push('[ready] no #app element on page');
    }
    // Let layout settle one frame.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
    const file = path.join(OUT_DIR, 'dsh-ui-' + size.name + '.png');
    await page.screenshot({ path: file, fullPage: false });
    outputs.push({ file, size: size.width + 'x' + size.height, status });
    if (logs.length) console.log('--- ' + size.width + 'x' + size.height + ' page log ---\n' + logs.join('\n'));
    await context.close();
  }
  await browser.close();
  for (const o of outputs) console.log('screenshot', o.file, '(' + o.size + ', HTTP ' + o.status + ')');
}

main().catch((e) => {
  console.error('screenshot failed:', e && e.stack || e);
  process.exit(1);
});
