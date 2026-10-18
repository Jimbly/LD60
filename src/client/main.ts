/*eslint @typescript-eslint/no-use-before-define:["error", { "functions": false }]*/
// eslint-disable-next-line import/order
const local_storage = require('glov/client/local_storage');
local_storage.setStoragePrefix('ld60'); // Before requiring anything else that might load from this

import { platformRegister } from 'glov/common/platform'; // eslint-disable-line import/order
platformRegister('discord', {
  devmode: 'off',
  reload: true,
  reload_updates: true,
  random_creation_name: true,
  exit: false,
});

platformRegister('itch', {
  devmode: 'off',
  reload: false,
  reload_updates: false,
  random_creation_name: true,
  exit: false,
});

import assert from 'assert';
import { actionDown, actionEdge } from 'glov/client/actions';
import { MODE_DEVELOPMENT, platformParameterGet } from 'glov/client/client_config';
import {
  debugDefineIsSet,
  startup as engineStartup,
  getFrameIndex,
  getFrameTimestamp,
  setState,
} from 'glov/client/engine';
import { ALIGN, fontStyle, fontStyleColored, intColorFromVec4Color } from 'glov/client/font';
import { Box } from 'glov/client/geom_types';
import { keyDown, keyDownEdge, KEYS } from 'glov/client/input';
import { netInit } from 'glov/client/net';
import { scoreAlloc, ScoreSystem } from 'glov/client/score';
import { scoresDraw } from 'glov/client/score_ui';
import { spriteSetGet } from 'glov/client/sprite_sets';
import { ansi_to_unicode_a, terminalCreate } from 'glov/client/terminal';
import { terminalSettingsInit, terminalSettingsShow, terminalSettingsVisible } from 'glov/client/terminal_settings';
import {
  buttonText,
  drawRect,
  loadUISprite2,
  scaleSizes,
  setFontHeight,
  uiGetFont,
  uiTextHeight,
} from 'glov/client/ui';
import { ansi, stripAnsi } from 'glov/common/ansi';
import { randSpatial } from 'glov/common/rand_fast';
import { Rec } from 'glov/common/types';
import { clamp, lerp, ridx, sign } from 'glov/common/util';
import { JSVec2, v2iNormalize, v2lerp } from 'glov/common/vmath';
import { tickMusic } from './music';
import { playSound, SOUND_DATA } from './sound_data';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { abs, ceil, cos, floor, random, round, sin, max, min, exp, pow, PI } = Math;

window.Z = window.Z || {};
Z.BACKGROUND = 1;
Z.SPRITES = 10;

// Virtual viewport for our game logic
const WINCHS = 77;
const HINCHS = 25;
const game_width = WINCHS * 8;
const game_height = HINCHS * 16;

let terminal: ReturnType<typeof terminalCreate>;

const FLOAT_DAMAGE = 'damage';

export type Score = {
  score: number;
  l0: number;
  l1: number;
  l2: number;
  l3: number;
};
let score_system: ScoreSystem<Score>;
let game_ready = false;

