import { useState, useCallback, useEffect, type JSX } from 'react';
import type { ManifestSprite } from '@/services/spriteManifest';
import {
  getCustomSpriteContent,
  saveCustomSpriteContent,
  resetCustomSpriteContent,
  resetAllCustomSprites,
} from '@/services/customSprites';
import { SpriteBrowser } from '@/ui/components/SpriteBrowser';
import { SpriteEditor } from '@/ui/components/SpriteEditor';
import { CollectionSwitcher } from '@/ui/components/CollectionSwitcher';
import { useSessionStore } from '@/store/sessionStore';
import { useTranslation } from 'react-i18next';

const BASE = import.meta.env.BASE_URL;

const BACKUP_PREFIX = 'knowledge-dungeon:custom-sprites:originals:';

function backupOriginal(spritePath: string, svgContent: string): void {
  try {
    const key = `${BACKUP_PREFIX}${spritePath}`;
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, svgContent);
    }
  } catch {
    // quota exceeded — non-fatal
  }
}

export function MakeItYoursTab(): JSX.Element {
  const { t } = useTranslation();
  const requestSceneRestart = useSessionStore((s) => s.requestSceneRestart);

  const [selectedSprite, setSelectedSprite] = useState<ManifestSprite | null>(null);
  const [originalCache, setOriginalCache] = useState<Record<string, string>>({});
  const [dirtySvg, setDirtySvg] = useState<string>('');
  const [isDirty, setIsDirty] = useState(false);
  const [modifiedPaths, setModifiedPaths] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [packVersion, setPackVersion] = useState(0);

  const refreshModifiedPaths = useCallback(() => {
    const paths: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('knowledge-dungeon:custom-sprites:override:')) {
        paths.push(key.replace('knowledge-dungeon:custom-sprites:override:', ''));
      }
    }
    setModifiedPaths(new Set(paths));
  }, []);

  useEffect(() => {
    refreshModifiedPaths();
  }, [refreshModifiedPaths, packVersion]);

  const loadSpriteContent = useCallback(async (sprite: ManifestSprite) => {
    setLoadError(null);
    setDirtySvg('');
    setIsDirty(false);

    const custom = getCustomSpriteContent(sprite.path);
    if (custom) {
      setDirtySvg(custom);
      return;
    }

    if (!originalCache[sprite.path]) {
      try {
        const response = await fetch(`${BASE}assets/${sprite.path}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const svg = await response.text();
        setOriginalCache((prev) => ({ ...prev, [sprite.path]: svg }));
      } catch {
        setLoadError(t('makeItYours.loadError', 'Failed to load sprite'));
      }
    }
  }, [originalCache, t]);

  const handleSelect = useCallback((sprite: ManifestSprite) => {
    setSelectedSprite(sprite);
    void loadSpriteContent(sprite);
  }, [loadSpriteContent]);

  const handleEditorChange = useCallback((svgContent: string) => {
    setDirtySvg(svgContent);
    setIsDirty(true);
    setSaveError(null);
  }, []);

  const validateSvg = useCallback((svg: string): string | null => {
    const trimmed = svg.trim();
    if (!trimmed) return t('makeItYours.errorEmpty', 'SVG content is empty.');
    if (!trimmed.startsWith('<svg') && !trimmed.startsWith('<?xml')) {
      return t('makeItYours.errorNotSvg', 'Content must start with <svg or <?xml.');
    }
    if (!trimmed.includes('</svg>')) {
      return t('makeItYours.errorNoClose', 'Missing </svg> closing tag.');
    }
    // Check for 8-digit hex colors which Phaser may reject
    if (/#[0-9a-fA-F]{8}\b/.test(trimmed)) {
      return t('makeItYours.error8digitHex',
        '8-digit hex color found (e.g. #00000022). Use rgba() or fill-opacity instead.');
    }
    // Parse as XML
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(trimmed, 'image/svg+xml');
      const errNode = doc.querySelector('parsererror');
      if (errNode) {
        const msg = errNode.textContent?.split('\n')[0]?.trim() || 'XML parse error';
        return t('makeItYours.errorXmlParse', 'XML parse error: {{msg}}', { msg });
      }
    } catch {
      return t('makeItYours.errorXmlException', 'Failed to parse SVG as XML.');
    }
    return null;
  }, [t]);

  const handleSave = useCallback(() => {
    if (!selectedSprite || !dirtySvg) return;

    const error = validateSvg(dirtySvg);
    if (error) {
      setSaveError(error);
      return;
    }
    setSaveError(null);

    // Backup original before first override
    const originalFromCache = originalCache[selectedSprite.path];
    if (originalFromCache && !getCustomSpriteContent(selectedSprite.path)) {
      backupOriginal(selectedSprite.path, originalFromCache);
    }

    saveCustomSpriteContent(selectedSprite.path, dirtySvg);
    setIsDirty(false);
    refreshModifiedPaths();
  }, [selectedSprite, dirtySvg, originalCache, refreshModifiedPaths, validateSvg]);

  const handleReset = useCallback(() => {
    if (!selectedSprite) return;
    resetCustomSpriteContent(selectedSprite.path);
    setDirtySvg(originalCache[selectedSprite.path] || '');
    setIsDirty(false);
    refreshModifiedPaths();
  }, [selectedSprite, originalCache, refreshModifiedPaths]);

  const handleResetAll = useCallback(() => {
    resetAllCustomSprites();
    setDirtySvg('');
    setIsDirty(false);
    refreshModifiedPaths();
  }, [refreshModifiedPaths]);

  const handleApplyChanges = useCallback(() => {
    requestSceneRestart();
  }, [requestSceneRestart]);

  const handlePackChanged = useCallback(() => {
    setPackVersion((v) => v + 1);
    // Reload current sprite content if one is selected
    if (selectedSprite) {
      const custom = getCustomSpriteContent(selectedSprite.path);
      if (custom) {
        setDirtySvg(custom);
        setIsDirty(false);
      } else {
        setDirtySvg(originalCache[selectedSprite.path] || '');
        setIsDirty(false);
      }
    }
  }, [selectedSprite, originalCache]);

  const selectedPath = selectedSprite?.path ?? null;
  const initialSvg = selectedSprite ? (getCustomSpriteContent(selectedSprite.path) ?? null) : null;
  const originalSvg = selectedSprite ? (originalCache[selectedSprite.path] ?? null) : null;

  return (
    <div role="tabpanel" aria-label={t('makeItYours.title', 'Make It Yours')}>
      <p className="room-help-text">
        {t('makeItYours.description', 'Customize game sprites by editing their SVG content. Changes take effect after clicking "Apply Changes".')}
      </p>

      <CollectionSwitcher
        modifiedCount={modifiedPaths.size}
        onPackChanged={handlePackChanged}
      />

      {loadError && (
        <div className="sprite-editor-error">{loadError}</div>
      )}
      {saveError && (
        <div className="sprite-editor-error sprite-editor-error--save">{saveError}</div>
      )}

      <div className="make-it-yours-layout">
        <div className="make-it-yours-browser">
          <SpriteBrowser
            selectedPath={selectedPath}
            onSelect={handleSelect}
          />
        </div>
        <div className="make-it-yours-editor">
          <SpriteEditor
            spritePath={selectedPath}
            originalSvg={originalSvg}
            initialSvg={initialSvg}
            onChange={handleEditorChange}
            onSave={handleSave}
            onReset={handleReset}
            onAnimationChange={() => setIsDirty(true)}
            isDirty={isDirty}
            isModified={selectedPath !== null && modifiedPaths.has(selectedPath)}
            width={selectedSprite?.width ?? 64}
            height={selectedSprite?.height ?? 64}
          />
        </div>
      </div>

      <div className="make-it-yours-footer">
        <div className="make-it-yours-stats">
          {t('makeItYours.modifiedCount', `${modifiedPaths.size} sprites customized`)}
        </div>
        <div className="make-it-yours-footer-actions">
          <button
            type="button"
            className="game-btn-primary"
            onClick={handleApplyChanges}
            aria-label={t('makeItYours.applyChanges', 'Apply Changes')}
          >
            {t('makeItYours.applyChanges', 'Apply Changes')}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={handleResetAll}
            disabled={modifiedPaths.size === 0}
            aria-label={t('makeItYours.resetAll', 'Reset All')}
          >
            {t('makeItYours.resetAll', 'Reset All')}
          </button>
        </div>
      </div>
    </div>
  );
}
