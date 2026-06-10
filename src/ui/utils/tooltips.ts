const STORAGE_KEY = 'knowledge-dungeon:ui:tooltips:v1';

function getSeenSet(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function persistSeen(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // localStorage may be full or unavailable
  }
}

export function hasSeenTooltip(id: string): boolean {
  return getSeenSet().has(id);
}

export function markTooltipSeen(id: string): void {
  const seen = getSeenSet();
  seen.add(id);
  persistSeen(seen);
}

export function resetAllTooltips(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
