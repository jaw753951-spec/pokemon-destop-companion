#!/usr/bin/env electron
/**
 * Capture the running game, for checking screens without a desktop.
 *
 *   xvfb-run -a npx electron tools/screenshot.mjs [--out shots] [--wait 4000]
 *
 * This is an alternative Electron entry point that boots the real main process
 * modules, then drives the renderer through a short script of clicks so each
 * screen can be photographed. Nothing here is part of the shipped app.
 */
import { app } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { registerHandlers, registerProtocolHandler, registerProtocolScheme } from '../src/main/ipc.mjs';
import { loadSettings } from '../src/main/settings.mjs';
import { createWindow } from '../src/main/window.mjs';

const args = process.argv.slice(2);
const option = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};

const OUT_DIR = option('--out', join(process.cwd(), 'shots'));
const SETTLE_MS = Number(option('--wait', '2500'));

/**
 * Each step names a shot and the renderer-side script that sets it up.
 * Selectors are matched on visible text so the script survives restyling.
 */
const STEPS = [
  { name: '01-title', script: 'null' },
  { name: '02-slots', script: 'clickText("button", ["새 게임", "New Game"])' },
  { name: '03-starter', script: 'clickText("button", ["1."])' },
  {
    name: '04-starter-picked',
    script: 'clickImageAlt(["파이리", "Charmander"])',
  },
  {
    name: '05-field',
    script: 'clickText("button", ["예", "Yes"])',
  },
  { name: '06-settings', script: 'clickText("button", ["설정", "Settings"])' },
];

app.commandLine.appendSwitch('disable-gpu');
registerProtocolScheme();

app.whenReady().then(async () => {
  registerProtocolHandler();
  registerHandlers();

  const window = createWindow({ ...(await loadSettings()), scale: 2, windowX: 0, windowY: 0 });
  await new Promise((resolve) => /** @type {any} */ (window.webContents).once('did-finish-load', resolve));
  await mkdir(OUT_DIR, { recursive: true });

  window.webContents.on('console-message', (_event, _level, message) => console.log(`[renderer] ${message}`));

  await delay(SETTLE_MS);

  for (const step of STEPS) {
    try {
      await window.webContents.executeJavaScript(`(async () => {\n${HELPERS}\nreturn (${step.script});\n})()`, true);
    } catch (error) {
      console.error(`step ${step.name} failed: ${error}`);
    }
    await delay(1200);
    const image = await window.webContents.capturePage();
    await writeFile(join(OUT_DIR, `${step.name}.png`), image.toPNG());
    console.log(`captured ${step.name}`);
  }

  app.quit();
});

app.on('window-all-closed', () => app.quit());

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Injected before every step's script. */
const HELPERS = `
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clickImageAlt = (alts) => {
  const image = [...document.querySelectorAll('img')].find((node) => alts.includes(node.alt));
  if (image) { (image.closest('button') || image).click(); return true; }
  console.log('no image alt among: ' + [...document.querySelectorAll('img')].map((n) => n.alt).join(' | '));
  return false;
};
const clickText = (selector, texts) => {
  const nodes = [...document.querySelectorAll(selector)];
  const match = nodes.find((node) => texts.some((text) => (node.textContent || '').includes(text)));
  if (match) { match.click(); return true; }
  console.log('no match for ' + JSON.stringify(texts) + ' among: ' + nodes.map((n) => n.textContent).join(' | '));
  return false;
};
`;


