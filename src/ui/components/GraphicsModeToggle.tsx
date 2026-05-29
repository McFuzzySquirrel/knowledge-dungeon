import { useId, type JSX } from 'react';
import { usePreferencesStore, type GraphicsMode } from '@/store/preferencesStore';

interface GraphicsModeToggleProps {
  /** Visual label shown above the toggle. Defaults to "Graphics". */
  label?: string;
  /** When true, render in a compact one-line layout suitable for toolbars. */
  compact?: boolean;
}

const OPTIONS: { id: GraphicsMode; label: string; description: string }[] = [
  {
    id: 'mindmap',
    label: 'Mind map',
    description: 'Graph-style nodes and edges',
  },
  {
    id: 'rpg',
    label: 'RPG',
    description: 'Dungeon chambers with doors',
  },
];

/**
 * Segmented control that switches between the mind-map look and the RPG
 * dungeon style. Implemented as a real `radiogroup` so it works with
 * keyboard navigation and screen readers without any custom widget code.
 */
export function GraphicsModeToggle({
  label = 'Graphics',
  compact = false,
}: GraphicsModeToggleProps): JSX.Element {
  const mode = usePreferencesStore((s) => s.graphicsMode);
  const setMode = usePreferencesStore((s) => s.setGraphicsMode);
  const labelId = useId();

  return (
    <div
      className={`graphics-mode-toggle${compact ? ' graphics-mode-toggle--compact' : ''}`}
    >
      <span id={labelId} className="graphics-mode-toggle__label">
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={labelId}>
        {OPTIONS.map((option) => {
          const isSelected = option.id === mode;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              title={option.description}
              className={`graphics-mode-toggle__option${
                isSelected ? ' graphics-mode-toggle__option--selected' : ''
              }`}
              onClick={() => setMode(option.id)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
