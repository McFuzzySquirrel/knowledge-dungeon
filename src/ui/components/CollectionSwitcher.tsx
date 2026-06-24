import { useState, useCallback, useRef, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import {
  listPacks,
  getActivePackName,
  savePack,
  deletePack,
  activatePack,
  deactivatePack,
  setActivePack,
  buildPackFromCurrentOverrides,
  validatePack,
  type CustomSpritePack,
} from '@/services/customSprites';

interface CollectionSwitcherProps {
  modifiedCount: number;
  onPackChanged: () => void;
}

export function CollectionSwitcher({ modifiedCount, onPackChanged }: CollectionSwitcherProps): JSX.Element {
  const { t } = useTranslation();
  const [activePack, setActivePackState] = useState<string | null>(() => getActivePackName());
  const [packList, setPackList] = useState<CustomSpritePack[]>(() => listPacks());
  const [saveDialog, setSaveDialog] = useState(false);
  const [packName, setPackName] = useState('');
  const [packDesc, setPackDesc] = useState('');
  const [importPreview, setImportPreview] = useState<CustomSpritePack | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    setPackList(listPacks());
    setActivePackState(getActivePackName());
  }, []);

  const handleSwitch = useCallback((name: string | null) => {
    if (name === null) {
      deactivatePack();
    } else {
      activatePack(name);
    }
    setActivePackState(name);
    onPackChanged();
  }, [onPackChanged]);

  const handleSavePack = useCallback(() => {
    if (!packName.trim()) {
      setSaveError(t('makeItYours.packNameRequired', 'Pack name is required'));
      return;
    }
    const pack = buildPackFromCurrentOverrides(packName.trim(), undefined, packDesc.trim() || undefined);
    savePack(pack);
    setActivePack(packName.trim());
    setSaveDialog(false);
    setPackName('');
    setPackDesc('');
    setSaveError(null);
    refresh();
  }, [packName, packDesc, refresh, t]);

  const handleExportPack = useCallback(() => {
    const pack = activePack
      ? packList.find((p) => p.name === activePack)
      : buildPackFromCurrentOverrides('my-sprite-pack');

    if (!pack) return;

    const json = JSON.stringify(pack, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pack.name.replace(/[^a-zA-Z0-9_-]/g, '-')}.kdpack`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [activePack, packList]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        const pack = validatePack(parsed);
        if (!pack) {
          setSaveError(t('makeItYours.invalidPack', 'Invalid pack file'));
          return;
        }
        setImportPreview(pack);
        setSaveError(null);
      } catch {
        setSaveError(t('makeItYours.invalidPack', 'Invalid pack file'));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [t]);

  const handleImportConfirm = useCallback(() => {
    if (!importPreview) return;
    savePack(importPreview);
    activatePack(importPreview.name);
    setImportPreview(null);
    refresh();
    onPackChanged();
  }, [importPreview, refresh, onPackChanged]);

  const handleImportCancel = useCallback(() => {
    setImportPreview(null);
  }, []);

  const handleDeletePack = useCallback((name: string) => {
    deletePack(name);
    if (activePack === name) {
      setActivePackState(null);
    }
    refresh();
    onPackChanged();
  }, [activePack, refresh, onPackChanged]);

  const activePackData = activePack ? packList.find((p) => p.name === activePack) : null;
  const canExport = modifiedCount > 0 || activePack !== null;
  const canSave = modifiedCount > 0;

  return (
    <div className="collection-switcher">
      <div className="collection-switcher-header">
        <label className="collection-label">{t('makeItYours.collection', 'Collection')}</label>
        <div className="collection-controls">
          <select
            className="collection-select game-input"
            value={activePack ?? ''}
            onChange={(e) => handleSwitch(e.target.value || null)}
            aria-label={t('makeItYours.collection', 'Collection')}
          >
            <option value="">{t('makeItYours.default', 'Default')}</option>
            {packList.map((p) => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>

          <button
            type="button"
            className="collection-btn ghost"
            onClick={handleExportPack}
            disabled={!canExport}
            aria-label={t('makeItYours.exportPack', 'Export pack')}
          >
            {t('makeItYours.export', 'Export')}
          </button>

          <button
            type="button"
            className="collection-btn ghost"
            onClick={handleImportClick}
            aria-label={t('makeItYours.importPack', 'Import pack')}
          >
            {t('makeItYours.import', 'Import')}
          </button>

          <button
            type="button"
            className="collection-btn ghost"
            onClick={() => setSaveDialog(true)}
            disabled={!canSave}
            aria-label={t('makeItYours.saveCollection', 'Save collection')}
          >
            {t('makeItYours.save', 'Save')}
          </button>

          {activePackData && (
            <button
              type="button"
              className="collection-btn ghost"
              onClick={() => handleDeletePack(activePackData.name)}
              aria-label={t('makeItYours.deleteCollection', 'Delete collection')}
            >
              {t('makeItYours.delete', 'Delete')}
            </button>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept=".kdpack,.json"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
        </div>
      </div>

      {activePackData && (
        <div className="collection-pack-info">
          <span className="collection-pack-name">{activePackData.name}</span>
          {activePackData.description && (
            <span className="collection-pack-desc">{activePackData.description}</span>
          )}
          <span className="collection-pack-count">
            {Object.keys(activePackData.sprites).length} {t('makeItYours.sprites', 'sprites')}
          </span>
        </div>
      )}

      {/* Save dialog */}
      {saveDialog && (
        <div className="collection-save-dialog">
          <input
            type="text"
            className="game-input"
            placeholder={t('makeItYours.packName', 'Pack name...')}
            value={packName}
            onChange={(e) => { setPackName(e.target.value); setSaveError(null); }}
            aria-label={t('makeItYours.packName', 'Pack name')}
          />
          <input
            type="text"
            className="game-input"
            placeholder={t('makeItYours.packDescription', 'Description (optional)')}
            value={packDesc}
            onChange={(e) => setPackDesc(e.target.value)}
            aria-label={t('makeItYours.packDescription', 'Description')}
          />
          {saveError && <div className="collection-save-error">{saveError}</div>}
          <div className="collection-save-actions">
            <button type="button" className="game-btn-primary" onClick={handleSavePack}>
              {t('makeItYours.savePack', 'Save Pack')}
            </button>
            <button type="button" className="ghost" onClick={() => { setSaveDialog(false); setSaveError(null); }}>
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Import preview */}
      {importPreview && (
        <div className="collection-import-preview">
          <div className="collection-import-header">
            {t('makeItYours.importPreview', 'Import Preview')}
          </div>
          <div className="collection-import-info">
            <strong>{importPreview.name}</strong>
            {importPreview.description && (
              <span className="collection-pack-desc"> - {importPreview.description}</span>
            )}
          </div>
          <div className="collection-import-sprites">
            {t('makeItYours.importContains', `Contains ${Object.keys(importPreview.sprites).length} sprites`)}
          </div>
          <div className="collection-import-actions">
            <button type="button" className="game-btn-primary" onClick={handleImportConfirm}>
              {t('makeItYours.importConfirm', 'Import')}
            </button>
            <button type="button" className="ghost" onClick={handleImportCancel}>
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
