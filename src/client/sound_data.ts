import { GlovSoundPlayOpts } from 'glov/client/sound';
import { playUISound, UISoundID } from 'glov/client/ui';

export const SOUND_DATA = {
  // online multiplayer sounds, ignore these
  user_join: 'user_join',
  user_leave: 'user_leave',
  msg_in: 'msg_in',
  msg_err: 'msg_err',
  msg_out_err: 'msg_out_err',
  msg_out: 'msg_out',

  // UI sounds
  button_click: { file: 'note-a', volume: 0.5 },
  // menus/general/etc
  rollover: { file: 'note-c', volume: 0.25 },

  // game_event: 'game_event',
  breakout1: { file: 'breakout1', volume: 1 },
  breakout2: { file: 'breakout2', volume: 1 },
  breakout3: { file: 'breakout3', volume: 1 },
  breakout4: { file: 'breakout4', volume: 1 },
  breakout5: { file: 'breakout5', volume: 1 },
  breakout6: { file: 'breakout6', volume: 1 },
  breakout7: { file: 'breakout7', volume: 1 },
  breakout8: { file: 'breakout8', volume: 1 },
  breakbounce1: { file: 'break-bounce1', volume: 1 },
  breakbounce2: { file: 'break-bounce2', volume: 1 },
  paddle1: { file: 'paddle1', volume: 1 },
  paddle2: { file: 'paddle2', volume: 1 },
  paddle3: { file: 'paddle3', volume: 1 },
  'die-breakout': { file: 'die-breakout', volume: 1 },
  'die-blocks': { file: 'die-blocks', volume: 1 },
  'die-kaboom': { file: 'die-kaboom', volume: 1 },
  'die-invaders': { file: 'die-invaders', volume: 1 },

  'blocks-place': { file: 'chord-ac', volume: 0.7 },
  'blocks-clear': { file: 'chord-ce', volume: 1 },

  'kaboom-catch1': { file: 'kaboom-catch1', volume: 1 },
  'kaboom-catch2': { file: 'kaboom-catch2', volume: 1 },
  'kaboom-break': { file: 'kaboom-break', volume: 0.25 },

  'invaders-break1': { file: 'invaders-break1', volume: 0.7 },
  'invaders-break2': { file: 'invaders-break2', volume: 0.7 },
  'invaders-break3': { file: 'invaders-break3', volume: 0.7 },
  // 'invaders-break4': { file: 'invaders-break4', volume: 0.7 },
  // 'invaders-break5': { file: 'invaders-break5', volume: 0.7 },

  'invaders-bulletbreak': { file: 'invaders-bulletbreak', volume: 0.5 },

  'won-breakout': { file: 'win-a', volume: 1 },
  'won-blocks': { file: 'win-b', volume: 1 },
  'won-invaders': { file: 'win-c', volume: 1 },
  'won-kaboom': { file: 'win-d', volume: 1 },
  'extralife': { file: 'extralife', volume: 1 },
} satisfies Partial<Record<string, UISoundID | string | string[] | UISoundID[]>>;

export type GameSoundID = keyof typeof SOUND_DATA;

export function validSoundID(test: string): test is GameSoundID {
  return Boolean((SOUND_DATA as Partial<Record<string, unknown>>)[test]);
}

export function playSound(sound_id: GameSoundID, volume_or_opts?: number | GlovSoundPlayOpts): void {
  playUISound(sound_id, volume_or_opts);
}
