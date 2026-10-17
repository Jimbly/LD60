/*eslint @typescript-eslint/no-use-before-define:["error", { "functions": false }]*/
// eslint-disable-next-line import/order
const local_storage = require('glov/client/local_storage');
local_storage.setStoragePrefix('ld60'); // Before requiring anything else that might load from this

import assert from 'assert';
import { actionDown, actionEdge } from 'glov/client/actions';
import { MODE_DEVELOPMENT, platformParameterGet } from 'glov/client/client_config';
import {
  debugDefineIsSet,
  startup as engineStartup,
  setState,
} from 'glov/client/engine';
import { keyDown, KEYS } from 'glov/client/input';
import { localStorageGet, localStorageGetJSON, localStorageSetJSON } from 'glov/client/local_storage';
import { netInit } from 'glov/client/net';
import { scoreAlloc, ScoreSystem } from 'glov/client/score';
import { terminalCreate } from 'glov/client/terminal';
import { terminalSettingsInit, terminalSettingsShow } from 'glov/client/terminal_settings';
import { scaleSizes, setFontHeight } from 'glov/client/ui';
import { ansi } from 'glov/common/ansi';
import { Rec } from 'glov/common/types';
import { clamp, ridx, sign } from 'glov/common/util';
import { JSVec2, v2iNormalize, v2lerp } from 'glov/common/vmath';
import { SOUND_DATA } from './sound_data';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { abs, cos, floor, random, round, sin, max, min, exp, PI } = Math;

window.Z = window.Z || {};
Z.BACKGROUND = 1;
Z.SPRITES = 10;

// let app = exports;
// Virtual viewport for our game logic
const game_width = 640;
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
    char_width: 8,
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

const MINIGAME_W = 18;
const MINIGAME_H = 20;

const BLOCK_COLORS = [15, 12, 9, 14, 11];
const BORDER_BLOCK = 4;
const COLORBITS = 0xf;
const TARGET = 1<<4;
const INDESTRUCTIBLE = 1<<5;
const BORDER = 1<<6;
const HP_SHIFT = 7;
const HP_MASK = 0x7;
const HP = HP_MASK<<HP_SHIFT;
const DOUBLE = 1<<10;
const QUADRUPLE = 1<<11;
const XOFFS_SHIFT = 12; // 2 bits

type Board = number[][];

type BulletType = 'invader_player' | 'invader_enemy' | 'kaboom';
const BULLET_CH: Record<BulletType, string> = {
  invader_player: '|',
  invader_enemy: '|',
  kaboom: '\x0f',
};
const BULLET_FG: Record<BulletType, number> = {
  invader_player: 10,
  invader_enemy: 7,
  kaboom: 12,
};
type Bullet = {
  x: number;
  y: number;
  ydir: number;
  ytime: number;
  ycounter: number;
  type: BulletType;
};

const BREAKOUT_BLOCK_W = 4;

function gameStateRenderEarly(state: GameState): void {
  terminal.normal();
  terminal.clear();

  let { board } = state;

  for (let yy = 0; yy < board.length; ++yy) {
    let row = board[yy];
    for (let xx = 0; xx < row.length; ++xx) {
      let v = row[xx];
      if (v) {
        let ch = (v & INDESTRUCTIBLE) ? '▓' : '█';
        let hp = (v & HP) >> HP_SHIFT;
        let fg = BLOCK_COLORS[v & COLORBITS];
        let bg = BLOCK_COLORS[v & COLORBITS] - 8;
        if (v & BORDER) {
          bg = 0;
          ch = ((v & INDESTRUCTIBLE) || hp === 3) ? '║' : '│';
          if (hp === 1) {
            fg -= 8;
          }
        }
        terminal.print({
          x: xx,
          y: yy,
          fg,
          bg,
          text: ch,
        });
      }
    }
  }
  terminal.normal();
}

function gameStateRenderLate(state: GameState): void {
  let { balls, bullets } = state;
  for (let ii = 0; ii < bullets.length; ++ii) {
    let b = bullets[ii];
    terminal.print({
      x: b.x,
      y: b.y,
      fg: BULLET_FG[b.type],
      text: BULLET_CH[b.type],
    });
  }

  for (let ii = 0; ii < balls.length; ++ii) {
    let ball = balls[ii];
    let { pos: ball_pos } = ball;
    let by = round(ball_pos[1]);
    let fpart = ball_pos[1] - by;
    terminal.print({
      x: round(ball_pos[0]),
      y: by,
      fg: 10,
      // text: fpart < -0.1667 ? '▀' : fpart > 0.1667 ? '▄' : '■',
      text: fpart < 0 ? '▀' : '▄',
    });
  }
}

