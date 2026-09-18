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

import { registerHandlers, registerProtocolHandler, registerProtocolScheme } from '../../app/main/ipc.mjs';
import { loadSettings } from '../../app/main/settings.mjs';
import { createWindow } from '../../app/main/window.mjs';

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
  { name: '07-field-again', script: 'clickText("button", ["닫기", "Close"])' },
  { name: '08-inventory-pokemon', script: 'clickText("button", ["가방", "Bag"])' },
  { name: '09-inventory-items', script: 'clickText("button.tab", ["아이템", "Items"])' },
  { name: '10-inventory-box', script: 'clickText("button.tab", ["박스", "Box"])' },
  { name: '11-auto-battle', script: 'clickText("button.tab", ["포켓몬", "Pokémon"]) && await wait(250) && clickText("button", ["자동전투", "Auto-battle"])' },
  { name: '12-pokedex', script: 'closeAll() && clickText("button", ["도감", "Pokédex"])' },
  { name: '13-dex-entry', script: 'clickText("button.dex-entry", [])' },
  // An event spawns beyond the right edge and is walked into, so each of these
  // waits for the state it wants rather than for a fixed time.
  { name: '14-event-berry', script: 'closeAll() && await forceEvent("berry") && await waitFor(() => walkStopped(), 25000)' },
  { name: '15-event-berry-held', script: 'await waitFor(() => bagGrew(), 16000)' },
  // A level-5 starter loses every wild battle it is thrown into, which left
  // the tray and capture shots empty. Levelling it first makes the whole tail
  // of the run — win, tray, capture screen — actually reachable.
  { name: '16-battle', script: 'equipForCapture(40) && await forceEvent("wild") && await waitFor(() => inBattle(), 25000) && await wait(1500)' },
  { name: '17-battle-later', script: 'await wait(5000)' },
  { name: '18-battle-end', script: 'await waitFor(() => !inBattle(), 60000) && await wait(1500)' },
  // Seeded rather than won: a wild Pokémon rolls up to fifteen levels above
  // the companion, so no amount of levelling makes the battle a sure thing,
  // and these two shots are about the screens, not the fight.
  { name: '19-tray-menu', script: 'closeAll() && seedTray() && await wait(500) && clickTray() && await wait(600)' },
  { name: '20-capture', script: 'clickText("button", ["포획", "Catch"]) && await wait(1500)' },
  // Last, because it deliberately leaves an event mid-approach: `forceEvent`
  // cannot preempt one that is already running, so anything after it would get
  // this trainer's battle instead of the event it asked for.
  { name: '21-trainer-approach', script: 'closeAll() && await forceEvent("trainer") && await wait(3500)' },
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
const wait = (ms) => new Promise((r) => setTimeout(() => r(true), ms));
const clickImageAlt = (alts) => {
  const image = [...document.querySelectorAll('img')].find((node) => alts.includes(node.alt));
  if (image) { (image.closest('button') || image).click(); return true; }
  console.log('no image alt among: ' + [...document.querySelectorAll('img')].map((n) => n.alt).join(' | '));
  return false;
};
const app = () => window.__pdcApp;
const closeAll = () => {
  while (app().stack.length > 1) app().pop();
  // Menus pause the field through their close handler, which popping skips.
  app().scene.setPaused?.(false);
  return true;
};
/**
 * Reach past the once-a-minute timer so a shot does not have to wait for it.
 * Waits for whatever the game started on its own to finish first, otherwise
 * the forced event is dropped as "already busy".
 */
const forceEvent = async (kind) => {
  closeAll();
  const session = app().session;
  // Wait until the companion is walking again: an event still playing out
  // would make the field ignore the forced roll as "already busy".
  for (let i = 0; i < 160; i++) {
    session.eventTimer = 60000;
    const before = app().scene.offset;
    await wait(400);
    if (app().stack.length === 1 && app().scene.offset > before + 5) break;
    closeAll();
  }
  const roll = session.events.roll;
  session.events.roll = () => { session.events.roll = roll; return kind; };
  session.eventTimer = 0;
  return true;
};
/**
 * Make the run capable of reaching the capture screen: a companion that can
 * win a wild battle, healed through the session so its HP lands on its new
 * maximum rather than some number out of range, and balls to throw.
 */
const equipForCapture = (level) => {
  const session = app().session;
  session.active.experience = Math.round(1.2 * level ** 3);
  session.heal();
  session.addItem('poke-ball', 5);
  return true;
};
/** Put something in the post-battle tray, whether or not the battle went well. */
const seedTray = () => {
  const session = app().session;
  if (session.tray.length === 0) session.addToTray(JSON.parse(JSON.stringify(session.active)));
  return true;
};
/** Open the menu on the first Pokémon waiting in the post-battle tray. */
const clickTray = () => {
  const entry = document.querySelector('.screen button img[src*="/icon.png"]');
  if (entry) { (entry.closest('button') || entry).click(); return true; }
  console.log('tray is empty');
  return false;
};
/** Poll until a predicate holds, or give up so a shot is still taken. */
const waitFor = async (predicate, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await wait(200);
  }
  console.log('waitFor timed out');
  return true;
};
const inBattle = () => app().stack.length > 1;
let lastOffset = -1;
let stillFrames = 0;
const walkStopped = () => {
  const offset = Math.round(app().scene.offset ?? 0);
  stillFrames = offset === lastOffset ? stillFrames + 1 : 0;
  lastOffset = offset;
  return stillFrames > 3;
};
let bagAtStart = -1;
const bagGrew = () => {
  const size = Object.values(app().session.bag).reduce((a, b) => a + b, 0);
  if (bagAtStart < 0) bagAtStart = size;
  return size > bagAtStart;
};
const clickText = (selector, texts) => {
  const nodes = [...document.querySelectorAll(selector)];
  const match = texts.length === 0
    ? nodes[0]
    : nodes.find((node) => texts.some((text) => (node.textContent || '').includes(text)));
  if (match) { match.click(); return true; }
  console.log('no match for ' + JSON.stringify(texts) + ' among: ' + nodes.map((n) => n.textContent).join(' | '));
  return false;
};
`;


