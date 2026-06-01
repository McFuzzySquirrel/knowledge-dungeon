import { beforeEach, describe, expect, it } from 'vitest';
import {
  __testing,
  hasSeenGameplayLoopOnboarding,
  markGameplayLoopOnboardingSeen,
} from '@/ui/utils/onboarding';

describe('gameplay onboarding persistence', () => {
  beforeEach(() => {
    window.localStorage.removeItem(__testing.GAMEPLAY_LOOP_ONBOARDING_KEY);
  });

  it('defaults to unseen onboarding', () => {
    expect(hasSeenGameplayLoopOnboarding()).toBe(false);
  });

  it('marks onboarding as seen', () => {
    markGameplayLoopOnboardingSeen();
    expect(hasSeenGameplayLoopOnboarding()).toBe(true);
  });
});
