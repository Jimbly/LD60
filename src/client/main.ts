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

const MINIGAME_W = 18 + 2;
const MINIGAME_H = 20;

const BLOCK_COLORS = [15, 12, 9, 14, 11];
const COLORBITS = 0xf;
const TARGET = 1<<4;
const INDESTRUCTIBLE = 1<<5;
const BORDER = 1<<6;
const HP_SHIFT = 7;
const HP_MASK = 0x7;
const HP = HP_MASK<<HP_SHIFT;

const BREAKOUT_BLOCK_W = 4;

class BreakoutState {
  board: number[][];
  w = MINIGAME_W;
  h = MINIGAME_H;
  ball_pos!: JSVec2;
  ball_dir!: JSVec2;
  player: number;
  player_width = 5;
  block_xoffs = 1 + floor(((this.w - 2) % BREAKOUT_BLOCK_W) / 2);
  newBall(): void {
    this.ball_pos = [round(this.player), this.h - 2];
    this.ball_dir = [0, -1];
  }
  constructor() {
    this.board = [];
    let board = this.board;
    let { block_xoffs, w, h } = this;
    let blocks_start = 1;
    let blocks_end = floor(h / 2) - 1;
    while (board.length < blocks_start) {
      let row: number[] = [];
      for (let ii = 0; ii < w; ++ii) {
        row.push(0);
      }
      board.push(row);
    }
    while (board.length < blocks_end) {
      let row: number[] = [];
      while (row.length < block_xoffs) {
        row.push(0);
      }
      while (row.length + BREAKOUT_BLOCK_W < w) {
        let color = 1 + randInt(BLOCK_COLORS.length - 1);
        for (let ii = 0; ii < BREAKOUT_BLOCK_W; ++ii) {
          row.push(color);
        }
      }
      while (row.length < w) {
        row.push(0);
      }
      row.pop();
      board.push(row);
    }
    while (board.length < h) {
      let row: number[] = [];
      for (let ii = 0; ii < w; ++ii) {
        row.push(0);
      }
      board.push(row);
    }

    for (let yy = 0; yy < h; ++yy) {
      let v = (yy === 0 || yy > h*0.667) ?
        INDESTRUCTIBLE | BORDER :
        (3<<HP_SHIFT) | BORDER;
      v |= 4;
      board[yy][0] = v;
      board[yy][w-1] = v;
    }
    this.player = this.w / 2;
    this.newBall();
  }

