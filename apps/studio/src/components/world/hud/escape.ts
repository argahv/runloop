/**
 * The Esc cascade on the town (immersive contract §2.2): the menu, then lot
 * picking, an open sheet (after its own Esc), the interior, a follow, the card
 * stack, the Agents district card, and finally the Esc menu itself. Pure.
 */
import type { WorldUiState } from '../../../world/store';

export type EscAction = 'closeMenu' | 'unpickLot' | 'cancelLotPick' | 'closeOverlay' | 'leaveInterior' | 'stopFollow' | 'popCard' | 'closeDistrict' | 'openMenu';

export function escapeAction(s: Pick<WorldUiState, 'menu' | 'lotPick' | 'overlay' | 'entered' | 'follow' | 'panelStack' | 'mode'>): EscAction {
  if (s.menu) return 'closeMenu';
  if (s.lotPick?.selected) return 'unpickLot';
  if (s.lotPick || s.overlay === 'add') return 'cancelLotPick';
  if (s.overlay !== 'none') return 'closeOverlay';
  if (s.entered) return 'leaveInterior';
  if (s.follow) return 'stopFollow';
  if (s.panelStack.length) return 'popCard';
  if (s.mode === 'agents') return 'closeDistrict';
  return 'openMenu';
}

/** Apply one Esc step to the store. */
export function runEscape(s: WorldUiState): EscAction {
  const a = escapeAction(s);
  switch (a) {
    case 'closeMenu':
      s.setMenu(null);
      break;
    case 'unpickLot':
      s.pickLot(null);
      break;
    case 'cancelLotPick':
      s.cancelLotPick();
      break;
    case 'closeOverlay':
      s.setOverlay('none');
      break;
    case 'leaveInterior':
      s.enter(null);
      break;
    case 'stopFollow':
      s.setFollow(null);
      break;
    case 'popCard':
      if (s.panelStack.length > 1) s.back();
      else s.closePanels();
      break;
    case 'closeDistrict':
      s.setMode('explore', { camera: false });
      break;
    case 'openMenu':
      s.setMenu('resume');
      break;
  }
  return a;
}
