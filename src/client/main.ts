/*eslint @typescript-eslint/no-use-before-define:["error", { "functions": false }]*/
// eslint-disable-next-line import/order
const local_storage = require('glov/client/local_storage');
local_storage.setStoragePrefix('glovjs-playground'); // Before requiring anything else that might load from this

import assert from 'assert';
import { MODE_DEVELOPMENT, platformParameterGet } from 'glov/client/client_config';
import {
  debugDefineIsSet,
  startup as engineStartup,
  setState,
} from 'glov/client/engine';
import { localStorageGet, localStorageGetJSON, localStorageSetJSON } from 'glov/client/local_storage';
import { netInit } from 'glov/client/net';
import { scoreAlloc, ScoreSystem } from 'glov/client/score';
import { terminalCreate } from 'glov/client/terminal';
import { terminalSettingsInit, terminalSettingsShow } from 'glov/client/terminal_settings';
import { scaleSizes, setFontHeight } from 'glov/client/ui';
import { ansi } from 'glov/common/ansi';
import { SOUND_DATA } from './sound_data';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { floor, random, min } = Math;

window.Z = window.Z || {};
Z.BACKGROUND = 1;
Z.SPRITES = 10;

// let app = exports;
// Virtual viewport for our game logic
const game_width = 720;
const game_height = 400;

let terminal: ReturnType<typeof terminalCreate>;

export type Score = {
  a: number;
  b: number;
};
let score_system: ScoreSystem<Score>;

function init(): void {
  terminal = terminalCreate({
    z: Z.BACKGROUND + 1,
  });

  const ENCODE_A = 10000;
  score_system = scoreAlloc({
    score_to_value: (score: Score): number => {
      return score.a + score.b * ENCODE_A;
    },
    value_to_score: (value: number): Score => {
      let a = value % ENCODE_A;
      value -= a;
      let b = value / ENCODE_A;
      return {
        a,
        b,
      };
    },
    level_defs: 1,
    score_key: 'LDXX',
    ls_key: 'ldXX',
    asc: false,
    rel: 12,
    num_names: 3,
    histogram: false,
  });
}
export function scoreSystem(): ScoreSystem<Score> {
  return score_system;
}


type GameData = {
  a: number;
  b: number;
};
class GameState {
  mode: 'explore' | 'combat' = 'explore';
  data: GameData = { a: 0, b: 0 };
}
let game_state: GameState;
export function gameState(): GameState {
  return game_state;
}
export function saveGame(): void {
  localStorageSetJSON<SavedGame>('savegame', game_state.data);
}

export function setScore(): void {
  let score: Score = {
    a: game_state.data.a,
    b: game_state.data.b,
  };
  score_system.setScore(0, score);
}

function statePlay(dt: number): void {
  // TODO
}

const MENU_W = 20;
const MENU_X = (80 - MENU_W) / 2;
const MENU_Y = 5;

function menu(dt: number): void {
  let sel = terminal.menu({
    x: MENU_X,
    y: 5,
    items: [
      'New Game ',
      `${ansi.yellow.bright('[O]')}ptions `,
      ...(canLoad() ? ['Continue '] : []),
    ],
  });

  switch (sel) { // eslint-disable-line default-case
    case 0:
      newGameInit();
      break;
    case 1:
      terminalSettingsShow();
      break;
    case 2:
      loadGame();
      break;
  }

  terminal.render();
}

function menuInit(): void {
  terminal.baud = 9600;
  terminal.color(7,0);
  terminal.clear();
  terminalSettingsInit(terminal);

  terminal.cells({
    x: MENU_X - 2, y: MENU_Y - 1, ws: [MENU_W], hs: [3], charset: 2,
    header: ' MENU ',
  });

  setState(menu);
}

type SavedGame = GameData;

export function backToGame(): void {
  setState(statePlay);
}

export function newGameInit(): void {
  game_state = new GameState();
  setState(statePlay);
}

export function loadGame(): void {
  let data = localStorageGetJSON<SavedGame>('savegame');
  assert(data);
  game_state = new GameState();
  game_state.data = data;
  setState(statePlay);
}

export function canLoad(): boolean {
  return Boolean(localStorageGet('savegame'));
}


