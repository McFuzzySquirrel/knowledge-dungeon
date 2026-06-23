import { useState, useEffect, useCallback, useRef, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getAnimationConfig,
  saveAnimationConfig,
} from '@/services/customSprites';

export type AnimationPreset = 'none' | 'pulse' | 'spin' | 'float' | 'bounce' | 'flicker' | 'wobble' | 'swing' | 'drift' | 'shimmer' | 'breathe' | 'blink';

export interface SpriteAnimationConfig {
  type: AnimationPreset;
  speed?: number;
}

const ANIMATION_LABELS: Record<AnimationPreset, string> = {
  none: 'No animation',
  pulse: 'Pulse (scale)',
  spin: 'Spin (rotate)',
  float: 'Float (bob)',
  bounce: 'Bounce',
  flicker: 'Flicker (alpha)',
  wobble: 'Wobble (tilt)',
  swing: 'Swing (pendulum)',
  drift: 'Drift (sway)',
  shimmer: 'Shimmer (stretch)',
  breathe: 'Breathe (idle)',
  blink: 'Blink (flash)',
};

function sanitizeSvg(svgContent: string): string {
  return svgContent.replace(/<script[\s\S]*?<\/script>/gi, '');
}

/** Extract viewBox dimensions from an SVG string, or return defaults. */
function parseViewBox(svgContent: string): { w: number; h: number } | null {
  const m = svgContent.match(/viewBox\s*=\s*"(\d+)\s+(\d+)\s+(\d+)\s+(\d+)"/i);
  if (m) return { w: parseInt(m[3], 10), h: parseInt(m[4], 10) };
  const wm = svgContent.match(/<svg[^>]*\swidth\s*=\s*"(\d+)"/i);
  const hm = svgContent.match(/<svg[^>]*\sheight\s*=\s*"(\d+)"/i);
  if (wm && hm) return { w: parseInt(wm[1], 10), h: parseInt(hm[1], 10) };
  return null;
}

const ANIM_BASE_DURATION: Record<AnimationPreset, number> = {
  none: 0, pulse: 1.5, spin: 6, float: 1.5, bounce: 0.4,
  flicker: 0.6, wobble: 0.8, swing: 2, drift: 2, shimmer: 1, breathe: 3, blink: 3,
};

interface SpriteEditorProps {
  spritePath: string | null;
  originalSvg: string | null;
  initialSvg: string | null;
  onChange: (svgContent: string) => void;
  onSave: () => void;
  onReset: () => void;
  onAnimationChange?: () => void;
  isDirty: boolean;
  isModified: boolean;
  width: number;
  height: number;
}

