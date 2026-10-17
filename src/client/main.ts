/*eslint @typescript-eslint/no-use-before-define:["error", { "functions": false }]*/
// eslint-disable-next-line import/order
const local_storage = require('glov/client/local_storage');
local_storage.setStoragePrefix('ld60'); // Before requiring anything else that might load from this

import assert from 'assert';
import { actionDown } from 'glov/client/actions';
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
import { clamp } from 'glov/common/util';
import { JSVec2, v2iNormalize, v2lerp } from 'glov/common/vmath';
import { SOUND_DATA } from './sound_data';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { abs, cos, floor, random, round, sin, max, min, exp, PI } = Math;

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
    score_key: 'LD60',
    ls_key: 'ld60',
    asc: false,
    rel: 12,
    num_names: 3,
    histogram: false,
  });
}
export function scoreSystem(): ScoreSystem<Score> {
  return score_system;
}

function randInt(range: number): number {
  return floor(random() * range);
}

const MINIGAME_W = 16;
const MINIGAME_H = 20;

const BREAKOUT_BLOCK_W = 4;

class BreakoutState {
  board: number[][];
  w: number;
  h: number;
  ball_pos!: JSVec2;
  ball_dir!: JSVec2;
  player: number;
  player_width = 5;
  block: string;
  newBall(): void {
    this.ball_pos = [this.w / 2, this.board.length + 1];
    this.ball_dir = [0, 1];
  }
  constructor() {
    this.board = [];
    let board = this.board;
    for (let yy = 0; yy < MINIGAME_H/2; ++yy) {
      let row: number[] = board[yy] = [];
      for (let xx = 0; xx < floor(MINIGAME_W/BREAKOUT_BLOCK_W); ++xx) {
        row.push(1 + randInt(4));
      }
    }
    this.w = board[0].length * BREAKOUT_BLOCK_W;
    this.h = MINIGAME_H;
    this.newBall();
    this.player = this.w / 2;
    let block = [];
    for (let ii = 0; ii < BREAKOUT_BLOCK_W; ++ii) {
      block.push('█');
    }
    this.block = block.join('');
  }

  update(dt: number): void {
    let { ball_pos, ball_dir, w, h, player_width, board } = this;
    let spd = dt * 0.01;
    if (actionDown('left')) {
      this.player = max(this.player_width / 2, this.player - spd);
    }
    if (actionDown('right')) {
      this.player = min(this.w - this.player_width / 2, this.player + spd);
    }
    let old_bx = round(ball_pos[0]);
    let old_by = round(ball_pos[1]);
    let ball_spd = dt * 0.007;
    ball_pos[0] += ball_dir[0] * ball_spd * 2;
    ball_pos[1] += ball_dir[1] * ball_spd;
    if (ball_pos[0] < 0) {
      ball_pos[0] = 0 - ball_pos[0];
      ball_dir[0] *= -1;
    }
    if (ball_pos[0] > w-1) {
      ball_pos[0] = w-1 - (ball_pos[0] - (w-1));
      ball_dir[0] *= -1;
    }
    if (ball_pos[1] < 0) {
      ball_pos[1] = 0 - ball_pos[1];
      ball_dir[1] *= -1;
    }
    let bx = round(ball_pos[0]);
    let by = round(ball_pos[1]);
    let player0 = round(this.player - player_width/2);
    if (bx !== old_bx || by !== old_by) {
      if (by === h - 1) {
        if (
          bx >= player0 &&
          bx < player0 + player_width
        ) {
          ball_dir[1] *= -1;
          ball_pos[1] = min(ball_pos[1], h - 2.5);
          let impact = clamp((ball_pos[0] - this.player) / (player_width / 2), -1, 1);
          let vec = [sin(PI/2 * impact), -cos(PI/2 * impact)] as const;
          v2lerp(ball_dir, abs(impact) * 0.75, ball_dir, vec);
        }
      } else if (by === h) {
        this.newBall();
      } else {
        let blockx = floor(bx / BREAKOUT_BLOCK_W);
        if (board[by]?.[blockx]) {
          board[by][blockx] = 0;
          if (bx !== old_bx) {
            ball_dir[0] *= -1;
            ball_pos[0] += 2 * ((min(bx, old_bx) + 0.5) - ball_pos[0]);
          }
          if (by !== old_by) {
            ball_dir[1] *= -1;
            ball_pos[1] += 2 * ((min(by, old_by) + 0.5) - ball_pos[1]);
          }
        }
      }
    }
    v2iNormalize(ball_dir);
  }
  render(): void {
    terminal.color(7, 0);
    terminal.clear();
    let { h, board, block, ball_pos, player, player_width } = this;
    for (let yy = 0; yy < board.length; ++yy) {
      let row = board[yy];
      for (let xx = 0; xx < row.length; ++xx) {
        if (row[xx]) {
          terminal.print({
            x: xx * BREAKOUT_BLOCK_W,
            y: yy,
            fg: 8 + row[xx],
            text: block,
          });
        }
      }
    }
    let player_str = ['\x11'];
    for (let ii = 0; ii < player_width - 2; ++ii) {
      player_str.push('═');
    }
    player_str.push('\x10');

    let by = round(ball_pos[1]);
    let fpart = ball_pos[1] - by;
    terminal.print({
      x: round(ball_pos[0]),
      y: by,
      fg: 9,
      // text: fpart < -0.1667 ? '▀' : fpart > 0.1667 ? '▄' : '■',
      text: fpart < 0 ? '▀' : '▄',
    });

    terminal.print({
      x: round(player - player_width / 2),
      y: h - 1,
      fg: 12,
      text: player_str.join(''),
    });
  }
}

