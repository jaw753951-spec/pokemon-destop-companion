/**
 * The companion window.
 *
 * It is a frameless, transparent, always-on-top panel taking roughly one
 * sixteenth of the screen's area — a quarter of its width and height — pinned
 * to the top of the desktop and dragged by its own title strip, in the manner
 * of desktop pets like Ruety's Retirement. The renderer always draws at a
 * fixed 480x270 and is scaled to fit, so the pixel art stays exact.
 */
import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';

import { RENDERER_DIR } from './paths.mjs';
import { VIEW_HEIGHT, VIEW_WIDTH } from '../shared/constants.mjs';

/** @type {BrowserWindow|null} */
let current = null;

/**
 * @param {import('./settings.mjs').Settings} settings
 * @returns {BrowserWindow}
 */
export function createWindow(settings) {
  const { width, height } = windowSize(settings.scale);
  const position = clampToDisplay(settings.windowX, settings.windowY, width, height);

  current = new BrowserWindow({
    width,
    height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    useContentSize: true,
    webPreferences: {
      preload: join(RENDERER_DIR, '..', 'preload', 'bridge.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' keeps the companion above full-screen apps too, which is the
  // point of a desktop companion; without it the window hides behind games.
  current.setAlwaysOnTop(true, 'screen-saver');
  current.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  current.loadFile(join(RENDERER_DIR, 'index.html'));
  current.on('closed', () => {
    current = null;
  });

  return current;
}

/** @returns {BrowserWindow|null} */
export function getWindow() {
  return current && !current.isDestroyed() ? current : null;
}

/**
 * Resize around the window's current centre, so changing the scale does not
 * throw the companion into a corner.
 *
 * The centre is kept in so far as the resized window can stay on screen; when
 * it cannot, the window slides back just far enough to fit rather than being
 * teleported to the default top-centre spot — the user placed the companion,
 * and a scale change should not undo that.
 *
 * @param {number} scale
 */
export function applyScale(scale) {
  const window = getWindow();
  if (!window) return null;

  const { width, height } = windowSize(scale);
  const [currentWidth, currentHeight] = window.getContentSize();
  const [x, y] = window.getPosition();
  const centreX = x + currentWidth / 2;
  const centreY = y + currentHeight / 2;

  const position = keepOnDisplay(Math.round(centreX - width / 2), Math.round(centreY - height / 2), width, height);
  window.setContentSize(width, height);
  window.setPosition(position.x, position.y);
  return { width, height, ...position };
}

/**
 * The companion occupies about 1/16 of the screen's area at scale 1, so a
 * quarter of each dimension, held to the renderer's 16:9 aspect.
 * @param {number} scale
 */
export function windowSize(scale) {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const target = Math.min(screenWidth / 4, (screenHeight / 4) * (VIEW_WIDTH / VIEW_HEIGHT));
  const width = Math.max(VIEW_WIDTH / 2, Math.round((target * scale) / 2) * 2);
  return { width, height: Math.round((width * VIEW_HEIGHT) / VIEW_WIDTH) };
}

/**
 * Keep the window on a real display. Defaults to the top centre of the primary
 * screen, which is where a companion belongs.
 */
function clampToDisplay(x, y, width, height) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      x: Math.round(primary.workArea.x + (primary.workArea.width - width) / 2),
      y: primary.workArea.y + 8,
    };
  }

  const fits = displays.some((display) => {
    const area = display.workArea;
    return x + width > area.x && x < area.x + area.width && y + height > area.y && y < area.y + area.height;
  });
  if (fits) return { x: Math.round(x), y: Math.round(y) };

  return {
    x: Math.round(primary.workArea.x + (primary.workArea.width - width) / 2),
    y: primary.workArea.y + 8,
  };
}

/**
 * Nudge a window that would sit partly or wholly off-screen back into the
 * display it came from, rather than relocating it. The least move that fits
 * wins: a companion dragged half onto a second monitor stays on that monitor.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 */
function keepOnDisplay(x, y, width, height) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      x: Math.round(primary.workArea.x + (primary.workArea.width - width) / 2),
      y: primary.workArea.y + 8,
    };
  }

  // The display holding most of the window today is the one it belongs on.
  let best = null;
  let bestOverlap = -1;
  for (const display of displays) {
    const area = display.workArea;
    const overlapX = Math.max(0, Math.min(x + width, area.x + area.width) - Math.max(x, area.x));
    const overlapY = Math.max(0, Math.min(y + height, area.y + area.height) - Math.max(y, area.y));
    const overlap = overlapX * overlapY;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = area;
    }
  }
  if (!best) best = primary.workArea;

  return {
    x: Math.round(Math.max(best.x, Math.min(x, best.x + best.width - width))),
    y: Math.round(Math.max(best.y, Math.min(y, best.y + best.height - height))),
  };
}
