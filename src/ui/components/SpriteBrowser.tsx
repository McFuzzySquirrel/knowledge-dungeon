import { useEffect, useState, type JSX } from 'react';
import { fetchSpriteManifest, groupByCategory, type CategoryGroup, type ManifestSprite } from '@/services/spriteManifest';
import { listCustomSpritePaths } from '@/services/customSprites';
import { useTranslation } from 'react-i18next';

const BASE = import.meta.env.BASE_URL;

interface SpriteBrowserProps {
  selectedPath: string | null;
  onSelect: (sprite: ManifestSprite) => void;
}

export function SpriteBrowser({ selectedPath, onSelect }: SpriteBrowserProps): JSX.Element {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<CategoryGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customPaths, setCustomPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetchSpriteManifest()
      .then((manifest) => {
        if (cancelled) return;
        setCategories(groupByCategory(manifest));
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setCustomPaths(new Set(listCustomSpritePaths()));
  }, []);

  if (loading) {
    return <div className="sprite-browser-loading">{t('makeItYours.loading', 'Loading sprites...')}</div>;
  }

  if (error) {
    return <div className="sprite-browser-error">{t('makeItYours.error', 'Failed to load sprites')}</div>;
  }

  if (categories.length === 0) {
    return <div className="sprite-browser-empty">{t('makeItYours.empty', 'No sprites available')}</div>;
  }

  return (
    <div className="sprite-browser" role="listbox" aria-label={t('makeItYours.title', 'Sprite Browser')}>
      {categories.map((group) => (
        <div key={group.category} className="sprite-category">
          <div className="sprite-category-header">{group.category} ({group.sprites.length})</div>
          <div className="sprite-list">
            {group.sprites.map((sprite) => {
              const isSelected = selectedPath === sprite.path;
              const isModified = customPaths.has(sprite.path);

              return (
                <button
                  key={sprite.path}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`sprite-item${isSelected ? ' active' : ''}`}
                  onClick={() => onSelect(sprite)}
                >
                  <span className="sprite-thumb">
                    <img
                      src={`${BASE}assets/${sprite.path}`}
                      alt={sprite.name}
                      width={sprite.width}
                      height={sprite.height}
                      style={{ maxWidth: 40, maxHeight: 40 }}
                    />
                  </span>
                  <span className="sprite-name">{sprite.name}</span>
                  {isModified && (
                    <span className="sprite-modified-badge" title={t('makeItYours.modified', 'Customized')}>
                      *
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
