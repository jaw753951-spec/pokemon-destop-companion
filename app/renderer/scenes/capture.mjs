/**
 * The capture screen.
 *
 * Laid out like Pokémon GO's: the target in the middle, the balls you actually
 * hold along the bottom with their real odds printed underneath, and the
 * throws you have left counted in the corner. Three throws, then it flees.
 */
import { CAPTURE_ATTEMPTS, FIELD_HEIGHT, FIELD_WIDTH, VIEW_HEIGHT, VIEW_WIDTH } from '../../shared/constants.mjs';
import { loadSprite } from '../core/assets.mjs';
import { url } from '../core/bridge.mjs';
import { artOf, gameData, speciesOf } from '../core/data.mjs';
import { button, el, setChildren } from '../core/dom.mjs';
import { name as localized, t } from '../core/i18n.mjs';
import { attemptCapture, captureChance } from '../engine/capture.mjs';
import { Battler, fitScale } from '../render/battler.mjs';
import { inFieldSpace } from '../render/field.mjs';
import { prompt } from '../ui/dialog.mjs';

/**
 * @param {{
 *   session: import('../engine/session.mjs').Session,
 *   target: import('../engine/pokemon.mjs').Pokemon,
 *   onFinish: (caught: boolean) => void,
 * }} options
 * @returns {import('../core/app.mjs').Scene}
 */
export function captureScene({ session, target, onFinish }) {
  let attempts = CAPTURE_ATTEMPTS;
  let busy = false;
  let settled = false;

  /** @type {Battler|null} */
  let battler = null;

  const label = () => localized(speciesOf(target.speciesId)?.name, '');
  const counter = el('div.capture-attempts');
  const message = el('div.battle-message', {
    text: target.shiny ? `${t('capture.title')}  ${t('battle.shiny')}` : t('capture.title'),
  });
  const balls = el('div.capture-balls');

  return {
    keepBelow: true,

    mount(app) {
      const art = artOf(target, 'front');
      if (art) {
        loadSprite(art.path, art.meta).then((sprite) => {
          // Field coordinates, so the target is the size it was on the path.
          const y = Math.round(FIELD_HEIGHT * 0.52);
          battler = new Battler({
            sprite,
            x: Math.round(FIELD_WIDTH / 2),
            y,
            facing: -1,
            // Clear of the name above it and the balls below, whatever size the
            // species is drawn at.
            scale: fitScale(sprite, { width: FIELD_WIDTH - 24, height: y - 14 }, 1),
          });
        });
      }
      app.audio.playCry(target.speciesId);

      renderCounter();
      renderBalls(app);

      return el('div.screen.capture-screen', {}, [
        counter,
        el('div.capture-name', { text: `${label()}` }),
        balls,
        message,
        el('div.capture-close', {}, [
          button(t('common.cancel'), () => finish(app, false), { className: 'small ghost' }),
        ]),
      ]);
    },

    update(deltaMs) {
      battler?.update(deltaMs);
    },

    render(context) {
      context.fillStyle = 'rgba(10, 14, 24, 0.78)';
      context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
      inFieldSpace(context, (field) => battler?.draw(field));
    },
  };

  /** The throws left, counted in balls — three of them say it without a word. */
  function renderCounter() {
    setChildren(counter, [
      ...Array.from({ length: CAPTURE_ATTEMPTS }, (_, index) =>
        el('img', {
          src: url('assets', 'items/poke-ball.png'),
          alt: '',
          style: { width: '12px', height: '12px', opacity: index < attempts ? '1' : '0.25' },
        }),
      ),
    ]);
  }

  /** @param {import('../core/app.mjs').App} app */
  function renderBalls(app) {
    const held = session.balls();
    if (held.length === 0) {
      balls.replaceChildren(el('span.meta', { text: t('capture.noBalls') }));
      return;
    }

    setChildren(balls, [
      ...held.map(({ slug, count, item }) => {
        const chance = Math.round(captureChance(target, slug) * 100);
        return el('button.capture-ball', {
          type: 'button',
          disabled: busy,
          title: localized(item.name, slug),
          onClick: () => throwBall(app, slug),
        }, [
          el('img', { src: url('assets', `items/${slug}.png`), alt: localized(item.name, slug) }),
          el('span.count', { text: t('items.count', { count }) }),
          el('span.odds', { text: t('capture.rate', { rate: chance }) }),
        ]);
      }),
    ]);
  }

  /**
   * @param {import('../core/app.mjs').App} app
   * @param {string} ball
   */
  async function throwBall(app, ball) {
    if (busy || settled || attempts <= 0) return;
    if (!session.removeItem(ball)) return;

    busy = true;
    attempts--;
    renderCounter();
    renderBalls(app);
    app.audio.blip('select');

    const result = attemptCapture(session.rng, target, ball);
    // Let the shakes play out before saying what happened.
    await wait(400 + result.shakes * 320);

    if (result.caught) {
      settled = true;
      app.audio.blip('catch');
      app.audio.playMusic(gameData().bgm.cues.caught ?? null);
      message.textContent = t('capture.success', { name: label() });

      const nickname = await prompt(app, t('capture.nickname', { name: label() }), {
        placeholder: t('capture.nicknamePlaceholder'),
        maxLength: 12,
      });
      target.nickname = nickname;
      target.ball = ball;
      const stored = session.storeInBox(target);

      app.toast(stored
        ? t('capture.sentToBox', { name: target.nickname || label() })
        : t('capture.boxFull'));
      finish(app, true);
      return;
    }

    busy = false;
    if (attempts <= 0) {
      settled = true;
      message.textContent = t('capture.fled', { name: label() });
      app.audio.blip('cancel');
      await wait(1200);
      finish(app, false);
      return;
    }

    message.textContent = t('capture.failed');
    renderBalls(app);
  }

  /**
   * @param {import('../core/app.mjs').App} app
   * @param {boolean} caught
   */
  function finish(app, caught) {
    if (!caught) app.audio.blip('cancel');
    onFinish(caught);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