export function SpriteEditor({
  spritePath,
  originalSvg,
  initialSvg,
  onChange,
  onSave,
  onReset,
  onAnimationChange,
  isDirty,
  isModified,
  width,
  height,
}: SpriteEditorProps): JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [sanitizedSvg, setSanitizedSvg] = useState('');
  const [animType, setAnimType] = useState<AnimationPreset>('none');
  const [animSpeed, setAnimSpeed] = useState(1);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (spritePath && initialSvg) {
      setText(initialSvg);
    } else if (spritePath && originalSvg) {
      setText(originalSvg);
    } else {
      setText('');
    }
  }, [spritePath, originalSvg, initialSvg]);

  useEffect(() => {
    if (spritePath) {
      const cfg = getAnimationConfig(spritePath);
      setAnimType(cfg.type);
      setAnimSpeed(cfg.speed ?? 1);
    } else {
      setAnimType('none');
      setAnimSpeed(1);
    }
  }, [spritePath]);

  useEffect(() => {
    if (text) {
      setSanitizedSvg(sanitizeSvg(text));
    } else {
      setSanitizedSvg('');
    }
  }, [text]);

  const handleChange = useCallback(
    (value: string) => {
      setText(value);
      onChange(value);
    },
    [onChange],
  );

  const handleAnimChange = useCallback(
    (type: AnimationPreset, speed?: number) => {
      setAnimType(type);
      const s = speed ?? animSpeed;
      if (s !== animSpeed) setAnimSpeed(s);
      if (spritePath) {
        saveAnimationConfig(spritePath, { type, speed: s });
      }
      onAnimationChange?.();
    },
    [spritePath, animSpeed, onAnimationChange],
  );

  if (!spritePath) {
    return (
      <div className="sprite-editor-empty">
        {t('makeItYours.selectSprite', 'Select a sprite from the list to start editing')}
      </div>
    );
  }

  const viewBox = parseViewBox(sanitizedSvg) ?? { w: width, h: height };
  const previewScale = Math.min(1, Math.min(200 / viewBox.w, 200 / viewBox.h));

  return (
    <div className="sprite-editor">
      <div className="sprite-editor-header">
        <span className="sprite-editor-name">{spritePath}</span>
        <span className="sprite-editor-dims">
          {width} × {height}
          {isModified && (
            <span className="sprite-modified-badge" title={t('makeItYours.modified', 'Customized')}>
              * {t('makeItYours.modified', 'Customized')}
            </span>
          )}
          {isDirty && (
            <span className="sprite-dirty-badge">
              {t('makeItYours.unsaved', 'Unsaved')}
            </span>
          )}
        </span>
      </div>

      <div className="sprite-editor-body">
        {/* Inline SVG preview — CSS animations execute here */}
        <div
          className="sprite-editor-preview"
          ref={previewRef}
        >
          {sanitizedSvg ? (
            <div
              className={`sprite-editor-preview-inner${animType !== 'none' ? ` anim-${animType}` : ''}`}
              dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
              style={{
                width: viewBox.w * previewScale,
                height: viewBox.h * previewScale,
                overflow: 'hidden',
                animationDuration: animType !== 'none' && animSpeed
                  ? `${ANIM_BASE_DURATION[animType] / animSpeed}s`
                  : undefined,
              }}
            />
          ) : (
            <div className="sprite-editor-preview-placeholder">SVG</div>
          )}
        </div>

        <textarea
          className="sprite-editor-textarea game-input"
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          spellCheck={false}
          aria-label={t('makeItYours.editorLabel', 'SVG Editor')}
          rows={12}
        />
      </div>

      {/* Animation preset selector */}
      <div className="sprite-editor-anim">
        <label className="sprite-editor-anim-label">
          {t('makeItYours.animation', 'Animation')}
        </label>
        <select
          className="game-input"
          value={animType}
          onChange={(e) => handleAnimChange(e.target.value as AnimationPreset)}
          aria-label={t('makeItYours.animation', 'Animation')}
        >
          {(Object.keys(ANIMATION_LABELS) as AnimationPreset[]).map((key) => (
            <option key={key} value={key}>{ANIMATION_LABELS[key]}</option>
          ))}
        </select>
        {animType !== 'none' && (
          <div className="sprite-editor-speed">
            <label className="sprite-editor-speed-label">
              {t('makeItYours.speed', 'Speed')}
            </label>
            <input
              type="range"
              className="sprite-editor-speed-slider"
              min={0.1}
              max={3}
              step={0.1}
              value={animSpeed}
              onChange={(e) => {
                const s = Number(e.target.value);
                setAnimSpeed(s);
                if (spritePath) saveAnimationConfig(spritePath, { type: animType, speed: s });
                onAnimationChange?.();
              }}
            />
            <span className="sprite-editor-speed-value">{animSpeed}x</span>
          </div>
        )}
        <span className="sprite-editor-anim-note">
          {t('makeItYours.animationNote', 'Animation shown in preview. Pick a preset to see it in action.')}
        </span>
      </div>

      <div className="sprite-editor-actions">
        <button
          type="button"
          className="game-btn-primary"
          onClick={onSave}
          disabled={!isDirty}
          aria-label={t('makeItYours.save', 'Save')}
        >
          {t('makeItYours.save', 'Save')}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={onReset}
          aria-label={t('makeItYours.reset', 'Reset to original')}
        >
          {t('makeItYours.reset', 'Reset')}
        </button>
      </div>
    </div>
  );
}