class DodgeState {
  player = MINIGAME_W/2;
  player_width = 1;
  w = MINIGAME_W;
  h = MINIGAME_H;
  board: JSVec2[];
  last_row: JSVec2;
  pos = 0;
  newRow(): void {
    let { last_row, h, board } = this;
    let mx = 5;
    let row: JSVec2 = [clamp(last_row[0] + randInt(3) - 1, 1, mx), clamp(last_row[1] + randInt(3) - 1, 1, mx)];
    board.unshift(row);
    if (board.length > h) {
      board.pop();
    }
    this.last_row = row;
  }
  constructor() {
    this.last_row = [round(this.w/8), round(this.w/8)];
    let board: JSVec2[] = [];
    this.board = board;
    for (let ii = 0; ii < this.h; ++ii) {
      this.newRow();
    }
  }
  crash(): void {
    this.player = MINIGAME_W/2;
    for (let ii = 0; ii < this.h; ++ii) {
      this.newRow();
    }
  }

  update(dt: number): void {
    let { w, board } = this;
    let hspd = dt * 0.01 * 0.7;
    let row0 = board[this.board.length-1];
    if (actionDown('left')) {
      this.player = max(row0[0] - 0.5, this.player - hspd);
    }
    if (actionDown('right')) {
      this.player = min(this.w - row0[1] - 0.5 - 1, this.player + hspd);
    }
    let vspd = dt * 0.007;
    this.pos += vspd;
    if (this.pos > 1) {
      --this.pos;
      this.newRow();

      let row = board[this.board.length-1];
      let player_pos = round(this.player);
      if (player_pos < row[0] || player_pos >= w - row[1]) {
        this.crash();
      }
    }

  }
  render(): void {
    terminal.color(7, 0);
    terminal.clear();
    let { player, h, w, board } = this;
    terminal.print({
      x: round(player),
      y: h - 1,
      fg: 12,
      text: '\x1E',
    });

    for (let yy = 0; yy < board.length; ++yy) {
      let pair = board[yy];
      terminal.moveto(0, yy);
      let leftw = pair[0];
      for (let ii = 0; ii < leftw; ++ii) {
        terminal.print({
          fg: 8,
          text: ii === leftw - 1 ? '▓' : ii === leftw - 2 ? '▒' : '░',
        });
      }
      let rightw = pair[1];
      terminal.moveto(w - rightw, yy);
      for (let ii = 0; ii < rightw; ++ii) {
        terminal.print({
          fg: 8,
          text: ii === 0 ? '▓' : ii === 1 ? '▒' : '░',
        });
      }
    }

  }
}

type GameData = {
  a: number;
  b: number;
};
class GameState {
  mode: 'explore' | 'combat' = 'explore';
  data: GameData = { a: 0, b: 0 };
  breakout = new BreakoutState();
  dodge = new DodgeState();
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

let view_breakout = { x: 30, y: 1, w: MINIGAME_W, h: MINIGAME_H };
let view_dodge = { x: 30 + MINIGAME_W + 1, y: 1, w: MINIGAME_W, h: MINIGAME_H };
function statePlay(dt: number): void {
  terminal.auto_scroll = false;
  terminal.color(3, 0);
  terminal.cells({
    x: view_breakout.x - 1, y: view_breakout.y - 1, ws: [MINIGAME_W], hs: [MINIGAME_H], charset: 1,
    header: ' BREAKOUT ',
  });
  terminal.subViewPush(view_breakout);
  game_state.breakout.update(dt);
  game_state.breakout.render();
  terminal.subViewPop();

  terminal.color(3, 0);
  terminal.cells({
    x: view_dodge.x - 1, y: view_dodge.y - 1, ws: [MINIGAME_W], hs: [MINIGAME_H], charset: 1,
    header: ' DODGE ',
  });
  terminal.subViewPush(view_dodge);
  game_state.dodge.update(dt);
  game_state.dodge.render();
  terminal.subViewPop();

  terminal.render();
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
  terminal.draw_cursor = [1, 4];
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

function statePlayInit(): void {
  terminal.baud = Infinity;
  terminal.draw_cursor = false;
  terminal.color(7,0);
  terminal.clear();
  setState(statePlay);
}

export function backToGame(): void {
  statePlayInit();
}

export function newGameInit(): void {
  game_state = new GameState();
  statePlayInit();
}

export function loadGame(): void {
  let data = localStorageGetJSON<SavedGame>('savegame');
  assert(data);
  game_state = new GameState();
  game_state.data = data;
  statePlayInit();
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
    newGameInit();
  }
}