export function main(): void {
  if (platformParameterGet('reload_updates') && MODE_DEVELOPMENT) {
    // Enable auto-reload, etc
    // eslint-disable-next-line n/global-require
    netInit({ engine: require('glov/client/engine') });
  }

  if (!engineStartup({
    game_width,
    game_height,
    pixely: 'strict',
    viewport_postprocess: true,
    font: {
      // eslint-disable-next-line n/global-require
      info: require('./img/font/vga_16x1.json'),
      texture: 'font/vga_16x1',
    },
    pixel_aspect: (640/480) / (720 / 400),
    show_fps: false,
    ui_sounds: SOUND_DATA,
  })) {
    return;
  }
  // font = uiGetFont();

  // Perfect sizes for pixely modes
  scaleSizes(13 / 32);
  setFontHeight(16);

  // let rpgdata;
  // const RPG_BODY_W = 60-2;
  // const RPG_STATUS_W = 20-2;
  // const RPG_STATUS_H = 3;
  // const RPG_STATUS_X = RPG_BODY_W + 2;
  // let rpgsubview;
  // function rpgText(text) {
  //   terminal.subViewPush(rpgsubview);
  //   terminal.print({
  //     text: text,
  //   });
  //   terminal.subViewPop();
  // }
  // const RPG_STATES = {
  //   town: {
  //     enter: function () {
  //       rpgText('You stand in the town square, ready for adventure!  Or,\r\nperhaps, a break.\r\n');
  //     },
  //     menu: {
  //       '[1] Visit the Inn': 'inn',
  //       '[2] Fight a Monster': 'fight',
  //     },
  //   },
  //   inn: {
  //     enter: function () {
  //       rpgText('You rest, and are healed.\r\n\r\n');
  //       rpgdata.hp = rpgdata.maxhp;
  //       rpgState('town');
  //     },
  //   },
  //   fight: {
  //     enter: function () {
  //       rpgText('You head into the forest to fight...\r\n');
  //       let damage = floor(random() * random() * 50);
  //       if (damage) {
  //         rpgText(`You take ${ansi.red(damage)} damage.\r\n`);
  //         rpgdata.hp -= damage;
  //       } else {
  //         rpgText('You escape unscathed.\r\n');
  //       }
  //       let gp = floor(random() * 20);
  //       rpgText(`You find ${ansi.yellow.bright(gp)} GP.\r\n`);
  //       rpgdata.gp += gp;
  //       rpgText('\r\n');
  //       rpgState('town');
  //     },
  //   },
  // };
  // function rpgState(state) {
  //   let st = RPG_STATES[state];
  //   rpgdata.state = state;

  //   st.enter();
  //   if (rpgdata.state !== state) {
  //     // already left
  //     return;
  //   }
  //   terminal.subViewPush(rpgsubview);
  //   if (st.menu) {
  //     // eslint-disable-next-line @typescript-eslint/no-unused-vars
  //     for (let key in st.menu) {
  //       terminal.print({ text: '\n' });
  //     }
  //     terminal.print({ text: '> ' });
  //   }

  //   terminal.subViewPop();
  //   rpgdata.menu_cursor_x = rpgsubview.cursor_x;
  //   rpgdata.menu_cursor_y = rpgsubview.cursor_y;
  //   rpgdata.menu_x = rpgsubview.x;
  //   rpgdata.menu_y = rpgsubview.cursor_y - Object.keys(st.menu).length;
  // }
  // function rpgInit() {
  //   rpgdata = {
  //     hp: 100,
  //     maxhp: 100,
  //     gp: 0,
  //   };
  //   rpgsubview = {
  //     x: 1, y: 1, w: RPG_BODY_W, h: 23,
  //     cursor_x: 1, cursor_y: 1,
  //   };
  //   terminal.color(7,0);
  //   terminal.clear();

  //   terminal.color(4,0);
  //   terminal.cells({
  //     x: 0, y: 0, ws: [RPG_BODY_W], hs: [23], charset: 1,
  //     header: ' THE RPG ',
  //   });
  //   terminal.color(2,0);
  //   terminal.cells({
  //     x: RPG_STATUS_X, y: 0, ws: [RPG_STATUS_W], hs: [RPG_STATUS_H], charset: 0,
  //     header: ' Status ',
  //   });
  //   terminal.color(7,0);
  //   rpgState('town');
  // }
  // function rpg(dt) {

  //   function drawStatus() {
  //     let health_percent = rpgdata.hp / rpgdata.maxhp;
  //     let health_color = health_percent < 0.5 ? 'red' : 'green';
  //     terminal.print({
  //       x: RPG_STATUS_X + 2,
  //       y: 1,
  //       fg: 2,
  //       text: padRight(`HP: ${ansi[health_color].bright(`${rpgdata.hp} / ${rpgdata.maxhp}`)}  `, RPG_STATUS_W - 2),
  //     });
  //     terminal.print({
  //       x: RPG_STATUS_X + 2,
  //       y: 2,
  //       fg: 2,
  //       text: padRight(`GP: ${ansi.yellow.bright(rpgdata.gp)}  `, RPG_STATUS_W - 2),
  //     });
  //   }

  //   drawStatus();

  //   let st = RPG_STATES[rpgdata.state];
  //   if (st && st.menu) {
  //     if (!st.menu_keys) {
  //       st.menu_keys = Object.keys(st.menu);
  //     }
  //     let ret = terminal.menu({
  //       pre_sel: ' ■ ',
  //       pre_unsel: '   ',
  //       x: rpgdata.menu_x,
  //       y: rpgdata.menu_y,
  //       items: st.menu_keys,
  //     });
  //     terminal.moveto(rpgdata.menu_cursor_x, rpgdata.menu_cursor_y);
  //     if (ret !== -1) {
  //       rpgText(`${st.menu_keys[ret]}\r\n`);
  //       // TODO: transition to new state
  //       rpgState(st.menu[st.menu_keys[ret]]);
  //     }
  //   }

  //   terminal.render();
  // }

  init();

  menuInit();

  if (MODE_DEVELOPMENT) {
    if (debugDefineIsSet('HISCORE')) {
      // hiScoresInit();
    }
    if (debugDefineIsSet('OPTS')) {
      // optionsMenu('title');
    }
    // newGameInit();
  }
}