type Ball = {
  pos: JSVec2;
  dir: JSVec2;
};

class BreakoutState {
  board: Board;
  w = MINIGAME_W;
  h = MINIGAME_H;
  player: number;
  player_width = 5;
  block_xoffs = 1 + floor((this.w % BREAKOUT_BLOCK_W) / 2);
  newBall(): void {
    this.state.balls.push({
      pos: [round(this.player) + this.xoffs, this.h - 2],
      dir: [MODE_DEVELOPMENT ? -1 : 0, -1],
    });
  }
  xoffs: number;
  state: GameState;
  constructor(xoffs: number, state: GameState) {
    this.xoffs = xoffs;
    this.state = state;
    let board = this.board = state.board;
    let { block_xoffs, w, h } = this;
    let blocks_start = 1;
    let blocks_end = floor(h / 2) - 1;
    let blocks_per_row = floor((w - block_xoffs) / BREAKOUT_BLOCK_W);
    for (let yy = blocks_start; yy < blocks_end; ++yy) {
      let row = board[yy];
      for (let ii = 0; ii < blocks_per_row; ++ii) {
        let color = 1 + randInt(BLOCK_COLORS.length - 1);
        color |= QUADRUPLE;
        let x0 = xoffs + block_xoffs + ii * BREAKOUT_BLOCK_W;
        color |= (x0 & 3) << XOFFS_SHIFT;
        for (let jj = 0; jj < BREAKOUT_BLOCK_W; ++jj) {
          row[x0 + jj] = color;
        }
      }
    }

    this.player = this.w / 2;
    this.newBall();
  }

