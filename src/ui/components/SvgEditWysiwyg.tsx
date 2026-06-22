import { useEffect, useRef, useState, useCallback, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

interface SvgEditWysiwygProps {
  /** Initial SVG string to load */
  initialSvg: string;
  /** Called when the user modifies the SVG */
  onChange: (svgContent: string) => void;
  /** Width constraint for the editor */
  editorWidth: number;
  /** Height constraint for the editor */
  editorHeight: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SvgEditorInstance = any;

let svgEditCssLoaded = false;

function loadSvgEditCss(): void {
  if (svgEditCssLoaded) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/editor/svg-edit/svgedit.css';
  document.head.appendChild(link);
  svgEditCssLoaded = true;
}

export function SvgEditWysiwyg({
  initialSvg,
  onChange,
  editorWidth,
  editorHeight,
}: SvgEditWysiwygProps): JSX.Element {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<SvgEditorInstance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const svgLoadedRef = useRef(false);

  const handleSvgChange = useCallback(() => {
    const editor = editorRef.current;
    if (!editor?.svgCanvas) return;
    try {
      const svg = editor.svgCanvas.getSvgString();
      if (svg) onChange(svg);
    } catch {
      // ignore errors during transitions
    }
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    loadSvgEditCss();

    setLoading(true);
    setError(null);

    import('svgedit')
      .then(async (mod) => {
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Editor = (mod as any).default;
        const editor = new Editor(container);
        editorRef.current = editor;

        editor.setConfig({
          allowInitialUserOverride: true,
          extensions: [],
          noDefaultExtensions: false,
          userExtensions: [],
        });

        await editor.init();

        if (cancelled) {
          editorRef.current = null;
          editor.close?.();
          return;
        }

        // Load initial SVG
        if (initialSvg && editor.svgCanvas) {
          try {
            editor.svgCanvas.setSvgString(initialSvg);
            svgLoadedRef.current = true;
          } catch {
            // SVG load failed — editor is still functional
          }
        }

        // Listen for changes
        if (editor.svgCanvas) {
          editor.svgCanvas.bind('changed', handleSvgChange);
        }

        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load SVG editor');
        setLoading(false);
      });

    return () => {
      cancelled = true;
      const editor = editorRef.current;
      if (editor) {
        try {
          if (editor.svgCanvas) {
            editor.svgCanvas.unbind?.('changed', handleSvgChange);
          }
          editor.close?.();
        } catch {
          // cleanup errors are non-fatal
        }
        editorRef.current = null;
      }
    };
  }, []); // only mount once

  // Load new SVG when initialSvg changes
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor?.svgCanvas || loading) return;
    if (!initialSvg) return;

    try {
      // Avoid reloading if it's the same SVG we just loaded
      if (svgLoadedRef.current && initialSvg === editor.svgCanvas.getSvgString?.()) return;
      editor.svgCanvas.setSvgString(initialSvg);
      svgLoadedRef.current = true;
    } catch {
      // non-fatal
    }
  }, [initialSvg, loading]);

  if (error) {
    return (
      <div className="sprite-editor-error">
        {t('makeItYours.wysiwygError', 'WYSIWYG editor failed to load. Use the Code editor instead.')}
        <br />
        <small>{error}</small>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: editorWidth, height: editorHeight }}>
      {loading && (
        <div className="sprite-editor-loading">
          {t('makeItYours.wysiwygLoading', 'Loading WYSIWYG editor...')}
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          visibility: loading ? 'hidden' : 'visible',
        }}
      />
    </div>
  );
}
