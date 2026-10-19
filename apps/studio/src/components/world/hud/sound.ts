/**
 * The HUD's UI sounds (contract §4b): one call site for the SOUND module, so
 * every control uses the same names (hover, select, open, close, menu,
 * confirm, error, toggle). Sound starts after the first gesture; until then,
 * with sound off and without Web Audio these are no-ops.
 */
import { getAudio, type UiSound } from '../../../audio';

export type { UiSound } from '../../../audio';

export function uiSound(name: UiSound): void {
  getAudio().ui(name);
}