  update(dt: number): void {
    let { xoffs, state, w, h, player_width, board } = this;
    let { balls } = state;
    let spd = dt * 0.01;
    if (actionDown('left')) {
      this.player = max((this.player_width - 1) / 2 + 1, this.player - spd);
    }
    if (actionDown('right')) {
      this.player = min(w - (this.player_width - 1) / 2, this.player + spd);
    }
    for (let ball_idx = balls.length - 1; ball_idx >= 0; --ball_idx) {
      let ball = balls[ball_idx];
      let { pos: ball_pos, dir: ball_dir } = ball;
      let old_bx = round(ball_pos[0]);
      let old_by = round(ball_pos[1]);
      let ball_spd = dt * 0.007;
      ball_pos[0] += ball_dir[0] * ball_spd * 2;
      ball_pos[1] += ball_dir[1] * ball_spd;
      if (ball_pos[0] < 0) {
        ball_pos[0] = 0 - ball_pos[0];
        ball_dir[0] *= -1;
      }
      let totalw = board[0].length;
      if (ball_pos[0] > totalw-1) {
        ball_pos[0] = totalw-1 - (ball_pos[0] - (totalw-1));
        ball_dir[0] *= -1;
      }
      if (ball_pos[1] < 0) {
        ball_pos[1] = 0 - ball_pos[1];
        ball_dir[1] *= -1;
      }
      let bx = round(ball_pos[0]);
      let by = round(ball_pos[1]);
      let player0 = round(this.player - (player_width - 1)/2) + xoffs;
      if (bx !== old_bx || by !== old_by) {
        if (by === h - 1) {
          if (
            bx >= player0 &&
            bx < player0 + player_width
          ) {
            ball_dir[1] *= -1;
            ball_pos[1] = min(ball_pos[1], h - 2.5);
            let impact = clamp((ball_pos[0] - (this.player + xoffs)) / (player_width / 2), -1, 1);
            impact *= 0.8;
            let vec = [sin(PI/2 * impact), -cos(PI/2 * impact)] as const;
            v2lerp(ball_dir, abs(impact) * 0.75, ball_dir, vec);
          }
        } else if (by === h) {
          ridx(balls, ball_idx);
          this.newBall();
        } else {
          let v = board[by]?.[bx];
          if (v) {
            if (!(v & INDESTRUCTIBLE)) {
              let newv = 0;
              if (v & HP) {
                let hp = (v & HP) >> HP_SHIFT;
                hp--;
                if (hp) {
                  newv = (v & ~HP) | (hp << HP_SHIFT);
                }
              }
              let block_w = (v & QUADRUPLE) ? 4 : (v & DOUBLE) ? 2 : 1;
              let block_xoffs = (v >> XOFFS_SHIFT) & 3;
              let blockx = floor((bx - block_xoffs) / block_w) * block_w + block_xoffs;
              for (let ii = 0; ii < block_w; ++ii) {
                let xx = blockx + ii;
                if (board[by][xx]) {
                  board[by][xx] = newv;
                }
              }
            }
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
  }
  render(): void {
    let { xoffs, h, player, player_width } = this;
    terminal.normal();
    let player_str = ['\x11'];
    for (let ii = 0; ii < player_width - 2; ++ii) {
      player_str.push('═');
    }
    player_str.push('\x10');

    terminal.print({
      x: round(player) - (player_width - 1) / 2 + xoffs,
      y: h - 1,
      fg: 9,
      text: player_str.join(''),
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    terminal.normal();
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

const MATCH_LEN = 2;
function matches(color: number, block: number): boolean {
  return block === color || block === color + TARGET;
}
class BlocksState {
  w = floor(MINIGAME_W/2);
  h = MINIGAME_H;
  num_blocks = 4;
  block!: number;
  pos!: JSVec2;
  logic_board!: number[][];
  board!: number[][];
  xoffs: number;
  constructor(xoffs: number, state: GameState) {
    this.xoffs = xoffs;
    this.newBoard();
  }
  setBoard(x: number, y: number, v: number): void {
    let { logic_board, board } = this;
    logic_board[y][x] = v;
    board[y][x*2] = v;
    board[y][x*2 + 1] = v;
  }
  newPiece(): void {
    let { w, h, logic_board } = this;
    // check for clears
    let any_targets = false;
    for (let yy = 0; yy < h; ++yy) {
      for (let xx = 0; xx < w; ++xx) {
        let color = logic_board[yy][xx];
        if (!color) {
          continue;
        }
        if (color > TARGET) {
          any_targets = true;
          color -= TARGET;
        }
        if (xx <= w - MATCH_LEN) {
          let match_len = 1;
          while (xx + match_len < w && matches(color, logic_board[yy][xx + match_len])) {
            ++match_len;
          }
          if (match_len >= MATCH_LEN) {
            for (let ii = 0; ii < match_len; ++ii) {
              this.setBoard(xx + ii, yy, 0);
            }
          }
        }
        if (yy <= h - MATCH_LEN) {
          let match_len = 1;
          while (yy + match_len < h && matches(color, logic_board[yy + match_len][xx])) {
            ++match_len;
          }
          if (match_len >= MATCH_LEN) {
            for (let ii = 0; ii < match_len; ++ii) {
              this.setBoard(xx, yy + ii, 0);
            }
          }
        }
      }
    }

    if (!any_targets) {
      // win
      return this.newBoard();
    }

    this.block = randInt(this.num_blocks) + 1;
    this.pos = [this.w/2, 0];
    let px = round(this.pos[0]);
    let py = floor(this.pos[1]);
    if (logic_board[py][px]) {
      // lose
      this.newBoard();
    }
  }
  newBoard(): void {
    let { w, h, num_blocks } = this;
    let logic_board: number[][] = [];
    let board: number[][] = [];
    for (let yy = 0; yy < h; ++yy) {
      let row: number[] = [];
      logic_board.push(row);
      for (let xx = 0; xx < w; ++xx) {
        row.push(0);
      }
      row = [];
      for (let xx = 0; xx < MINIGAME_W; ++xx) {
        row.push(0);
      }
      board.push(row);
    }
    this.logic_board = logic_board;
    this.board = board;
    let num_targets = 8;
    for (let ii = 0; ii < num_targets; ++ii) {
      while (true) {
        let x = randInt(w);
        let y = 4 + randInt(h - 4);
        if (logic_board[y][x]) {
          continue;
        }
        this.setBoard(x, y, TARGET | (randInt(num_blocks) + 1));
        break;
      }
    }
    this.newPiece();
  }
  down_time = 0;
  update(dt: number): void {
    let { pos, w, h, logic_board } = this;
    let pspd = dt / 140;
    let old_px = round(pos[0]);
    let old_py = floor(pos[1]);
    assert(!logic_board[old_py][old_px]);
    if (actionEdge('left', { peek: true })) {
      pos[0] = round(pos[0]) - 0.51;
    }
    if (actionDown('left')) {
      pos[0] -= pspd;
    }
    if (actionEdge('right', { peek: true })) {
      pos[0] = round(pos[0]) + 0.51;
    }
    if (actionDown('right')) {
      pos[0] += pspd;
    }
    pos[0] = clamp(pos[0], 0, w - 1);
    let px = round(pos[0]);
    if (logic_board[old_py][px]) {
      // user pushed into something horizontally
      px = old_px;
      pos[0] = old_px;
    }
    pos[1] += dt * 0.002;
    if (actionEdge('down', { peek: true })) {
      pos[1] = old_py + 1;
      pos[1] = floor(pos[1]);
    }
    if (actionDown('down')) {
      this.down_time += dt;
      if (this.down_time > 140) {
        pos[1] = old_py + 1;
        pos[1] = floor(pos[1]);
        this.down_time -= 140;
      }
    } else {
      this.down_time = 0;
    }

    let py = floor(pos[1]);
    if (py >= h) {
      this.setBoard(old_px, old_py, this.block);
      this.newPiece();
    } else if (logic_board[py][px]) {
      if (py !== old_py) {
        this.setBoard(old_px, old_py, this.block);
        this.newPiece();
      } else {
        assert(false); // should have been blocked above
      }
    }
  }
  render(): void {
    terminal.normal();
    let { pos, block, board, h } = this;
    let fg = BLOCK_COLORS[block];
    terminal.print({
      x: round(pos[0]) * 2,
      y: floor(pos[1]),
      fg: fg,
      bg: fg - 8,
      text: '▒▒',
    });

    terminal.normal();
    for (let yy = 0; yy < h; ++yy) {
      let row = board[yy];
      for (let xx = 0; xx < row.length; ++xx) {
        let v = row[xx];
        if (v) {
          terminal.print({
            x: xx,
            y: yy,
            fg: BLOCK_COLORS[v & COLORBITS],
            text: (v & TARGET) ? '▒' : '█',
          });
        }
      }
    }
  }
}

const INVADER_PAD = 3;
const NUM_INVADERS = 18;
const INVADER_MOVE_TIME = 1000;
const INVADER_SHOOT_TIME = INVADER_MOVE_TIME * 3;
const INVADER_BULLET_TIME = 250;
const PLAYER_SHOOT_TIME = INVADER_MOVE_TIME;
class InvadersState {
  invaders: [number, number, number, string][] = [];
  w = MINIGAME_W;
  h = MINIGAME_H;
  xoffs: number;
  state: GameState;
  constructor(xoffs: number, state: GameState) {
    this.xoffs = xoffs + 1; // ignore border
    this.state = state;
    this.newBoard();
  }
  move_counter = 0;
  shoot_counter = 0;
  player_shoot_counter = 0;
  shoot_idx = 0;
  move_dir = 1;
  player = 0;
  newBoard(): void {
    this.player = this.w/2;
    this.state.clearBullets('invader_player');
    this.state.clearBullets('invader_enemy');
    this.invaders = [];
    let { invaders, w, xoffs } = this;
    let xx = INVADER_PAD;
    let yy = 0;
    let opts = ['\x0f', '\x15'];
    for (let ii = 0; ii < NUM_INVADERS; ++ii) {
      invaders.push([xx, yy, [4, 5, 12, 13][randInt(4)], opts[ii % opts.length]]);
      xx += 2;
      if (xx >= w - INVADER_PAD) {
        xx = INVADER_PAD;
        yy++;
      }
    }
    this.state.clearBoard(xoffs);
    this.placeInvaders();
    this.move_counter = INVADER_MOVE_TIME;
    this.move_dir = 1;
    this.shoot_counter = INVADER_SHOOT_TIME;
    this.shoot_idx = 0;
    this.player_shoot_counter = PLAYER_SHOOT_TIME / 2 + INVADER_BULLET_TIME / 2;
  }
  removeInvaders(): void {
    let { invaders, state, xoffs } = this;
    let { board } = state;
    for (let ii = invaders.length - 1; ii >= 0; --ii) {
      let invader = invaders[ii];
      if (board[invader[1]][invader[0] + xoffs]) {
        board[invader[1]][invader[0] + xoffs] = 0;
      } else {
        invaders.splice(ii, 1);
      }
    }
  }
  placeInvaders(): void {
    let { invaders, state, xoffs } = this;
    let { board } = state;
    for (let ii = 0; ii < invaders.length; ++ii) {
      let invader = invaders[ii];
      board[invader[1]][invader[0] + xoffs] = 1;
    }
  }
  died(): void {
    this.newBoard();
  }
  won(): void {
    this.newBoard();
  }
  updateInvaders(dt: number): void {
    this.move_counter -= dt;
    if (this.move_counter > 0) {
      return;
    }
    this.removeInvaders();
    this.move_counter += INVADER_MOVE_TIME;
    let { invaders, move_dir, w, h } = this;
    let bounce = false;
    for (let ii = 0; ii < invaders.length; ++ii) {
      let invader = invaders[ii];
      let newx = invader[0] + move_dir;
      if (newx < 0 || newx >= w) {
        bounce = true;
      }
    }
    let dy = 0;
    let dx = move_dir;
    if (bounce) {
      this.move_dir *= -1;
      dx = 0;
      dy = 1;
    }
    let dead = false;
    for (let ii = 0; ii < invaders.length; ++ii) {
      let invader = invaders[ii];
      invader[0] += dx;
      invader[1] += dy;
      if (invader[1] === h) {
        dead = true;
      }
    }
    this.placeInvaders();
    if (dead) {
      this.newBoard();
    }
  }
  fireBullets(dt: number): void {
    this.shoot_counter -= dt;
    if (this.shoot_counter > 0) {
      return;
    }
    this.shoot_counter += INVADER_SHOOT_TIME;
    let { invaders, shoot_idx, state, h, xoffs } = this;
    for (let ii = 0; ii < invaders.length; ++ii) {
      let invader = invaders[ii];
      if ((ii + shoot_idx) % 4) {
        continue;
      }
      let x = invader[0];
      let y = invader[1] + 1;
      let open = y < h;
      for (let jj = 0; jj < invaders.length; ++jj) {
        if (invaders[jj][0] === x && invaders[jj][1] === y) {
          open = false;
          break;
        }
      }
      if (open) {
        state.bullets.push({
          x: xoffs + x,
          y,
          type: 'invader_enemy',
          ydir: 1,
          ytime: INVADER_BULLET_TIME,
          ycounter: INVADER_BULLET_TIME,
        });
      }
    }
    this.shoot_idx++;
  }
  firePlayerBullets(dt: number): void {
    this.player_shoot_counter -= dt;
    if (this.player_shoot_counter > 0) {
      return;
    }
    this.player_shoot_counter += PLAYER_SHOOT_TIME;
    let { state, h, player, xoffs } = this;
    state.bullets.push({
      x: xoffs + round(player),
      y: h - 2,
      type: 'invader_player',
      ydir: -1,
      ytime: INVADER_BULLET_TIME,
      ycounter: INVADER_BULLET_TIME,
    });
  }
  update(dt: number): void {
    let { w } = this;
    let hspd = dt * 0.01 * 0.7;
    if (actionDown('left')) {
      this.player = max(1, this.player - hspd);
    }
    if (actionDown('right')) {
      this.player = min(w - 2, this.player + hspd);
    }

    this.updateInvaders(dt);
    this.fireBullets(dt);
    this.firePlayerBullets(dt);

    let px = round(this.player);
    let py = this.h - 1;
    let player_pos = px + py * w;
    let { invaders, state, xoffs } = this;
    let { bullets } = state;
    let player_bullet_pos: Rec<number, Bullet> = {};
    for (let ii = 0; ii < bullets.length; ++ii) {
      let b = bullets[ii];
      if (b.type === 'invader_player') {
        player_bullet_pos[b.x - xoffs + b.y * w] = b;
      }
    }
    let hit = false;
    let to_remove: Bullet[] = [];
    function checkHit(x: number, y: number): boolean {
      let ret = false;
      let posidx = x + y * w;
      if (
        posidx === player_pos ||
        posidx === player_pos + 1 ||
        posidx === player_pos - 1
      ) {
        hit = true;
        ret = true;
      }
      let player_bullet = player_bullet_pos[posidx];
      if (player_bullet) {
        ret = true;
        to_remove.push(player_bullet);
        delete player_bullet_pos[posidx];
      }
      return ret;
    }
    this.removeInvaders();
    for (let ii = invaders.length - 1; ii >= 0; --ii) {
      let item = invaders[ii];
      if (checkHit(item[0], item[1])) {
        invaders.splice(ii, 1);
      }
    }
    this.placeInvaders();
    for (let ii = 0; ii < bullets.length; ++ii) {
      let b = bullets[ii];
      if (b.type === 'invader_enemy') {
        if (checkHit(b.x - xoffs, b.y)) {
          bullets.splice(ii, 1);
        }
      }
    }
    for (let ii = 0; ii < to_remove.length; ++ii) {
      let player_bullet = to_remove[ii];
      let player_idx = bullets.indexOf(player_bullet);
      if (player_idx !== -1) {
        assert(player_idx !== -1);
        bullets.splice(player_idx, 1);
      }
    }
    if (hit) {
      this.died();
    } else if (!invaders.length) {
      this.won();
    }
  }
  render(): void {
    terminal.normal();
    let { invaders, player, w, h, xoffs } = this;

    // terminal.print({
    //   x: round(player),
    //   y: h - 2,
    //   fg: 12,
    //   text: '╥',
    // });
    let px = round(player);
    terminal.print({
      x: xoffs + max(0, px - 2),
      y: h - 1,
      fg: 9,
      text: `${px > 1 ? '\x11' : ''}═╩═${px < w - 2 ? '\x10' : ''}`,
    });

    for (let ii = 0; ii < invaders.length; ++ii) {
      let invader = invaders[ii];
      terminal.print({
        x: xoffs + invader[0],
        y: invader[1],
        fg: invader[2],
        text: invader[3],
      });
    }
  }
}

const KABOOM_SPEED = 100;
const KABOOM_BULLET_TIME = 200;
class KaboomState {
  w = MINIGAME_W;
  h = MINIGAME_H;
  player_width = 5;
  player = 0;
  py = this.h - 4;
  enemy = 0;
  enemy_counter = 0;
  shoot_counter = 0;
  bullet_counter = 0;
  enemy_target = 0;
  bullets!: JSVec2[];
  board!: number[][];
  xoffs: number;
  constructor(xoffs: number, state: GameState) {
    this.xoffs = xoffs;
    this.newGame();
  }
  newGame(): void {
    this.player = this.w / 2;
    this.enemy = this.w / 2;
    this.enemy_counter = 0;
    this.shoot_counter = 2000;
    this.bullets = [];
    this.board = [];
    let { w, h } = this;
    for (let yy = 0; yy < h; ++yy) {
      let row: number[] = [];
      this.board.push(row);
      for (let xx = 0; xx < w/2; ++xx) {
        let color = yy >= h - 2 ? randInt(BLOCK_COLORS.length - 1) + 1 : 0;
        row.push(color, color);
      }
    }
  }
  died(): void {
    this.newGame();
  }
  updateBullets(dt: number): void {
    this.bullet_counter -= dt;
    if (this.bullet_counter > 0) {
      return;
    }
    this.bullet_counter += KABOOM_BULLET_TIME;
    let { bullets, h } = this;
    for (let ii = bullets.length - 1; ii >= 0; --ii) {
      let b = bullets[ii];
      b[1]++;
      if (b[1] === h) {
        ridx(bullets, ii);
      }
    }
  }
  update(dt: number): void {
    let { w, py, player_width, bullets, board } = this;
    this.updateBullets(dt);
    this.shoot_counter -= dt;
    if (this.shoot_counter <= 0) {
      this.shoot_counter += KABOOM_SPEED * 3;
      this.bullets.push([this.enemy, 1]);
    }
    this.enemy_counter -= dt;
    if (this.enemy_counter <= 0) {
      this.enemy_counter += KABOOM_SPEED;
      while (this.enemy_target === this.enemy) {
        this.enemy_target = randInt(this.w);
      }
      let delta = sign(this.enemy_target - this.enemy);
      this.enemy += delta;
    }

    let hspd = dt * 0.01 * 4;
    if (actionDown('left')) {
      this.player = max((player_width - 1) / 2, this.player - hspd);
    }
    if (actionDown('right')) {
      this.player = min(w - (player_width - 1) / 2 - 1, this.player + hspd);
    }

    let px = round(this.player - (player_width - 1) / 2);
    let dead = false;
    for (let ii = bullets.length - 1; ii >= 0; --ii) {
      let b = bullets[ii];
      if (
        b[1] === py && b[0] >= px && b[0] < px + player_width ||
        b[1] === py + 1 && b[0] >= px + 1 && b[0] < px + player_width - 1
      ) {
        ridx(bullets, ii);
      } else if (board[b[1]][b[0]]) {
        let bx = b[0] & ~1;
        board[b[1]][bx] = 0;
        board[b[1]][bx + 1] = 0;
        ridx(bullets, ii);
        let any_left = false;
        for (let yy = 0; yy < board.length; ++yy) {
          for (let xx = 0; xx < board[yy].length; ++xx) {
            if (board[yy][xx]) {
              any_left = true;
              break;
            }
          }
        }
        if (!any_left) {
          dead = true;
        }
      }
    }
    if (dead) {
      this.died();
    }
  }
  render(): void {
    terminal.normal();
    let { bullets, player, player_width, enemy, py, board, w, h } = this;

    let px = round(player - (player_width - 1) / 2);
    terminal.print({
      x: max(0, px),
      y: py,
      fg: 11,
      text: '\\═══/',
    });
    terminal.print({
      x: max(0, px),
      y: py + 1,
      fg: 11,
      text: ' \\═/',
    });

    terminal.print({
      x: enemy,
      y: 0,
      fg: 12,
      text: '\x01',
    });

    for (let ii = 0; ii < bullets.length; ++ii) {
      let b = bullets[ii];
      terminal.print({
        x: b[0],
        y: b[1],
        fg: 12,
        text: '\x0f',
      });
    }

    for (let yy = 0; yy < h; ++yy) {
      let row = board[yy];
      for (let xx = 0; xx < w; ++xx) {
        let v = row[xx];
        if (v) {
          terminal.print({
            x: xx,
            y: yy,
            fg: BLOCK_COLORS[v & COLORBITS],
            text: (v & TARGET) ? '▒' : '█',
          });
        }
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
  board!: Board;
  invaders!: InvadersState;
  breakout!: BreakoutState;
  blocks!: BlocksState;
  kaboom!: KaboomState;
  bullets!: Bullet[];
  balls!: Ball[];
  constructor() {
    this.initBoard();
  }
  initBoard(): void {
    this.board = [];
    let board = this.board;
    let w = (MINIGAME_W + 1) * 4 + 1;
    let c1 = MINIGAME_W + 1;
    let c2 = (MINIGAME_W + 1) * 2;
    let c3 = (MINIGAME_W + 1) * 3;
    const INITIAL_HP = MODE_DEVELOPMENT ? 0 : 3;
    for (let yy = 0; yy < MINIGAME_H; ++yy) {
      let row: number[] = [];
      board.push(row);
      for (let xx = 0; xx < w; ++xx) {
        let v = 0;
        if (xx === 0 || xx === c3 || xx === w - 1) {
          v = BORDER | INDESTRUCTIBLE | BORDER_BLOCK;
        } else if (xx === c1 || xx === c2) {
          v = BORDER;
          v |= (yy === 0 || yy > MINIGAME_H*0.667) ?
            INDESTRUCTIBLE :
            (INITIAL_HP<<HP_SHIFT);
          v |= BORDER_BLOCK;
          if (!INITIAL_HP) {
            v = 0;
          }
        }
        row.push(v);
      }
    }
    this.bullets = [];
    this.balls = [];
    this.invaders = new InvadersState(0, this);
    this.breakout = new BreakoutState(MINIGAME_W + 1, this);
    this.blocks = new BlocksState((MINIGAME_W + 1) * 2, this);
    this.kaboom = new KaboomState((MINIGAME_W + 1) * 3, this);
  }

  update(dt: number): void {
    this.updateBullets(dt);
  }
  updateLate(dt: number): void {
    let { bullets, balls } = this;
    let ball_pos: Rec<number, Ball> = {};
    for (let ii = 0; ii < balls.length; ++ii) {
      let ball = balls[ii];
      ball_pos[round(ball.pos[0]) + round(ball.pos[1]) * 100] = ball;
    }
    for (let ii = bullets.length - 1; ii >= 0; --ii) {
      let b = bullets[ii];
      if (ball_pos[b.x + b.y * 100]) {
        ridx(bullets, ii);
      }
    }
  }
  updateBullets(dt: number): void {
    let { bullets } = this;
    for (let ii = bullets.length - 1; ii >= 0; --ii) {
      let b = bullets[ii];
      b.ycounter -= dt;
      if (b.ycounter <= 0) {
        b.ycounter += b.ytime;
        b.y += b.ydir;
        if (b.y < 0 || b.y >= MINIGAME_H) {
          ridx(bullets, ii);
        }
      }
    }
  }
  clearBullets(type: BulletType): void {
    let { bullets } = this;
    for (let ii = bullets.length - 1; ii >= 0; --ii) {
      if (bullets[ii].type === type) {
        ridx(bullets, ii);
      }
    }
  }
  clearBoard(xoffs: number): void {
    let { board } = this;
    for (let yy = 0; yy < MINIGAME_H; ++yy) {
      for (let xx = 0; xx < MINIGAME_W; ++xx) {
        board[yy][xx + xoffs] = 0;
      }
    }
  }
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

let view_x = 1;
let view_board = { x: view_x, y: 1, w: MINIGAME_W * 4 + 3, h: MINIGAME_H };
let view_invaders = { x: view_x, y: 1, w: MINIGAME_W, h: MINIGAME_H };
view_x += MINIGAME_W + 1;
let view_breakout = { x: view_x, y: 1, w: MINIGAME_W, h: MINIGAME_H };
view_x += MINIGAME_W + 1;
let view_blocks = { x: view_x, y: 1, w: MINIGAME_W, h: MINIGAME_H };
view_x += MINIGAME_W + 1;
let view_kaboom = { x: view_x, y: 1, w: MINIGAME_W, h: MINIGAME_H };
view_x += MINIGAME_W + 1;
function statePlay(dt: number): void {
  if (MODE_DEVELOPMENT && keyDown(KEYS.SHIFT)) {
    dt *= 3;
  }
  terminal.auto_scroll = false;
  terminal.color(11, 0);
  terminal.cells({
    x: view_breakout.x, y: view_breakout.y - 1, ws: [MINIGAME_W], hs: [MINIGAME_H], charset: 1,
    header: ' BREAKOUT ',
  });
  terminal.cells({
    x: view_kaboom.x, y: view_kaboom.y - 1, ws: [MINIGAME_W], hs: [MINIGAME_H], charset: 1,
    header: ' KABOOM ',
  });
  terminal.cells({
    x: view_blocks.x, y: view_blocks.y - 1, ws: [MINIGAME_W], hs: [MINIGAME_H], charset: 1,
    header: ' BLOCKS ',
  });
  terminal.cells({
    x: view_invaders.x, y: view_invaders.y - 1, ws: [MINIGAME_W], hs: [MINIGAME_H], charset: 1,
    header: ' INVADERS ',
  });

  game_state.update(dt);
  game_state.invaders.update(dt);
  game_state.breakout.update(dt);
  game_state.kaboom.update(dt);
  game_state.blocks.update(dt);
  game_state.updateLate(dt);

  terminal.subViewPush(view_board);
  gameStateRenderEarly(game_state);
  terminal.subViewPop();
  terminal.subViewPush(view_board);
  game_state.invaders.render();
  terminal.subViewPop();
  terminal.subViewPush(view_board);
  game_state.breakout.render();
  terminal.subViewPop();
  terminal.subViewPush(view_kaboom);
  game_state.kaboom.render();
  terminal.subViewPop();
  terminal.subViewPush(view_blocks);
  game_state.blocks.render();
  terminal.subViewPop();
  terminal.subViewPush(view_board);
  gameStateRenderLate(game_state);
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
      info: require('./img/font/ibm8x16x1.json'),
      texture: 'font/ibm8x16x1',
    },
    pixel_aspect: (640/480) / (640 / 400),
    show_fps: false,
    ui_sounds: SOUND_DATA,
  })) {
    return;
  }
  // font = uiGetFont();

  // Perfect sizes for pixely modes
  scaleSizes(13 / 32);
  setFontHeight(16);

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