function init(): void {
  terminal = terminalCreate({
    z: Z.BACKGROUND + 1,
    w: WINCHS,
    h: HINCHS,
    char_width: 8,
  });

  const ENCODE_A = 100;
  score_system = scoreAlloc({
    score_to_value: (score: Score): number => {
      return (((score.score * ENCODE_A + score.l0) * ENCODE_A + score.l1) * ENCODE_A + score.l2) * ENCODE_A + score.l3;
    },
    value_to_score: (value: number): Score => {
      let l3 = value % ENCODE_A;
      value -= l3;
      value /= ENCODE_A;
      let l2 = value % ENCODE_A;
      value -= l2;
      value /= ENCODE_A;
      let l1 = value % ENCODE_A;
      value -= l1;
      value /= ENCODE_A;
      let l0 = value % ENCODE_A;
      value -= l0;
      value /= ENCODE_A;
      let score = value;
      return {
        score, l0, l1, l2, l3
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
const NOBALLS = 1<<14;

type Board = number[][];

type BulletType = 'invader_player' | 'invader_enemy' | 'kaboom';
const BULLET_CH: Record<BulletType, string> = {
  invader_player: '|',
  invader_enemy: '│/─\\',
  kaboom: '\x0f',
};
const BULLET_FG: Record<BulletType, number> = {
  invader_player: 7,
  invader_enemy: 14,
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

interface Minigame {
  // constructor(xoffs: number, state: GameState);
  state: GameState;
  xoffs: number;
  render(): void;
  renderDuringAnim?(): void;
  update(dt: number): void;
  newBoard(): void;
  won(): void;
  died(): void;
  level: number;
  score: number;
  life_threshold?: number;
  life_threshold_delta?: number;
}

const MAX_LIVES = 6;
const EXTRA_LIVE_DELTA = 100;
function addScore(game: Minigame, delta: number): void {
  if (!game.life_threshold) {
    game.life_threshold_delta = EXTRA_LIVE_DELTA * 2;
    game.life_threshold = EXTRA_LIVE_DELTA * 2;
  }
  assert(game.life_threshold_delta);
  game.score += delta;
  while (game.score > game.life_threshold) {
    let idx = game.state.minigames.indexOf(game);
    if (game.state.lives[idx] === MAX_LIVES) {
      // already at max lives, delay this one
      game.life_threshold += EXTRA_LIVE_DELTA;
    } else {
      game.life_threshold_delta += EXTRA_LIVE_DELTA;
      game.life_threshold += game.life_threshold_delta;
      game.state.lives[idx]++;
      game.state.flash_lives[idx] = 1500;
      playSound('extralife', { stereo: stereo(game.xoffs + MINIGAME_W/2) });
      game.state.floater({
        x: game.xoffs + 4 + (idx === 1 ? 0 : -1),
        y: MINIGAME_H + 2,
        fg: 10,
        text: 'EXTRA ♥',
        timer: 1500,
      });
    }
  }
}

type Ball = {
  pos: JSVec2;
  dir: JSVec2;
};

function initBoards(str: string): number[][][] {
  let lines = str.trim().split('\n');
  let ret: number[][][] = [];
  let board: number[][] = [];
  for (let ii = 0; ii < lines.length; ++ii) {
    let line = lines[ii].trim();
    if (!line) {
      if (board.length) {
        ret.push(board);
        board = [];
      }
    } else {
      board.push(line.split('').map((a) => {
        if (a === '.') {
          return 0;
        }
        if (isFinite(Number(a))) {
          return Number(a);
        }
        return 1 + randInt(BLOCK_COLORS.length - 1);
      }));
    }
  }
  if (board.length) {
    ret.push(board);
  }
  return ret;
}
const BREAKOUT_BOARDS = initBoards(`
.
.
.2.2
1.1.

.
.
1221
3..3
4224

.
12.4
1.34
12.4
1.34

.
xx.x
xx.x
x.xx
x.xx
xx.x
xx.x

.
xxxx
x..x
x..x
xxxx
x..x
x..x
xxxx

.12.
.34.
.23.
.41.
.34.
.12.
.41.
.23.
.12.
.34.
.23.
.41.

.
xxxx
xx.x
x.xx
xxxx
x.xx
xx.x
xxxx

.
xxxx
x..x
x..x
x..x
x..x
x..x
x..x
x..x
xxxx
x..x
x..x
x..x

.
xxxx
x.xx
x..x
x..x
x..x
x..x
x.xx
xxx.
x.xx
x..x
x.xx
xxxx

.
xxxx
..x.
xxx.
....
xxxx
..x.
xxxx
....
x.xx
xxxx
xx.x
.
x...
xxxx
xxxx

`);
const NUM_BALLS = 6;
function help(xoffs: number, text: string, y?: number): void {
  let lines = text.split('\n');
  for (let ii = 0; ii < lines.length; ++ii) {
    let line = lines[ii];
    terminal.print({
      fg: 8,
      x: xoffs + floor((MINIGAME_W - line.length) / 2),
      y: (y || MINIGAME_H / 2) + ii,
      text: line,
    });
  }
}
function stereo(x: number): number {
  return clamp(lerp(x / ((MINIGAME_W + 1) * 4), -1, 1), -1, 1);
}
class BreakoutState implements Minigame {
  level = 0;
  score = 0;
  board: Board;
  w = MINIGAME_W;
  h = MINIGAME_H;
  player!: number;
  player_width = 5;
  block_xoffs = 1 + floor((this.w % BREAKOUT_BLOCK_W) / 2);
  balls_left = 0;
  ball_speed = 0;
  hits = 0;
  flash = 0;
  newBall(): void {
    this.state.balls.push({
      pos: [round(this.player) + this.xoffs, this.h - 2],
      dir: [0, -1],
    });
    this.hits = 0;
  }
  xoffs: number;
  state: GameState;
  constructor(xoffs: number, state: GameState) {
    this.xoffs = xoffs;
    this.state = state;
    this.board = state.board;
    this.newBoard();
  }

  newBoard(): void {
    let { block_xoffs, w, board, xoffs, level } = this;
    let blocks_per_row = floor((w - block_xoffs) / BREAKOUT_BLOCK_W);
    let template = BREAKOUT_BOARDS[level];
    this.ball_speed = lerp(pow(0.9, level), 3, 1);
    if (!template) {
      let total_blocks = min(30 + (level - BREAKOUT_BOARDS.length) * 3, 4 * (MINIGAME_H - 2));
      let too_many_a = total_blocks >= (3 * (MINIGAME_H - 3));
      let too_many_b = total_blocks >= (4 * (MINIGAME_H - 3));
      let blocks_start = too_many_b ? 0 : 1;
      template = [];
      while (template.length < blocks_start) {
        template.push([]);
      }
      for (let yy = blocks_start; total_blocks > 0; ++yy) {
        let row: number[] = [];
        template.push(row);
        let skip_idx = too_many_a ? -1 : randInt(4);
        for (let ii = 0; ii < blocks_per_row; ++ii) {
          if (ii === skip_idx) {
            row.push(0);
          } else {
            let color = 1 + randInt(BLOCK_COLORS.length - 1);
            row.push(color);
            --total_blocks;
          }
        }
      }
    }
    for (let yy = 0; yy < template.length; ++yy) {
      let rowin = template[yy];
      let row = board[yy];
      for (let ii = 0; ii < blocks_per_row; ++ii) {
        let color = rowin[ii];
        if (color) {
          color |= QUADRUPLE;
          let x0 = xoffs + block_xoffs + ii * BREAKOUT_BLOCK_W;
          color |= (x0 & 3) << XOFFS_SHIFT;
          for (let jj = 0; jj < BREAKOUT_BLOCK_W; ++jj) {
            row[x0 + jj] = color;
          }
        }
      }
    }

    this.player = this.w / 2;
    this.balls_left = NUM_BALLS;
    this.newBall();
  }

  bounce_idx = 0;
  bounce_frame = -1;
  bounce(x: number): void {
    if (this.bounce_frame === getFrameIndex()) {
      return;
    }
    this.bounce_frame = getFrameIndex();
    playSound(`breakbounce${(this.bounce_idx % 2) + 1 as 1 |2}`, { stereo: stereo(x) });
    this.bounce_idx++;
  }

  update(dt: number): void {
    let { xoffs, state, w, h, player_width, board } = this;
    let { balls } = state;
    let spd = 0.02;
    if (dt) {
      this.player = max((this.player_width - 1) / 2 + 1, this.player - actionDown('left') * spd);
      this.player = min(w - (this.player_width - 1) / 2, this.player + actionDown('right') * spd);
    }
    if (!balls.length) {
      this.newBall();
    }
    let lost = false;
    for (let ball_idx = balls.length - 1; ball_idx >= 0; --ball_idx) {
      let ball = balls[ball_idx];
      let { pos: ball_pos, dir: ball_dir } = ball;
      let old_bx = round(ball_pos[0]);
      let old_by = round(ball_pos[1]);
      let ball_spd = dt * 0.007 * this.ball_speed;
      ball_pos[0] += ball_dir[0] * ball_spd * 2;
      ball_pos[1] += ball_dir[1] * ball_spd;
      if (ball_pos[0] < 0) {
        ball_pos[0] = 0 - ball_pos[0];
        ball_dir[0] *= -1;
        this.bounce(ball_pos[0]);
      }
      let totalw = board[0].length; // (MINIGAME_W + 1) * 3;
      if (ball_pos[0] > totalw-1) {
        ball_pos[0] = totalw-1 - (ball_pos[0] - (totalw-1));
        ball_dir[0] *= -1;
        this.bounce(ball_pos[0]);
      }
      if (ball_pos[1] <= -0.25) {
        ball_pos[1] = -0.25 + -0.25 - ball_pos[1];
        ball_dir[1] *= -1;
        this.bounce(ball_pos[0]);
      }
      let bx = round(ball_pos[0]);
      let by = round(ball_pos[1]);
      let player_pos = [
        round(this.player - (player_width - 1)/2) + xoffs,
        round(state.invaders.player - (5 - 1)/2 + state.invaders.xoffs),
      ];
      for (let ii = 0; ii < player_pos.length; ++ii) {
        let player0 = player_pos[ii];
        if (by === h - 1) {
          if (
            bx >= player0 &&
            bx < player0 + player_width
          ) {
            ball_dir[1] *= -1;
            ball_pos[1] = min(ball_pos[1], h - 2.5);
            let impact = clamp((ball_pos[0] - (player0 - 0.5 + player_width / 2)) / (player_width / 2), -1, 1);
            let soundidx = abs(impact > 0.6 ? 3 : impact > 0.25 ? 2 : 1) as 1 | 2 | 3;
            playSound(`paddle${soundidx}`, { stereo: stereo(ball_pos[0]) });
            impact *= 0.75;
            let vec = [sin(PI/2 * impact), -cos(PI/2 * impact)] as const;
            v2lerp(ball_dir, 0.5 + abs(impact) * 0.5, ball_dir, vec);
            this.hits = 0;
          }
        }
      }
      if (bx !== old_bx || by !== old_by) {
        if (by === h) {
          ridx(balls, ball_idx);
          if (bx >= xoffs && bx <= xoffs + w) {
            if (this.balls_left) {
              this.flash = 500;
              this.balls_left--;
              playSound('die-breakout', { stereo: -0.5 });
            } else {
              lost = true;
            }
          }
          if (!lost) {
            this.newBall();
          }
        } else {
          let v = board[by]?.[bx];
          if (v) {
            if (bx !== old_bx && by !== old_by) {
              if (board[by][old_bx]) {
                bx = old_bx;
                ball_pos[0] = old_bx;
              } else if (board[old_by][bx]) {
                by = old_by;
                ball_pos[1] = old_by;
              }
            }
            v = board[by][bx];
            if (!(v & (INDESTRUCTIBLE | BORDER)) && this.level) {
              let dscore = 10 + this.hits + (this.level - 1) * 0.5;
              addScore(this, dscore);
              this.hits++;
              if (dscore) {
                state.floater({
                  x: bx - 1,
                  y: by - 1,
                  fg: 10,
                  text: `+${dscore.toFixed(0)}`,
                });
              }
              let idx = (this.hits > 8 ? 8 - (this.hits % 2) : this.hits) as 1 | 8;
              playSound(`breakout${idx}`, { stereo: stereo(ball_pos[0]) });
            } else {
              this.bounce(ball_pos[0]);
            }
            state.hitBlock(bx, by);
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

    let any_left = false;
    for (let yy = 0; yy < h; ++yy) {
      for (let xx = 0; xx < w; ++xx) {
        if (board[yy][xx + xoffs + 1]) {
          any_left = true;
        }
      }
    }
    if (!any_left) {
      this.won();
    } else if (lost) {
      this.died();
    }

    this.flash -= dt;
    this.flash = max(0, this.flash);
  }
  died(): void {
    this.state.gameLost(this);
  }
  won(): void {
    playSound('won-breakout', { stereo: -0.5 });
    this.state.gameWon(this);
  }
  render(): void {
    let { xoffs, h, player, player_width, balls_left, flash, level } = this;
    terminal.normal();

    if (!level) {
      help(xoffs + 1, 'Clear the board!\nDon\'t run out\nof balls.');
    }

    if (flash) {
      let bg = flash % 250 > 150 ? 4 : 0;
      terminal.color(0, bg);
      terminal.fill({
        x: xoffs + 1,
        y: MINIGAME_H - 3,
        w: MINIGAME_W,
        h: 3,
      });
      terminal.normal();
    }

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

    let ballsx = floor((MINIGAME_W - NUM_BALLS - 2) / 2) + 1;
    terminal.moveto(ballsx + xoffs, h);
    terminal.print({ text: '╡', fg: BLOCK_COLORS[BORDER_BLOCK] });
    for (let ii = 0; ii < NUM_BALLS; ++ii) {
      terminal.print({ text: '■', fg: balls_left > ii ? 10 : 8 });
    }
    terminal.print({ text: '╞', fg: BLOCK_COLORS[BORDER_BLOCK] });
  }
}

const MATCH_LEN = 2;
function matches(color: number, block: number): boolean {
  return block === color || block === color + TARGET;
}
class BlocksState implements Minigame {
  level = 0;
  score = 0;
  w = floor(MINIGAME_W/2);
  h = MINIGAME_H;
  num_blocks = 4;
  block!: number;
  pos!: JSVec2;
  board: number[][];
  xoffs: number;
  state: GameState;
  chain = 0;
  constructor(xoffs: number, state: GameState) {
    this.xoffs = xoffs + 1;
    this.state = state;
    this.board = state.board;
    this.newBoard();
  }
  setBoard(x: number, y: number, v: number): void {
    let { board, xoffs, w } = this;
    let xpos = x*2 + xoffs;
    if (x >= w) {
      xpos++;
    }
    let newv = v;
    if (v) {
      newv |= DOUBLE;
      let xmod = xpos & 1;
      newv |= xmod << XOFFS_SHIFT;
    }
    board[y][xpos] = newv;
    board[y][xpos + 1] = newv;
  }
  logicBoard(x: number, y: number): number {
    let { board, xoffs, w } = this;
    let xx = x * 2;
    if (x >= w) {
      xx++;
    }
    let v = board[y][xoffs + xx];
    return v & (TARGET | COLORBITS | INDESTRUCTIBLE);
  }
  checkCursorWipe(): void {
    let { pos, w } = this;
    let px = round(pos[0]);
    if (px >= w) {
      this.removeCursor();
      this.newPiece();
    }
  }
  removeCursor(): void {
    let { state, xoffs, pos, block, w } = this;
    let { board } = state;
    let px = round(pos[0]);
    let py = floor(pos[1]);
    let xx = px * 2 + xoffs;
    if (px >= w) {
      xx++;
    }
    let v = block | INDESTRUCTIBLE;
    assert(board[py][xx] === v);
    assert(board[py][xx+1] === v);
    board[py][xx] = 0;
    board[py][xx+1] = 0;
  }
  addCursor(): void {
    let { state, xoffs, pos, block, w } = this;
    let { board } = state;
    let px = round(pos[0]);
    let py = floor(pos[1]);
    let xx = px * 2 + xoffs;
    if (px >= w) {
      xx++;
    }
    let v = block | INDESTRUCTIBLE;
    assert(!board[py][xx]);
    assert(!board[py][xx+1]);
    board[py][xx] = v;
    board[py][xx+1] = v;
  }
  checkForClears(): void {
    let { w, h, xoffs } = this;
    // check for clears
    let to_clear: JSVec2[] = [];
    for (let yy = 0; yy < h; ++yy) {
      for (let xx = 0; xx < w; ++xx) {
        let color = this.logicBoard(xx, yy);
        if (!color) {
          continue;
        }
        let any_non_target = false;
        if (color & TARGET) {
          color -= TARGET;
        } else {
          any_non_target = true;
        }
        if (xx <= w - MATCH_LEN) {
          let match_len = 1;
          let ant = any_non_target;
          while (xx + match_len < w && matches(color, this.logicBoard(xx + match_len, yy))) {
            if (!(this.logicBoard(xx + match_len, yy) & TARGET)) {
              ant = true;
            }
            ++match_len;
          }
          if (match_len >= MATCH_LEN && ant) {
            for (let ii = 0; ii < match_len; ++ii) {
              to_clear.push([xx + ii, yy]);
            }
          }
        }
        if (yy <= h - MATCH_LEN) {
          let match_len = 1;
          let ant = any_non_target;
          while (yy + match_len < h && matches(color, this.logicBoard(xx, yy + match_len))) {
            if (!(this.logicBoard(xx, yy + match_len) & TARGET)) {
              ant = true;
            }
            ++match_len;
          }
          if (match_len >= MATCH_LEN && ant) {
            for (let ii = 0; ii < match_len; ++ii) {
              to_clear.push([xx, yy + ii]);
            }
          }
        }
      }
    }
    for (let ii = 0; ii < to_clear.length; ++ii) {
      let [x, y] = to_clear[ii];
      let color = this.logicBoard(x, y);
      if (color) {
        if (this.level) {
          let v = this.chain * 8;
          addScore(this, v);
          this.state.floater({
            x: xoffs + x * 2,
            y: y,
            fg: BLOCK_COLORS[(color & ~TARGET)],
            w: 2,
            text: FLOAT_DAMAGE,
          });
          if (v) {
            this.state.floater({
              x: xoffs + x * 2 + 2,
              y: y - 1,
              fg: 10,
              text: `+${v}`,
            });
          }
        }
        this.chain++;
        this.setBoard(x, y, 0);
      }
    }
    if (to_clear.length) {
      playSound('blocks-clear', { stereo: 0.5 });
    }
  }
  piece_count = 0;
  newPiece(): void {
    this.chain = 0;
    this.checkForClears();
    this.block = randInt(this.num_blocks) + 1;
    if (this.level === 0) {
      let highest_color = -1;
      let seen_colors: Rec<number, true> = {};
      let { w, h } = this;
      for (let yy = 0; yy < h; ++yy) {
        for (let xx = 0; xx < w; ++xx) {
          let c = this.logicBoard(xx, yy);
          if (c & TARGET) {
            c &= ~TARGET;
            if (highest_color === -1) {
              highest_color = c & ~TARGET;
            }
            seen_colors[highest_color] = true;
          }
        }
      }
      if (this.piece_count === 0) {
        this.block = highest_color;
      } else if (this.piece_count === 1) {
        if (!seen_colors[1]) {
          this.block = 1;
        } else if (!seen_colors[2]) {
          this.block = 2;
        } else {
          this.block = 3;
        }
      }
      this.piece_count++;
    }
    this.pos = [this.w/2, 0];
    let px = round(this.pos[0]);
    let py = floor(this.pos[1]);
    if (this.logicBoard(px, py)) {
      // lose
      this.died();
    } else {
      this.addCursor();
    }
  }
  died(): void {
    playSound('die-blocks', { stereo: 0.5 });
    this.state.gameLost(this);
  }
  won(): void {
    playSound('won-blocks', { stereo: 0.5 });
    this.state.gameWon(this);
  }
  drop_speed = 0;
  newBoard(): void {
    let { w, h, num_blocks, state, xoffs, level } = this;
    state.clearBoard(xoffs);
    this.drop_speed = lerp(pow(0.9, level), 1.8, 1);
    let num_targets = min(level === 0 ? 3 :
      10 + level * 5, 100);
    for (let ii = 0; ii < num_targets; ++ii) {
      while (true) {
        let x = randInt(w);
        let y = 5 + randInt(h - 5);
        if (this.logicBoard(x, y)) {
          continue;
        }
        this.setBoard(x, y, TARGET | (randInt(num_blocks) + 1));
        break;
      }
    }
    this.newPiece();
  }
  down_time = 0;
  drop_timer = 0;
  update(dt: number): void {
    let { pos, w, h, board, xoffs } = this;
    let pspd = 1 / 250;
    this.removeCursor();
    let old_px = round(pos[0]);
    let old_py = floor(pos[1]);
    assert(!this.logicBoard(old_px, old_py));
    if (dt) {
      if (actionEdge('left', { peek: true })) {
        pos[0] = round(pos[0]) - 0.51;
      }
      pos[0] -= pspd * actionDown('left');
      if (actionEdge('right', { peek: true })) {
        pos[0] = round(pos[0]) + 0.51;
      }
      pos[0] += pspd * actionDown('right');
    }
    let px = round(pos[0]);
    if (px > old_px && px === w || px < old_px && px === w - 1) {
      // bumping right edge, do damage, or pass through
      let v = board[old_py][w*2 + xoffs];
      if (v & INDESTRUCTIBLE) {
        pos[0] = old_px;
      } else {
        let hp = (v >> HP_SHIFT) & HP_MASK;
        if (hp === 1) {
          // pass through
        } else {
          // do damage and pass through
          hp = 1;
          v = (v & ~(HP_MASK << HP_SHIFT)) | (hp << HP_SHIFT);
          board[old_py][w*2 + xoffs] = v;
          // pos[0] = old_px;
        }
      }
    }
    pos[0] = clamp(pos[0], 0, w * 2);
    px = round(pos[0]);
    if (this.logicBoard(px, old_py)) {
      // user pushed into something horizontally
      px = old_px;
      pos[0] = old_px;
    }
    pos[1] += dt * 0.002 * this.drop_speed;
    if (dt) {
      if (actionEdge('down', { peek: true })) {
        pos[1] = old_py + 1;
        pos[1] = floor(pos[1]);
      }
      if (actionDown('down')) {
        this.down_time += actionDown('down');
        if (this.down_time > 140) {
          pos[1] = old_py + 1;
          pos[1] = floor(pos[1]);
          this.down_time -= 140;
        }
      } else {
        this.down_time = 0;
      }
    }

    let py = floor(pos[1]);
    if (py >= h) {
      this.setBoard(px, old_py, this.block);
      playSound('blocks-place', { stereo: 0.5 });
      this.newPiece();
    } else if (this.logicBoard(px, py)) {
      if (py !== old_py) {
        this.setBoard(px, old_py, this.block);
        playSound('blocks-place', { stereo: 0.5 });
        this.newPiece();
      } else {
        assert(false); // should have been blocked above
      }
    } else {
      this.addCursor();
    }

    this.drop_timer -= dt;
    let do_drops = this.drop_timer <= 0;
    if (do_drops) {
      this.drop_timer += 150;
    }

    let any_targets = false;
    for (let yy = h - 1; yy >= 0; yy--) {
      for (let xx = 0; xx < w; ++xx) {
        let color = this.logicBoard(xx, yy);
        if (color & TARGET) {
          any_targets = true;
        } else if (do_drops && color && !(color & INDESTRUCTIBLE) && yy < h - 1) {
          // a plain piece
          let below = this.logicBoard(xx, yy + 1);
          if (!below) {
            // nothing below, drop it!
            this.setBoard(xx, yy, 0);
            this.setBoard(xx, yy + 1, color);
          }
        }
      }
    }
    if (do_drops) {
      this.checkForClears();
    }
    if (!any_targets) {
      // win
      return this.won();
    }
  }
  render(): void {
    if (!this.level) {
      let { w, xoffs } = this;
      let streak = 0;
      let yavail = -1;
      for (let yy = 4; yy < MINIGAME_H; ++yy) {
        let row_clear = true;
        for (let xx = 0; xx < w; ++xx) {
          if (this.logicBoard(xx, yy)) {
            row_clear = false;
          }
        }
        if (row_clear) {
          ++streak;
          if (streak === 4) {
            yavail = yy - 3;
            break;
          }
        } else {
          streak = 0;
        }
      }
      if (yavail !== -1) {
        help(xoffs, 'Match colors.\nClear \x02\x02 to win.\n↓ or S to drop', yavail);
      }
    }
  }
}

const INVADER_BULLET_TIME = 250;
const PLAYER_SHOOT_TIME = 1000;
class InvadersState implements Minigame {
  level = 0;
  score = 0;
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
  invader_move_time = 0;
  invader_shoot_time = 0;
  newBoard(): void {
    this.player = this.w/2;
    this.state.clearBullets('invader_player');
    this.state.clearBullets('invader_enemy');
    this.invaders = [];
    let { invaders, w, xoffs } = this;
    let yy = 0;
    let opts = ['\x0f', '\x15'];
    let num_invaders;
    let invader_pad = 3;
    let level_exp = min(1, pow(0.9, this.level - 1));
    this.invader_move_time = 1000;
    this.invader_shoot_time = round(lerp(level_exp, this.invader_move_time / 2, this.invader_move_time * 4));

    if (this.level === 0) {
      num_invaders = 4;
      yy += 8;
    } else {
      num_invaders = min(7 * 10, 8 + this.level * 4);
      if (this.level >= 10) {
        invader_pad = 2;
      }
      if (num_invaders < 6 * 4) {
        yy += 4 - ceil(num_invaders / 6);
      }
    }
    let xx = invader_pad;

    for (let ii = 0; ii < num_invaders; ++ii) {
      invaders.push([xx, yy, [4, 5, 12, 13][randInt(4)], opts[ii % opts.length]]);
      xx += 2;
      if (xx >= w - invader_pad) {
        xx = invader_pad;
        yy++;
      }
    }
    this.state.clearBoard(xoffs);
    this.placeInvaders();
    this.move_counter = this.invader_move_time;
    this.move_dir = 1;
    this.shoot_counter = this.invader_shoot_time;
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
    playSound('die-invaders', { stereo: -1 });
    this.state.gameLost(this);
  }
  won(): void {
    playSound('won-invaders', { stereo: -1 });
    this.state.gameWon(this);
  }
  updateInvaders(dt: number): void {
    this.move_counter -= dt;
    if (this.move_counter > 0) {
      return;
    }
    this.removeInvaders();
    this.move_counter += this.invader_move_time;
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
    for (let ii = invaders.length - 1; ii >= 0; --ii) {
      let invader = invaders[ii];
      invader[0] += dx;
      invader[1] += dy;
      if (invader[1] === h) {
        invaders.splice(ii, 1);
      }
    }
    this.placeInvaders();
  }
  fireBullets(dt: number): void {
    this.shoot_counter -= dt;
    if (this.shoot_counter > 0) {
      return;
    }
    this.shoot_counter += this.invader_shoot_time;
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
  last_sound_idx = -1;
  update(dt: number): void {
    let { w } = this;
    let hspd = 0.01 * 0.7;
    if (dt) {
      this.player = max(1, this.player - actionDown('left') * hspd);
      this.player = min(w - 2, this.player + actionDown('right') * hspd);
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
        while (true) {
          let sound_idx = randInt(3) + 1 as 1 | 3;
          if (sound_idx !== this.last_sound_idx) {
            this.last_sound_idx = sound_idx;
            playSound(`invaders-break${sound_idx}`, { stereo: -1 });
            break;
          }
        }
        state.floater({
          x: item[0] + xoffs,
          y: item[1],
          text: FLOAT_DAMAGE,
          fg: 12,
        });
        if (this.level) {
          let v = 7 + this.level;
          addScore(this, v);
          if (v) {
            state.floater({
              x: xoffs + item[0] + 1,
              y: item[1] - 1,
              fg: 10,
              text: `+${v.toFixed(0)}`,
            });
          }
        }
      }
    }
    this.placeInvaders();
    for (let ii = 0; ii < bullets.length; ++ii) {
      let b = bullets[ii];
      if (b.type === 'invader_enemy') {
        if (checkHit(b.x - xoffs, b.y)) {
          bullets.splice(ii, 1);
          playSound('invaders-bulletbreak', { stereo: -1 });
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
    let { invaders, player, w, h, xoffs, level } = this;

    if (!level) {
      help(xoffs, 'Shoot the\ninvaders.\nDon\'t get hit\n\nUse A/D or ←→\nor Gamepad');
    }

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

const KABOOM_BULLET_TIME = 200;
class KaboomState implements Minigame {
  level = 0;
  score = 0;
  w = MINIGAME_W;
  h = MINIGAME_H;
  player_width = 5;
  player = 0;
  py = this.h - 4;
  enemy = 0;
  enemy_counter = 0;
  shoot_counter = 0;
  shoot_count = 0;
  bullet_counter = 0;
  enemy_target = 0;
  board: Board;
  xoffs: number;
  state: GameState;
  points = 0;
  goal = 0;
  kaboom_speed = 100;
  kaboom_shoot_rest_time = 4000;
  kaboom_num_shots = 10;
  constructor(xoffs: number, state: GameState) {
    this.xoffs = xoffs + 1;
    this.state = state;
    this.board = state.board;
    this.newBoard();
  }
  newBoard(): void {
    let { state, w, h, xoffs, board, level } = this;
    this.player = w / 2;
    this.enemy = w / 2;
    this.enemy_counter = 0;
    this.shoot_counter = 2000;
    this.shoot_count = 0;
    this.bullet_counter = KABOOM_BULLET_TIME / 2;
    this.points = 0;
    this.goal = 20 + max(0, (level - 1) * 8);
    let level_exp = min(1, pow(0.9, level - 1));
    this.kaboom_speed = round(lerp(level_exp, 40, 100));
    this.kaboom_shoot_rest_time = round(lerp(level_exp, 2000, 4000));
    this.kaboom_num_shots = round(lerp(level_exp, 20, 10));
    state.clearBoard(xoffs);
    state.clearBullets('kaboom');
    let rows = 2;
    let blocks_per_row = w / 2;
    if (level === 0) {
      rows = 1;
      blocks_per_row = 3;
    } else if (level > 6) {
      blocks_per_row -= 2;
    }
    for (let yy = h - rows; yy < h; ++yy) {
      let row = board[yy];
      for (let xx = 0; xx < blocks_per_row; ++xx) {
        let v = randInt(BLOCK_COLORS.length - 1) + 1;
        let xpos = xoffs + (xx + floor((w/2 - blocks_per_row)/2)) * 2;
        v |= DOUBLE;
        let xmod = xpos & 1;
        v |= xmod << XOFFS_SHIFT;
        row[xpos] = v;
        row[xpos + 1] = v;
      }
    }
  }
  died(): void {
    playSound('die-kaboom', { stereo: 1 });
    this.state.gameLost(this);
  }
  won(): void {
    playSound('won-kaboom', { stereo: 1 });
    this.state.gameWon(this);
  }
  update(dt: number): void {
    this.bullet_counter -= dt;
    if (this.bullet_counter < 0) {
      this.bullet_counter += KABOOM_BULLET_TIME;
    }
    let { w, h, py, player_width, board, state, xoffs } = this;
    let { bullets } = state;
    this.shoot_counter -= dt;
    if (this.shoot_counter <= 0) {
      this.shoot_counter += this.kaboom_speed * 3;
      this.shoot_count++;
      let existing = false;
      for (let ii = 0; ii < bullets.length; ++ii) {
        if (bullets[ii].x === this.enemy + xoffs &&
          bullets[ii].y === 1
        ) {
          existing = true;
        }
      }
      if (!existing) {
        bullets.push({
          x: this.enemy + xoffs,
          y: 1,
          ydir: 1,
          ycounter: this.bullet_counter,
          ytime: KABOOM_BULLET_TIME,
          type: 'kaboom',
        });
      }
      if (this.shoot_count === this.kaboom_num_shots) {
        this.shoot_count = 0;
        this.shoot_counter += this.kaboom_shoot_rest_time;
      }
    }
    this.enemy_counter -= dt;
    if (this.enemy_counter <= 0) {
      this.enemy_counter += this.kaboom_speed;
      while (this.enemy_target === this.enemy) {
        let valid_targets = [];
        for (let ii = 0; ii < w; ++ii) {
          if (board[h-1][xoffs + ii]) {
            valid_targets.push(ii);
          }
        }
        if (valid_targets.length) {
          let idx = randInt(valid_targets.length);
          this.enemy_target = valid_targets[idx];
        }
        if (this.enemy_target === this.enemy) {
          this.enemy_target = randInt(this.w);
        }
      }
      let delta = sign(this.enemy_target - this.enemy);
      this.enemy += delta;
    }

    let hspd = 0.01 * 4;
    if (dt) {
      this.player = max((player_width - 1) / 2, this.player - actionDown('left') * hspd);
      this.player = min(w - (player_width - 1) / 2 - 1, this.player + actionDown('right') * hspd);
    }

    let px = round(this.player - (player_width - 1) / 2) + xoffs;
    let dead = false;
    for (let ii = bullets.length - 1; ii >= 0; --ii) {
      let b = bullets[ii];
      if (b.type !== 'kaboom') {
        continue;
      }
      if (
        b.y === py && b.x >= px && b.x < px + player_width ||
        b.y === py + 1 && b.x >= px + 1 && b.x < px + player_width - 1
      ) {
        this.points++;
        let sound_idx = 2 - (this.points % 2) as 1 | 2;
        playSound(`kaboom-catch${sound_idx}`, { stereo: 1 });
        if (this.level) {
          let v = 3 + (this.level - 1) / 5;
          addScore(this, v);
        }
        ridx(bullets, ii);
      } else if (board[b.y][b.x]) {
        state.hitBlock(b.x, b.y);
        playSound('kaboom-break', { stereo: 1 });
        ridx(bullets, ii);
      }
    }

    let any_left = false;
    for (let yy = 0; yy < h; ++yy) {
      for (let xx = 0; xx < w; ++xx) {
        if (board[yy][xoffs + xx]) {
          any_left = true;
          break;
        }
      }
    }
    if (!any_left) {
      dead = true;
    }
    if (this.points >= this.goal) {
      this.won();
    } else if (dead) {
      this.died();
    }
  }
  render(): void {
    terminal.normal();
    let { player, player_width, enemy, py, xoffs, board, level } = this;

    if (!level) {
      help(xoffs, 'Protect your\nblocks.\nCollect enough\nto win.');
    }

    let px = round(player - (player_width - 1) / 2) + xoffs;
    function overlay(x: number, y: number, str: string): void {
      for (let ii = 0; ii < str.length; ++ii) {
        let ch = str[ii];
        let v = board[y][x + ii];
        let c = v & COLORBITS;
        let bg = 0;
        if (c) {
          bg = BLOCK_COLORS[c] - 8;
        }
        terminal.print({
          x: x + ii,
          y,
          fg: 11,
          bg,
          text: ch,
        });
      }
    }
    overlay(max(0, px), py, '\\═══/');
    overlay(max(0, px) + 1, py + 1, '\\═/');
    terminal.normal();

    if (MODE_DEVELOPMENT && false) {
      terminal.print({
        x: this.enemy_target + xoffs,
        y: 0,
        fg: 12,
        text: '\x02',
      });
    }
    terminal.print({
      x: enemy + xoffs,
      y: 0,
      fg: 12,
      text: '\x01',
    });
    this.renderDuringAnim();
  }
  renderDuringAnim(): void {
    let { xoffs, points, goal, h } = this;
    let text = `${points} / ${goal}`;
    let ballsx = floor((MINIGAME_W - text.length - 2) / 2) + 1;
    terminal.moveto(ballsx + xoffs, h);
    terminal.print({ text: '╡', fg: BLOCK_COLORS[BORDER_BLOCK] });
    terminal.print({ text, fg: 10 });
    terminal.print({ text: '╞', fg: BLOCK_COLORS[BORDER_BLOCK] });
  }
}

const ANIM_LOST_TIME = 2000;
const ANIM_WON_TIME = 2000;

const WALL_X = [
  0,
  MINIGAME_W + 1,
  (MINIGAME_W + 1) * 2,
  (MINIGAME_W + 1) * 3,
  (MINIGAME_W + 1) * 4 + 1 - 1,
];
const INITIAL_HP = 3; // MODE_DEVELOPMENT ? 0 : 3;
type GameData = {
  a: number;
  b: number;
};
const META_MAP = [
  [true, false, false, false],
  [false, true, false, false],
  [false, false, true, false],
  [false, false, false, true],
  [true, true, false, false],
  [true, true, true, false],
  [true, true, true, true],
];

const DAMAGE_CHARS = '░■▒\x0f▓';
type Floater = {
  x: number;
  y: number;
  w?: number; // if FLOAT_DAMAGE
  fg: number;
  text: string;
  timer?: number;
};
class GameState {
  mode: 'explore' | 'combat' = 'explore';
  data: GameData = { a: 0, b: 0 };
  lives!: number[];
  flash_lives!: number[];
  board!: Board;
  invaders!: InvadersState;
  breakout!: BreakoutState;
  blocks!: BlocksState;
  kaboom!: KaboomState;
  minigames!: Minigame[];
  bullets!: Bullet[];
  balls!: Ball[];
  game_over = false;
  meta = 0;
  active!: boolean[];
  constructor() {
    this.initBoard();
  }
  freshWall(idx: number, y: number): number {
    let v = BORDER | BORDER_BLOCK;
    if (idx === 0 || idx === 4) {
      v |= INDESTRUCTIBLE;
    } else if (idx === 1 || idx === 2) {
      v |= (y === 0 || y > MINIGAME_H - 4) ?
        INDESTRUCTIBLE :
        (INITIAL_HP<<HP_SHIFT);
      if (!INITIAL_HP && !(v & INDESTRUCTIBLE)) {
        v = 0;
      }
    } else if (idx === 3) {
      let hp = 3;
      v |= (y === 0 || y > MINIGAME_H - 4) ?
        INDESTRUCTIBLE :
        ((hp<<HP_SHIFT) | NOBALLS);
      if (!hp && !(v & INDESTRUCTIBLE)) {
        v = 0;
      }
    }
    return v;
  }
  placeWall(idx: number): void {
    let { board } = this;
    let x = WALL_X[idx];

    for (let yy = 0; yy < MINIGAME_H; ++yy) {
      board[yy][x] = this.freshWall(idx, yy);
    }
  }
  rebuildWall(idx: number): void {
    let { board } = this;
    let x = WALL_X[idx];

    for (let yy = 0; yy < MINIGAME_H; ++yy) {
      let v = board[yy][x];
      if (!v) {
        v = BORDER | BORDER_BLOCK;
        let hp = 1;
        if (idx === 3) {
          hp = 3;
        }
        if (!INITIAL_HP) {
          continue;
        }
        v |= hp << HP_SHIFT;
      }
      v |= INDESTRUCTIBLE;
      board[yy][x] = v;
    }
  }
  softenWall(idx: number): void {
    let { board } = this;
    let x = WALL_X[idx];

    for (let yy = 0; yy < MINIGAME_H; ++yy) {
      let v = board[yy][x];
      if (v & INDESTRUCTIBLE) {
        if (this.freshWall(idx, yy) & INDESTRUCTIBLE) {
          // always solid, don't touch
        } else {
          v &= ~INDESTRUCTIBLE;
          let hp = (v >> HP_SHIFT) & HP_MASK;
          if (hp && hp > 2) {
            v &= ~(HP_MASK << HP_SHIFT) | (2 << HP_SHIFT);
          }
          board[yy][x] = v;
        }
      }
    }
  }
  total_score = 0;
  initBoard(): void {
    this.floaters = [];
    this.board = [];
    this.total_score = 0;
    let board = this.board;
    let w = (MINIGAME_W + 1) * 4 + 1;
    for (let yy = 0; yy < MINIGAME_H; ++yy) {
      let row: number[] = [];
      board.push(row);
      for (let xx = 0; xx < w; ++xx) {
        row.push(0);
      }
    }
    for (let ii = 0; ii < 5; ++ii) {
      this.placeWall(ii);
    }
    this.bullets = [];
    this.balls = [];
    this.invaders = new InvadersState(0, this);
    this.breakout = new BreakoutState(MINIGAME_W + 1, this);
    this.blocks = new BlocksState((MINIGAME_W + 1) * 2, this);
    this.kaboom = new KaboomState((MINIGAME_W + 1) * 3, this);
    this.minigames = [
      this.invaders,
      this.breakout,
      this.blocks,
      this.kaboom,
    ];
    this.lives = [];
    for (let ii = 0; ii < this.minigames.length; ++ii) {
      this.lives.push(3);
    }
    this.flash_lives = [];
    this.game_over = false;
    this.meta = 0;
    if (MODE_DEVELOPMENT && false) {
      while (this.meta < 6) {
        let idx = this.meta % 4;
        this.gameWon(this.minigames[idx]);
        this.minigames[idx].newBoard();
      }
      this.anims = [];
    }
    this.active = META_MAP[this.meta];
    // if (MODE_DEVELOPMENT) {
    //   this.gameLost(this.breakout);
    //   this.gameLost(this.breakout);
    //   this.gameLost(this.breakout);
    //   this.gameLost(this.breakout);
    // }
  }

  anims: ({ type: 'won' | 'lost'; counter: number; max_counter: number } | null)[] = [];
  gameLost(game: Minigame): void {
    let { minigames, anims, lives } = this;
    let idx = minigames.indexOf(game);
    assert(idx !== -1);
    anims[idx] = {
      type: 'lost',
      counter: ANIM_LOST_TIME,
      max_counter: ANIM_LOST_TIME,
    };
    this.animStarted(idx);
    if (!lives[idx]) {
      this.game_over = true;
      for (let ii = 0; ii < minigames.length; ++ii) {
        if (!anims[ii]) {
          anims[ii] = {
            type: 'lost',
            counter: ANIM_LOST_TIME + 500 + ii * 200,
            max_counter: ANIM_LOST_TIME + 500 + ii * 200,
          };
        }
      }
    } else {
      if (this.meta >= 4) {
        lives[idx]--;
      }
    }
  }
  animStarted(idx: number): void {
    let { balls } = this;
    if (idx === 3) {
      this.blocks.checkCursorWipe();
    }
    this.rebuildWall(idx);
    this.rebuildWall(idx + 1);

    let x0 = idx * (MINIGAME_W + 1);
    let x1 = x0 + MINIGAME_W + 1;
    for (let ii = balls.length - 1; ii >= 0; --ii) {
      let b = balls[ii];
      if (b.pos[0] >= x0 && b.pos[0] <= x1) {
        ridx(balls, ii);
      }
    }
  }

  gameWon(game: Minigame): void {
    let idx = this.minigames.indexOf(game);
    assert(idx !== -1);
    this.anims[idx] = {
      type: 'won',
      counter: ANIM_WON_TIME,
      max_counter: ANIM_WON_TIME,
    };
    this.animStarted(idx);
    game.level++;
    if (this.meta < META_MAP.length - 1) {
      this.meta++;
      this.active = META_MAP[this.meta];
      for (let ii = 1; ii < 4; ++ii) {
        if (this.active[ii-1] && this.active[ii]) {
          this.softenWall(ii);
        } else {
          this.rebuildWall(ii);
        }
      }
    }
  }

  floaters!: Floater[];
  floater(float: Floater): void {
    float.timer = float.timer || 333;
    this.floaters.push(float);
  }

  updateFloaters(dt: number): void {
    let { floaters } = this;
    for (let ii = floaters.length - 1; ii >= 0; --ii) {
      let float = floaters[ii];
      float.timer! -= dt;
      if (float.timer! <= 0) {
        floaters.splice(ii, 1);
      }
    }
  }

  anim_ts = 0;
  update(dt: number): void {
    if (game_ready) {
      this.anim_ts += dt;
    }
    this.updateFloaters(dt);
    this.updateBullets(dt);
    for (let ii = 0; ii < this.minigames.length; ++ii) {
      let anim = this.anims[ii];
      if (anim) {
        anim.counter -= dt;
        if (anim.counter <= 0) {
          if (this.game_over) {
            anim.counter = 0;
          } else {
            this.anims[ii] = null;
            if (this.active[ii-1] && this.active[ii]) {
              this.softenWall(ii);
            }
            if (this.active[ii] && this.active[ii + 1]) {
              this.softenWall(ii + 1);
            }
            this.minigames[ii].newBoard();
          }
        }
      } else if (!this.game_over) {
        if (this.active[ii]) {
          this.minigames[ii].update(dt);
        }
      }
    }
    this.updateLate(dt);
  }
  updateLate(dt: number): void {
    let { bullets, balls, flash_lives } = this;
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
    for (let ii = 0; ii < flash_lives.length; ++ii) {
      if (flash_lives[ii]) {
        flash_lives[ii] -= dt;
        if (flash_lives[ii] < 0) {
          flash_lives[ii] = 0;
        }
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
  hitBlock(bx: number, by: number): 'bounce' | 'destroy' {
    let { board } = this;
    let v = board[by][bx];
    if (v & (INDESTRUCTIBLE | NOBALLS)) {
      return 'bounce';
    }
    let newv = 0;
    if (v & HP) {
      let hp = (v & HP) >> HP_SHIFT;
      hp--;
      if (hp) {
        newv = (v & ~HP) | (hp << HP_SHIFT);
      }
    }
    let block_color = v & COLORBITS;
    let block_w = (v & QUADRUPLE) ? 4 : (v & DOUBLE) ? 2 : 1;
    let block_xoffs = (v >> XOFFS_SHIFT) & 3;
    let blockx = floor((bx - block_xoffs) / block_w) * block_w + block_xoffs;
    for (let ii = 0; ii < block_w; ++ii) {
      let xx = blockx + ii;
      if (board[by][xx]) {
        board[by][xx] = newv;
      }
    }
    this.floater({
      x: blockx,
      y: by,
      fg: BLOCK_COLORS[block_color],
      w: block_w,
      text: FLOAT_DAMAGE,
    });
    return 'destroy';
  }

  renderEarly(): void {
    terminal.normal();
    terminal.fill({
      x: 1, y: 0,
      w: (MINIGAME_W + 1) * 4 - 1,
      h: MINIGAME_H,
    });

    let { board, active } = this;

    for (let yy = 0; yy < board.length; ++yy) {
      let row = board[yy];
      for (let xx = 0; xx < row.length; ++xx) {
        let v = row[xx];
        if (!v) {
          continue;
        }
        let xm = xx % (MINIGAME_W + 1);
        let game_idx = clamp(floor(xx / (MINIGAME_W + 1)), 0, 3);
        if (!active[game_idx] && !(active[game_idx - 1] && xm === 0)) {
          continue;
        }
        let ch = (v & INDESTRUCTIBLE) ? '▓' : (v & TARGET) ? '\x02' : '█';
        let hp = (v & HP) >> HP_SHIFT;
        let fg = BLOCK_COLORS[v & COLORBITS];
        let bg = (v & TARGET) ? 0 :
          BLOCK_COLORS[v & COLORBITS] - 8;
        if (v & BORDER) {
          bg = 0;
          ch = ((v & INDESTRUCTIBLE) && !hp || hp === 3) ? '║' : '│';
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
    terminal.normal();
  }

  renderLate(): void {
    let { active, anims, balls, bullets, minigames, lives, flash_lives, floaters } = this;
    for (let ii = 0; ii < bullets.length; ++ii) {
      let b = bullets[ii];
      let chs = BULLET_CH[b.type];
      terminal.print({
        x: b.x,
        y: b.y,
        fg: BULLET_FG[b.type],
        text: chs[floor(getFrameTimestamp() / 100) % chs.length],
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

    if (this.meta >= 4) {
      let total_score = 0;
      for (let ii = 0; ii < minigames.length; ++ii) {
        if (!active[ii]) {
          continue;
        }
        let minigame = minigames[ii];
        let xoffs = minigame.xoffs;
        if (ii === 1) {
          xoffs++;
        }
        let y = MINIGAME_H + 1;
        let ballsx = floor((MINIGAME_W - MAX_LIVES - 2) / 2);
        terminal.moveto(ballsx + xoffs, y);
        let border = 1;
        if (flash_lives[ii]) {
          border = flash_lives[ii] % 250 < 100 ? 2 : 10;
        } else if (lives[ii] >= MAX_LIVES) {
          border = 10;
        } else if (lives[ii] <= 1) {
          border = getFrameTimestamp() % 250 < 100 ? 4 : 12;
        }
        terminal.print({ text: '[', fg: border });
        for (let jj = 0; jj < MAX_LIVES; ++jj) {
          let good = lives[ii] > jj;
          terminal.print({ text: good ? '♥' : '♦', fg: good ? 10 : 8 });
        }
        terminal.print({ text: ']', fg: border });

        y++;
        let text = `  Level ${minigame.level}  `;
        ballsx = floor((MINIGAME_W - text.length) / 2);
        terminal.moveto(ballsx + xoffs, y);
        terminal.print({ text, fg: 7 });

        y++;
        total_score += minigame.score;
        text = `Score ${ansi.green.bright(minigame.score.toFixed(0))}`;
        ballsx = floor((MINIGAME_W - stripAnsi(text).length) / 2);
        terminal.moveto(ballsx + xoffs, y);
        terminal.print({ text, fg: 8 });
      }
      let y = MINIGAME_H + 1;
      let text = 'Total';
      terminal.moveto(floor((WINCHS - text.length)/2), y);
      terminal.print({ text, fg: 8 });
      y++;
      text = 'Score';
      terminal.moveto(floor((WINCHS - text.length)/2), y);
      terminal.print({ text, fg: 8 });
      y++;
      text = `${ansi.yellow.bright(total_score.toFixed(0))}`;
      terminal.moveto(floor((WINCHS - stripAnsi(text).length)/2), y);
      terminal.print({ text, fg: 7 });

      if (total_score > this.total_score) {
        this.total_score = total_score;
        setScore();
      }
    }

    for (let ii = 0; ii < 4; ++ii) {
      if (!active[ii]) {
        let minigame = minigames[ii];
        if (anims[ii]) {
          minigame.renderDuringAnim?.();
        } else {
          let xoffs = minigame.xoffs;
          if (ii === 1) {
            xoffs++;
          }
          for (let yy = 0; yy < MINIGAME_H; ++yy) {
            for (let xx = 0; xx < MINIGAME_W; ++xx) {
              let ch = String.fromCharCode(ansi_to_unicode_a[
                176 + floor(((randSpatial(777, xx + xoffs, yy, 1) + this.anim_ts/190000)%1) * (247-176))]);
              terminal.print({
                x: xx + xoffs,
                y: yy,
                text: ch,
                fg: 8,
                bg: 0,
              });
            }
          }
        }
      }
    }

    for (let ii = 0; ii < floaters.length; ++ii) {
      let float = floaters[ii];
      let { text } = float;
      if (text === FLOAT_DAMAGE) {
        let num_c = float.w || 1;
        text = '';
        for (let jj = 0; jj < num_c; ++jj) {
          text += DAMAGE_CHARS[floor(float.timer! / 66 + jj) % DAMAGE_CHARS.length];
        }
      }
      terminal.print({
        x: float.x,
        y: float.y,
        fg: float.fg,
        text,
      });
    }
  }

  render(): void {
    this.renderEarly();
    for (let ii = 0; ii < this.minigames.length; ++ii) {
      let minigame = this.minigames[ii];
      if (this.active[ii]) {
        minigame.render();
      }
    }
    this.renderLate();

    for (let ii = 0; ii < this.minigames.length; ++ii) {
      let minigame = this.minigames[ii];
      let anim = this.anims[ii];
      if (anim) {
        let p = 1 - anim.counter / anim.max_counter;
        let xoffs = minigame.xoffs;
        if (ii === 1) {
          xoffs++;
        }
        let maxy = floor((MINIGAME_H + 3) * p);
        if (anim.type === 'lost') {
          for (let jj = 0; jj < maxy; ++jj) {
            let yy = MINIGAME_H - 1 - jj;
            if (yy < 0) {
              break;
            }
            let xindent = jj === maxy - 1 ? 3 : jj === maxy - 2 ? 1 : 0;
            for (let xx = xindent; xx < MINIGAME_W - xindent; ++xx) {
              terminal.print({
                x: xoffs + xx,
                y: yy,
                fg: [12, 13, 14][floor(randSpatial(1, xx, yy, 0) * 3)],
                bg: [4, 5, 6][floor(randSpatial(2, xx, yy, 0) * 3)],
                text: String.fromCharCode([19, 4, 15][floor(randSpatial(3, xx, yy, 0) * 3)]),
              });
            }
          }
        } else {
          for (let yy = 0; yy < maxy; ++yy) {
            if (yy >= MINIGAME_H) {
              break;
            }
            let xindent = yy === maxy - 1 ? 3 : yy === maxy - 2 ? 1 : 0;
            for (let xx = xindent; xx < MINIGAME_W - xindent; ++xx) {
              terminal.print({
                x: xoffs + xx,
                y: yy,
                fg: 10,
                bg: 2,
                text: '\x02',
              });
            }
          }
        }
      }
      terminal.normal();
    }
  }
  checkGameOver(): void {
    if (this.game_over) {
      let w = 41;
      let x = floor((WINCHS - (w + 2))/2);
      let y = 6;
      terminal.color(15, 1);
      terminal.cells({
        x,
        y,
        ws: [w],
        hs: [5],
      });
      x++;
      y++;
      terminal.fill({
        x, y, w, h: 5,
      });
      let text = 'GAME OVER';
      terminal.print({
        x: x + floor((w - text.length) /2),
        y: y + 1,
        text,
      });
      let sel = terminal.menu({
        color_sel: { fg: 14, bg: 1 },
        color_unsel: { fg: 7, bg: 1 },
        color_execute: { fg: 9, bg: 14 },
        x: x + 14,
        y: y + 3,
        key: 'game_over',
        items: [
          'TRY AGAIN',
          'VIEW SCORES',
        ],
      });
      if (sel !== -1) {
        playSound('button_click');
      }
      if (sel === 0) {
        newGameInit();
      } else if (sel === 1) {
        setState(stateScores);
      }
    }
  }
}
let game_state: GameState;
export function gameState(): GameState {
  return game_state;
}

export function setScore(): void {
  let score: Score = {
    score: round(game_state.total_score),
    l0: game_state.minigames[0].level,
    l1: game_state.minigames[1].level,
    l2: game_state.minigames[2].level,
    l3: game_state.minigames[3].level,
  };
  score_system.setScore(0, score);
}

let view_x = 0;
let view_board = { x: view_x, y: 1, w: MINIGAME_W * 4 + 5, h: MINIGAME_H + 4 };
let view_invaders = { x: view_x, y: 1, w: MINIGAME_W, h: MINIGAME_H };
view_x += MINIGAME_W + 1;
let view_breakout = { x: view_x, y: 1, w: MINIGAME_W, h: MINIGAME_H };
view_x += MINIGAME_W + 1;
let view_blocks = { x: view_x, y: 1, w: MINIGAME_W, h: MINIGAME_H };
view_x += MINIGAME_W + 1;
let view_kaboom = { x: view_x, y: 1, w: MINIGAME_W, h: MINIGAME_H };
view_x += MINIGAME_W + 1;
let views: [string, Box][] = [
  ['INVADERS', view_invaders],
  ['BREAKOUT', view_breakout],
  ['DR MAR', view_blocks],
  ['KABOOM', view_kaboom],
];
let need_clear = false;
let game_ready_cb_queued = false;
function statePlay(dt: number): void {
  tickMusic('game');
  if (need_clear) {
    need_clear = false;
    terminal.color(7,0);
    terminal.clear();
  }
  if (MODE_DEVELOPMENT && keyDown(KEYS.SHIFT)) {
    dt *= 4;
  }
  if (terminalSettingsVisible() || !game_ready) {
    dt = 0;
  }
  terminal.auto_scroll = false;
  terminal.color(11, 0);
  for (let ii = 0; ii < views.length; ++ii) {
    let rect = views[ii][1];
    if (game_state.active[ii]) {
      terminal.cells({
        x: rect.x, y: rect.y - 1, ws: [rect.w], hs: [rect.h], charset: 1,
        header: ` ${views[ii][0]} `,
      });
      if (ii > 0 && game_state.active[ii-1]) {
        terminal.print({
          x: rect.x,
          y: rect.y - 1,
          text: '╦',
        });
        terminal.print({
          x: rect.x,
          y: rect.y + MINIGAME_H,
          text: '╩',
        });
      }
    } else if (game_state.anims[ii]) {
      terminal.print({
        x: rect.x + 2,
        y: rect.y + MINIGAME_H,
        text: '════════════════',
      });
    }
  }

  if (MODE_DEVELOPMENT) {
    for (let ii = 0; ii < 4; ++ii) {
      if (keyDownEdge(KEYS['1'] + ii)) {
        if (keyDown(KEYS.SHIFT)) {
          game_state.minigames[ii].won();
        } else {
          game_state.minigames[ii].died();
        }
      }
    }
  }

  game_state.update(dt);

  terminal.subViewPush(view_board);
  game_state.render();
  terminal.subViewPop();
  game_state.checkGameOver();

  terminal.render();
  if (!game_ready_cb_queued) {
    game_ready_cb_queued = true;
    terminal.queueCb(function () {
      game_ready = true;
      terminal.baud = Infinity;
    });
  }

  if (actionEdge('cancel')) {
    menuInit();
  }
}

const SCORE_COLUMNS = [
  // widths are just proportional, scaled relative to `width` passed in
  { name: '', width: 4, align: ALIGN.HFIT | ALIGN.HRIGHT | ALIGN.VCENTER },
  { name: 'Name', width: 16, align: ALIGN.HFIT | ALIGN.VCENTER },
  { name: 'Score', width: 8 },
  { name: 'Invd', width: 4 },
  { name: 'Brkt', width: 4 },
  { name: 'Drma', width: 4 },
  { name: 'Kabo', width: 4 },
];

function myScoreToRow(row: unknown[], score: Score): void {
  row.push(`${score.score}`, `${score.l0}`, `${score.l1}`, `${score.l2}`, `${score.l3}`);
}


function stateScores(dt: number): void {
  tickMusic('menu');
  const style_title = fontStyle(null, {
    color: intColorFromVec4Color(terminal.palette[14]),
    outline_color: intColorFromVec4Color(terminal.palette[1]),
    outline_width: 2.5,
  });
  // titleMusic();
  const style_score = fontStyleColored(null, intColorFromVec4Color(terminal.palette[7]));
  const style_me = fontStyleColored(null, intColorFromVec4Color(terminal.palette[14]));
  const style_header = fontStyleColored(null, intColorFromVec4Color(terminal.palette[10]));

  drawRect(0, 0, game_width, game_height, 1, terminal.palette[1]);

  const CHW = 8;
  const CHH = 16;
  let x = CHW;
  let y = CHH;
  let font = uiGetFont();

  font.draw({
    style: style_title,
    x: 0,
    y,
    w: game_width,
    text: 'HIGH SCORES',
    size: CHH,
    align: ALIGN.HCENTER,
  });
  y += CHH + 2;

  let w = game_width - x * 2;
  let text_height = uiTextHeight();
  scoresDraw<Score>({
    score_system: scoreSystem(),
    allow_rename: true,
    x,
    width: w,
    y,
    height: game_height - y + 8,
    z: Z.UI,
    size: text_height,
    line_height: text_height,
    level_index: 0,
    columns: SCORE_COLUMNS,
    scoreToRow: myScoreToRow,
    style_score,
    style_me,
    style_header,
    color_line: terminal.palette[3],
    color_me_background: terminal.palette[0],
    rename_button_size: 6,
    rename_button_offset: 0/text_height,
  });

  if (buttonText({
    x: 4,
    y: 4,
    w: CHW * 6,
    text: 'Back',
    hotaction: 'cancel',
  })) {
    menuInit();
  }
}

const MENU_W = 23;
const MENU_X = floor((WINCHS - MENU_W) / 2) - 1;
const MENU_Y = 11;

let menu_ready = false;
function menu(dt: number): void {
  tickMusic('menu');
  if (!terminal.isAnimating()) {
    menu_ready = true;
  }
  let sel = !menu_ready ? -1 : terminal.menu({
    pre_sel: ' ■ ',
    pre_unsel: '   ',
    color_unsel: { fg: 0, bg: 3 },
    color_sel: { fg: 14, bg: 1 },
    color_execute: { fg: 8, bg: 0 },
    x: MENU_X,
    y: MENU_Y,
    items: [
      ...(game_state ? ['Continue          '] : []),
      'New Game          ',
      `${ansi.yellow.bright('[O]')}ptions         `,
      'High Scores       ',
    ],
  });
  if (sel !== -1) {
    playSound('button_click');
  }

  terminal.render();

  switch (sel) { // eslint-disable-line default-case
    case game_state ? 0 : -999:
      backToGame();
      break;
    case game_state ? 1 : 0:
      newGameInit();
      break;
    case game_state ? 2 : 1:
      terminalSettingsShow();
      break;
    case game_state ? 3 : 2:
      setState(stateScores);
      break;
  }

}

/* eslint @stylistic/max-len:off */
const TITLE = `[?7h[255D[0;1;34mÛÛÛÛÛÛ[30m»  [34mÛÛÛÛÛÛ[30m»[9C[36mÛÛÛÛÛÛ[30m»  [36mÛÛÛÛÛÛ[30m»  [36mÛÛÛÛÛÛÛ[30m»  [36mÛÛÛÛÛ[30m»  [36mÛÛ[30m»  [36mÛÛ[30m»
[34mÛÛ[30mÉÍÍ[34mÛÛ[30m» [34mÛÛ[30mÉÍÍ[34mÛÛ[30m»[8C[36mÛÛ[30mÉÍÍ[36mÛÛ[30m» [36mÛÛ[30mÉÍÍ[36mÛÛ[30m» [36mÛÛ[30mÉÍÍÍÍ¼ [36mÛÛ[30mÉÍÍ[36mÛÛ[30m» [36mÛÛ[30mº [36mÛÛ[30mÉ¼
[34mÛÛ[30mº  [34mÛÛ[30mº [34mÛÛÛÛÛÛ[30mÉ¼[8C[36mÛÛÛÛÛÛ[30mÉ¼ [36mÛÛÛÛÛÛ[30mÉ¼ [36mÛÛÛÛÛ[30m»   [36mÛÛÛÛÛÛÛ[30mº [36mÛÛÛÛÛ[30mÉ¼
[34mÛÛ[30mº  [34mÛÛ[30mº [34mÛÛ[30mÉÍÍ[34mÛÛ[30m»[8C[36mÛÛ[30mÉÍÍ[36mÛÛ[30m» [36mÛÛ[30mÉÍÍ[36mÛÛ[30m» [36mÛÛ[30mÉÍÍ¼   [36mÛÛ[30mÉÍÍ[36mÛÛ[30mº [36mÛÛ[30mÉÍ[36mÛÛ[30m»
[34mÛÛÛÛÛÛ[30mÉ¼ [34mÛÛ[30mº  [34mÛÛ[30mº[8C[36mÛÛÛÛÛÛ[30mÉ¼ [36mÛÛ[30mº  [36mÛÛ[30mº [36mÛÛÛÛÛÛÛ[30m» [36mÛÛ[30mº  [36mÛÛ[30mº [36mÛÛ[30mº  [36mÛÛ[30m»
ÈÍÍÍÍÍ¼  ÈÍ¼  ÈÍ¼[8CÈÍÍÍÍÍ¼  ÈÍ¼  ÈÍ¼ ÈÍÍÍÍÍÍ¼ ÈÍ¼  ÈÍ¼ ÈÍ¼  ÈÍ¼
[31mÛÛÛÛÛÛ[30m»   [31mÛÛÛÛÛÛÛ[30m»[30C[31mÛÛÛÛÛÛÛ[30m»  [31mÛÛÛ[30m»   [31mÛÛÛ[30m»
[31mÛÛ[30mÉÍÍ[31mÛÛ[30m» [31mÛÛ[30mÉÍÍÍÍ[31mÛÛ[30m»[28C[31mÛÛ[30mÉÍÍÍÍ[31mÛÛ[30m» [31mÛÛÛÛ[30m» [31mÛÛÛÛ[30mº
[31mÛÛÛÛÛÛ[30mÉ¼ [31mÛÛ[30mº    [31mÛÛ[30mº[28C[31mÛÛ[30mº    [31mÛÛ[30mº [31mÛÛ[30mÉ[31mÛÛÛÛ[30mÉ[31mÛÛ[30mº
[31mÛÛ[30mÉÍÍ[31mÛÛ[30m» [31mÛÛ[30mº    [31mÛÛ[30mº[28C[31mÛÛ[30mº    [31mÛÛ[30mº [31mÛÛ[30mºÈ[31mÛÛ[30mÉ¼[31mÛÛ[30mº
[31mÛÛÛÛÛÛ[30mÉ¼ È[31mÛÛÛÛÛÛÛ[30mÉ¼[28CÈ[31mÛÛÛÛÛÛÛ[30mÉ¼ [31mÛÛ[30mº ÈÍ¼ [31mÛÛ[30mº
ÈÍÍÍÍÍ¼   ÈÍÍÍÍÍÍ¼[30CÈÍÍÍÍÍÍ¼  ÈÍ¼[5CÈÍ¼
[35mÛÛ[30m» [35mÛÛÛ[30m»   [35mÛÛ[30m» [35mÛÛ[30m»   [35mÛÛ[30m»  [35mÛÛÛÛÛ[30m»  [35mÛÛÛÛÛÛ[30m»  [35mÛÛÛÛÛÛÛ[30m» [35mÛÛÛÛÛÛ[30m»  [35mÛÛÛÛÛÛÛ[30m»
[35mÛÛ[30mº [35mÛÛÛÛ[30m»  [35mÛÛ[30mº [35mÛÛ[30mº   [35mÛÛ[30mº [35mÛÛ[30mÉÍÍ[35mÛÛ[30m» [35mÛÛ[30mÉÍÍ[35mÛÛ[30m» [35mÛÛ[30mÉÍÍÍÍ¼ [35mÛÛ[30mÉÍÍ[35mÛÛ[30m» [35mÛÛ[30mÉÍÍÍÍ¼
[35mÛÛ[30mº [35mÛÛ[30mÉ[35mÛÛ[30m» [35mÛÛ[30mº [35mÛÛ[30mº   [35mÛÛ[30mº [35mÛÛÛÛÛÛÛ[30mº [35mÛÛ[30mº  [35mÛÛ[30mº [35mÛÛÛÛÛ[30m»   [35mÛÛÛÛÛÛ[30mÉ¼ [35mÛÛÛÛÛÛÛ[30m»
[35mÛÛ[30mº [35mÛÛ[30mºÈ[35mÛÛ[30m»[35mÛÛ[30mº È[35mÛÛ[30m» [35mÛÛ[30mÉ¼ [35mÛÛ[30mÉÍÍ[35mÛÛ[30mº [35mÛÛ[30mº  [35mÛÛ[30mº [35mÛÛ[30mÉÍÍ¼   [35mÛÛ[30mÉÍÍ[35mÛÛ[30m» ÈÍÍÍÍ[35mÛÛ[30mº
[35mÛÛ[30mº [35mÛÛ[30mº È[35mÛÛÛÛ[30mº  È[35mÛÛÛÛ[30mÉ¼  [35mÛÛ[30mº  [35mÛÛ[30mº [35mÛÛÛÛÛÛ[30mÉ¼ [35mÛÛÛÛÛÛÛ[30m» [35mÛÛ[30mº  [35mÛÛ[30mº [35mÛÛÛÛÛÛÛ[30mº
ÈÍ¼ ÈÍ¼  ÈÍÍÍ¼   ÈÍÍÍ¼   ÈÍ¼  ÈÍ¼ ÈÍÍÍÍÍ¼  ÈÍÍÍÍÍÍ¼ ÈÍ¼  ÈÍ¼ ÈÍÍÍÍÍÍ¼
`.split('').map(function (ch) {
  let idx = ch.charCodeAt(0);
  if (ansi_to_unicode_a[idx]) {
    return String.fromCharCode(ansi_to_unicode_a[idx]);
  } else {
    return ch;
  }
}).join('').replace(/\n/g, '\r\n');
function menuInit(): void {
  terminal.baud = 14400;
  terminal.draw_cursor = null; // [1, 4];
  terminal.color(7,0);
  terminal.clear();
  terminalSettingsInit(terminal);

  terminal.subViewPush({
    x: 4,
    y: 4,
    w: WINCHS - 3 * 2,
    h: HINCHS,
  });
  terminal.print({
    x: 0,
    y: 0,
    text: TITLE,
  });
  terminal.subViewPop();
  terminal.normal();

  if (game_state) {
    terminal.finishAnimating();
  }

  let line = '  By Jimb Esser for Ludum Dare 60  ';
  terminal.print({
    x: floor((WINCHS - line.length) / 2),
    y: HINCHS - 3,
    text: line,
    fg: 0,
    bg: 8,
  });

  terminal.color(11, 3);
  terminal.cells({
    x: MENU_X - 2, y: MENU_Y - 1, ws: [MENU_W], hs: [game_state ? 4 : 3], charset: 2,
    header: ' MAIN MENU ',
  });
  terminal.fill({
    bg: 3,
    x: MENU_X - 1,
    y: MENU_Y,
    w: MENU_W,
    h: game_state ? 4 : 3,
  });

  setState(menu);
}

function statePlayInit(): void {
  terminal.baud = MODE_DEVELOPMENT ? Infinity : 14400;
  terminal.draw_cursor = false;
  need_clear = true;
  game_ready = false;
  game_ready_cb_queued = false;
  setState(statePlay);
}

export function backToGame(): void {
  statePlayInit();
}

export function newGameInit(): void {
  game_state = new GameState();
  statePlayInit();
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
    ui_sprites: {
      ...spriteSetGet('pixely'),
    },
  })) {
    return;
  }
  loadUISprite2('scrollbar_trough', {
    name: 'scrollbar_trough',
    wrap_t: 1,
    ws: [8],
    hs: [16],
  });
  // loadUISprite2('scrollbar_handle', {
  //   name: 'scrollbar_handle',
  //   wrap_t: 1,
  //   ws: [8],
  //   hs: [16],
  // });
  // font = uiGetFont();

  // Perfect sizes for pixely modes
  scaleSizes(13 / 32);
  setFontHeight(16);

  init();

  menuInit();

  if (MODE_DEVELOPMENT) {
    if (debugDefineIsSet('HISCORE')) {
      setState(stateScores);
    }
    if (debugDefineIsSet('OPTS')) {
      // optionsMenu('title');
    }
    newGameInit();
  }
}
