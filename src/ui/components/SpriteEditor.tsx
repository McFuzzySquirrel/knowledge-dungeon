import { useState, useEffect, useCallback, useRef, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { SvgEditWysiwyg } from '@/ui/components/SvgEditWysiwyg';

export type AnimationPreset = 'none' | 'pulse' | 'spin' | 'float' | 'bounce';

export interface SpriteAnimationConfig {
  type: AnimationPreset;
}

const ANIM_STORAGE_PREFIX = 'knowledge-dungeon:custom-sprites:anim:';

export function getAnimationConfig(spritePath: string): SpriteAnimationConfig {
  try {
    const raw = localStorage.getItem(`${ANIM_STORAGE_PREFIX}${spritePath}`);
    if (raw) return JSON.parse(raw) as SpriteAnimationConfig;
  } catch { /* ignore */ }
  return { type: 'none' };
}

export function saveAnimationConfig(spritePath: string, config: SpriteAnimationConfig): void {
  try {
    localStorage.setItem(`${ANIM_STORAGE_PREFIX}${spritePath}`, JSON.stringify(config));
  } catch { /* ignore */ }
}

const ANIMATION_LABELS: Record<AnimationPreset, string> = {
  none: 'No animation',
  pulse: 'Pulse (scale)',
  spin: 'Spin (rotate)',
  float: 'Float (bob)',
  bounce: 'Bounce',
};

type ViewMode = 'code' | 'wysiwyg';

function sanitizeSvg(svgContent: string): string {
  return svgContent.replace(/<script[\s\S]*?<\/script>/gi, '');
}

function parseViewBox(svgContent: string): { w: number; h: number } | null {
  const m = svgContent.match(/viewBox\s*=\s*"(\d+)\s+(\d+)\s+(\d+)\s+(\d+)"/i);
  if (m) return { w: parseInt(m[3], 10), h: parseInt(m[4], 10) };
  const wm = svgContent.match(/<svg[^>]*\swidth\s*=\s*"(\d+)"/i);
  const hm = svgContent.match(/<svg[^>]*\sheight\s*=\s*"(\d+)"/i);
  if (wm && hm) return { w: parseInt(wm[1], 10), h: parseInt(hm[1], 10) };
  return null;
}

interface SpriteEditorProps {
  spritePath: string | null;
  originalSvg: string | null;
  initialSvg: string | null;
  onChange: (svgContent: string) => void;
  onSave: () => void;
  onReset: () => void;
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
  isDirty,
  isModified,
  width,
  height,
}: SpriteEditorProps): JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [sanitizedSvg, setSanitizedSvg] = useState('');
  const [animType, setAnimType] = useState<AnimationPreset>('none');
  const [viewMode, setViewMode] = useState<ViewMode>('code');
  const wysiwygSvgRef = useRef<string>('');
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
      setAnimType(getAnimationConfig(spritePath).type);
    } else {
      setAnimType('none');
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
      wysiwygSvgRef.current = value;
      onChange(value);
    },
    [onChange],
  );

  const handleWysiwygChange = useCallback(
    (svgContent: string) => {
      wysiwygSvgRef.current = svgContent;
      onChange(svgContent);
    },
    [onChange],
  );

  const handleAnimChange = useCallback(
    (type: AnimationPreset) => {
      setAnimType(type);
      if (spritePath) {
        saveAnimationConfig(spritePath, { type });
      }
    },
    [spritePath],
  );

  const switchToCode = useCallback(() => {
    const latest = wysiwygSvgRef.current || text;
    setText(latest);
    setSanitizedSvg(sanitizeSvg(latest));
    setViewMode('code');
  }, [text]);

  const switchToWysiwyg = useCallback(() => {
    setViewMode('wysiwyg');
  }, []);

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

      {/* Editor mode toggle */}
      <div className="sprite-editor-mode-toggle">
        <button
          type="button"
          className={`sprite-mode-btn${viewMode === 'code' ? ' active' : ''}`}
          onClick={switchToCode}
          aria-pressed={viewMode === 'code'}
        >
          {t('makeItYours.codeEditor', 'Code')}
        </button>
        <button
          type="button"
          className={`sprite-mode-btn${viewMode === 'wysiwyg' ? ' active' : ''}`}
          onClick={switchToWysiwyg}
          aria-pressed={viewMode === 'wysiwyg'}
        >
          {t('makeItYours.wysiwygEditor', 'Draw')}
        </button>
      </div>

      {viewMode === 'code' ? (
        <div className="sprite-editor-body">
          <div className="sprite-editor-preview" ref={previewRef}>
            {sanitizedSvg ? (
              <div
                dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
                style={{
                  width: viewBox.w * previewScale,
                  height: viewBox.h * previewScale,
                  overflow: 'hidden',
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
      ) : (
        <div className="sprite-editor-wysiwyg">
          <SvgEditWysiwyg
            initialSvg={text}
            onChange={handleWysiwygChange}
            editorWidth={Math.max(400, Math.min(800, window.innerWidth - 320))}
            editorHeight={Math.max(350, Math.min(550, window.innerHeight * 0.5))}
          />
        </div>
      )}

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
        <span className="sprite-editor-anim-note">
          {t('makeItYours.animationNote', 'CSS animations work in the preview. In-game animations use Phaser tweens (coming soon).')}
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