  update(dt: number): void {
    let { ball_pos, ball_dir, w, h, player_width, board, block_xoffs } = this;
    let spd = dt * 0.01;
    if (actionDown('left')) {
      this.player = max((this.player_width - 1) / 2 + 1, this.player - spd);
    }
    if (actionDown('right')) {
      this.player = min(this.w - (this.player_width - 1) / 2 - 2, this.player + spd);
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
    let player0 = round(this.player - (player_width - 1)/2);
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
            let blockx = floor((bx - block_xoffs) / BREAKOUT_BLOCK_W) * BREAKOUT_BLOCK_W + block_xoffs;
            for (let ii = 0; ii < BREAKOUT_BLOCK_W; ++ii) {
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
  render(): void {
    terminal.normal();
    terminal.fill({
      x: 1, y: 0, w: MINIGAME_W - 2, h: MINIGAME_H,
    });
    let { h, board, ball_pos, player, player_width } = this;
    for (let yy = 0; yy < board.length; ++yy) {
      let row = board[yy];
      for (let xx = 0; xx < row.length; ++xx) {
        let v = row[xx];
        if (v) {
          if ((v & BORDER) && (v & INDESTRUCTIBLE)) {
            continue;
          }
          let ch = (v & INDESTRUCTIBLE) ? '▓' : '█';
          let hp = (v & HP) >> HP_SHIFT;
          let fg = BLOCK_COLORS[v & COLORBITS];
          let bg = BLOCK_COLORS[v & COLORBITS] - 8;
          if (v & BORDER) {
            bg = 0;
            ch = hp === 3 ? '║' : '│';
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
      fg: 10,
      // text: fpart < -0.1667 ? '▀' : fpart > 0.1667 ? '▄' : '■',
      text: fpart < 0 ? '▀' : '▄',
    });

    terminal.print({
      x: round(player) - (player_width - 1) / 2,
      y: h - 1,
      fg: 9,
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
    terminal.normal();
    terminal.fill({
      x: 1, y: 0, w: MINIGAME_W - 2, h: MINIGAME_H,
    });
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
  constructor() {
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
    terminal.fill({
      x: 1, y: 0, w: MINIGAME_W - 2, h: MINIGAME_H,
    });
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
const NUM_INVADERS = 20;
const INVADER_MOVE_TIME = 1000;
const INVADER_SHOOT_TIME = INVADER_MOVE_TIME * 3;
const INVADER_BULLET_TIME = 250/2;
const PLAYER_SHOOT_TIME = INVADER_MOVE_TIME;
class InvadersState {
  invaders: [number, number, number, string][] = [];
  invader_bullets: [number, number][] = [];
  player_bullets: [number, number][] = [];
  w = MINIGAME_W;
  h = MINIGAME_H;
  constructor() {
    this.newBoard();
  }
  move_counter = 0;
  shoot_counter = 0;
  player_shoot_counter = 0;
  bullet_counter = 0;
  shoot_idx = 0;
  bullet_idx = 0;
  move_dir = 1;
  player = 0;
  newBoard(): void {
    this.player = this.w/2;
    this.invader_bullets = [];
    this.player_bullets = [];
    this.invaders = [];
    let { invaders, w } = this;
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
    this.move_counter = INVADER_MOVE_TIME;
    this.move_dir = 1;
    this.shoot_counter = INVADER_SHOOT_TIME;
    this.shoot_idx = 0;
    this.bullet_counter = INVADER_BULLET_TIME;
    this.bullet_idx = 0;
    this.player_shoot_counter = PLAYER_SHOOT_TIME / 2;
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
    let { invaders, shoot_idx, invader_bullets, h } = this;
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
        invader_bullets.push([x, y]);
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
    let { player_bullets, h, player } = this;
    player_bullets.push([round(player), h - 2]);
  }
  updateBullets(dt: number): void {
    this.bullet_counter -= dt;
    if (this.bullet_counter > 0) {
      return;
    }
    this.bullet_counter += INVADER_BULLET_TIME;
    let { invader_bullets, player_bullets, h } = this;
    this.bullet_idx = (this.bullet_idx + 1) % 2;
    let list = this.bullet_idx ? player_bullets : invader_bullets;
    for (let ii = list.length - 1; ii >= 0; --ii) {
      let b = list[ii];
      if (this.bullet_idx) {
        b[1]--;
        if (b[1] < 0) {
          ridx(list, ii);
        }
      } else {
        b[1]++;
        if (b[1] === h) {
          ridx(list, ii);
        }
      }
    }
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
    this.updateBullets(dt);
    this.fireBullets(dt);
    this.firePlayerBullets(dt);

    let px = round(this.player);
    let py = this.h - 1;
    let player_pos = px + py * w;
    let { invaders, invader_bullets, player_bullets } = this;
    let player_bullet_pos: Rec<number, JSVec2> = {};
    for (let ii = 0; ii < player_bullets.length; ++ii) {
      let pos = player_bullets[ii];
      player_bullet_pos[pos[0] + pos[1] * w] = pos;
    }
    let hit = false;
    [invaders, invader_bullets].forEach((list) => {
      let to_remove: number[] = [];
      list.forEach((item, idx) => {
        let posidx = item[0] + item[1] * w;
        if (
          posidx === player_pos ||
          posidx === player_pos + 1 ||
          posidx === player_pos - 1
        ) {
          hit = true;
        }
        let player_bullet = player_bullet_pos[posidx];
        if (player_bullet) {
          to_remove.push(idx);
          let player_idx = player_bullets.indexOf(player_bullet);
          assert(player_idx !== -1);
          player_bullets.splice(player_idx, 1);
          delete player_bullet_pos[posidx];
        }
      });
      for (let ii = to_remove.length - 1; ii >= 0; --ii) {
        list.splice(to_remove[ii], 1);
      }
    });
    if (hit) {
      this.died();
    } else if (!invaders.length) {
      this.won();
    }
  }
  render(): void {
    terminal.normal();
    terminal.fill({
      x: 1, y: 0, w: MINIGAME_W - 2, h: MINIGAME_H,
    });
    let { invaders, invader_bullets, player_bullets, player, w, h } = this;

    // terminal.print({
    //   x: round(player),
    //   y: h - 2,
    //   fg: 12,
    //   text: '╥',
    // });
    let px = round(player);
    terminal.print({
      x: max(0, px - 2),
      y: h - 1,
      fg: 9,
      text: `${px > 1 ? '\x11' : ''}═╩═${px < w - 2 ? '\x10' : ''}`,
    });

    for (let ii = 0; ii < invaders.length; ++ii) {
      let invader = invaders[ii];
      terminal.print({
        x: invader[0],
        y: invader[1],
        fg: invader[2],
        text: invader[3],
      });
    }
    [invader_bullets, player_bullets].forEach((list, bullet_idx) => {
      for (let ii = 0; ii < list.length; ++ii) {
        let b = list[ii];
        terminal.print({
          x: b[0],
          y: b[1],
          fg: bullet_idx ? 10 : 7,
          text: '|',
        });
      }
    });
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
  constructor() {
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
    terminal.fill({
      x: 1, y: 0, w: MINIGAME_W - 2, h: MINIGAME_H,
    });
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
  breakout = new BreakoutState();
  dodge = new DodgeState();
  blocks = new BlocksState();
  invaders = new InvadersState();
  kaboom = new KaboomState();
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
let view_invaders = { x: view_x, y: 1, w: MINIGAME_W, h: MINIGAME_H };
view_x += MINIGAME_W - 1;
let view_breakout = { x: view_x, y: 1, w: MINIGAME_W, h: MINIGAME_H };
view_x += MINIGAME_W - 1;
let view_blocks = { x: view_x, y: 1, w: MINIGAME_W, h: MINIGAME_H };
view_x += MINIGAME_W - 1;
let view_kaboom = { x: view_x, y: 1, w: MINIGAME_W, h: MINIGAME_H };
view_x += MINIGAME_W - 1;
function statePlay(dt: number): void {
  terminal.auto_scroll = false;
  terminal.color(11, 0);
  terminal.cells({
    x: view_breakout.x, y: view_breakout.y - 1, ws: [MINIGAME_W - 2], hs: [MINIGAME_H], charset: 1,
    header: ' BREAKOUT ',
  });
  terminal.cells({
    x: view_kaboom.x, y: view_kaboom.y - 1, ws: [MINIGAME_W - 2], hs: [MINIGAME_H], charset: 1,
    header: ' KABOOM ',
  });
  terminal.cells({
    x: view_blocks.x, y: view_blocks.y - 1, ws: [MINIGAME_W - 2], hs: [MINIGAME_H], charset: 1,
    header: ' BLOCKS ',
  });
  terminal.cells({
    x: view_invaders.x, y: view_invaders.y - 1, ws: [MINIGAME_W - 2], hs: [MINIGAME_H], charset: 1,
    header: ' INVADERS ',
  });

  terminal.subViewPush(view_breakout);
  game_state.breakout.update(dt);
  game_state.breakout.render();
  terminal.subViewPop();

  if (0) {
    terminal.subViewPush(view_kaboom);
    game_state.dodge.update(dt);
    game_state.dodge.render();
    terminal.subViewPop();
  } else {
    terminal.subViewPush(view_kaboom);
    game_state.kaboom.update(dt);
    game_state.kaboom.render();
    terminal.subViewPop();
  }

  terminal.subViewPush(view_blocks);
  game_state.blocks.update(dt);
  game_state.blocks.render();
  terminal.subViewPop();

  terminal.subViewPush(view_invaders);
  game_state.invaders.update(dt);
  game_state.invaders.render();
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
