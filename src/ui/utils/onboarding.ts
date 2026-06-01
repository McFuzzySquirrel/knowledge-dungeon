const GAMEPLAY_LOOP_ONBOARDING_KEY = 'knowledge-dungeon:ui:onboarding:gameplay-loop:v1';

function hasWindowStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function hasSeenGameplayLoopOnboarding(): boolean {
  if (!hasWindowStorage()) return false;
  try {
    return window.localStorage.getItem(GAMEPLAY_LOOP_ONBOARDING_KEY) === 'seen';
  } catch {
    return false;
  }
}

export function markGameplayLoopOnboardingSeen(): void {
  if (!hasWindowStorage()) return;
  try {
    window.localStorage.setItem(GAMEPLAY_LOOP_ONBOARDING_KEY, 'seen');
  } catch {
    // Non-fatal in quota/privacy modes.
  }
}

export const __testing = {
  GAMEPLAY_LOOP_ONBOARDING_KEY,
};
