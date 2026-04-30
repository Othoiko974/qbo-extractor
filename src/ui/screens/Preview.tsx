import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../Icon';
import { t, useLang } from '../../i18n';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { toLocalFileUrl as toQboUrl } from '../../shared/qbo-url';

type ExtractedFile = {
  name: string;
  path: string;
  size: number;
  mtime: number;
  relDir: string;
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isPdf(name: string): boolean {
  return /\.pdf$/i.test(name);
}
function isImage(name: string): boolean {
  return /\.(jpe?g|png|heic|tiff?|gif|webp)$/i.test(name);
}

export function Preview() {
  useLang();
  const { activeCompanyKey, companies, setScreen, previewFilePath, extraction } = useStore();
  const company = companies.find((c) => c.key === activeCompanyKey);

  const [folder, setFolder] = useState<string>('');
  const [files, setFiles] = useState<ExtractedFile[]>([]);
  const [selected, setSelected] = useState<string | null>(previewFilePath);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activeCompanyKey) return;
    setLoading(true);
    void window.qboApi
      .listExtractedFiles(activeCompanyKey)
      .then((res: { ok: boolean; folder?: string; files?: ExtractedFile[]; error?: string }) => {
        if (!res.ok) {
          setLoading(false);
          return;
        }
        setFolder(res.folder ?? '');
        setFiles(res.files ?? []);
        // Pick the path requested via openPreview, else the most recent file.
        if (previewFilePath) setSelected(previewFilePath);
        else if (res.files && res.files.length > 0) setSelected(res.files[0].path);
        setLoading(false);
      });
  }, [activeCompanyKey, previewFilePath]);

  const current = useMemo(
    () => files.find((f) => f.path === selected) ?? null,
    [files, selected],
  );

  // Pull the matching budget row (by file name) so we can show the small
  // metadata strip ("Pont Masson · facture 7117609-01 · 1310 · 040-MAÇON")
  // beneath the file name. resultFilePath gives the most reliable match.
  const matchingRow = useMemo(() => {
    if (!current) return null;
    return (
      extraction.find((r) => r.resultFilePath === current.path) ??
      extraction.find((r) => r.resultFileName === current.name) ??
      null
    );
  }, [current, extraction]);

  // Keyboard navigation through the file list. We compute the current index
  // on each handler invocation so the bindings always pick up whatever
  // `selected` is in state — no stale closures.
  const selectedIndex = useMemo(
    () => files.findIndex((f) => f.path === selected),
    [files, selected],
  );
  const moveSelection = (delta: number) => {
    if (files.length === 0) return;
    const i = selectedIndex < 0 ? 0 : selectedIndex;
    const next = Math.max(0, Math.min(files.length - 1, i + delta));
    setSelected(files[next].path);
  };
  // Auto-scroll the active file into view when keyboard navigation moves it
  // past the visible area of the left panel.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!listRef.current || !selected) return;
    const node = listRef.current.querySelector<HTMLElement>(
      `[data-file-path="${CSS.escape(selected)}"]`,
    );
    node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);

  useKeyboardShortcuts([
    {
      key: 'ArrowDown',
      handler: () => moveSelection(1),
      label: t('shortcuts.preview.next'),
      group: t('shortcuts.group.navigation'),
    },
    {
      key: 'ArrowUp',
      handler: () => moveSelection(-1),
      label: t('shortcuts.preview.prev'),
      group: t('shortcuts.group.navigation'),
    },
    {
      key: 'Home',
      handler: () => files.length > 0 && setSelected(files[0].path),
      label: t('shortcuts.preview.first'),
      group: t('shortcuts.group.navigation'),
    },
    {
      key: 'End',
      handler: () => files.length > 0 && setSelected(files[files.length - 1].path),
      label: t('shortcuts.preview.last'),
      group: t('shortcuts.group.navigation'),
    },
    {
      key: 'Enter',
      handler: () => {
        if (current) void window.qboApi.openFile(current.path);
      },
      label: t('preview.open_default'),
      group: t('shortcuts.group.actions'),
    },
    {
      key: 'r',
      meta: true,
      handler: () => {
        if (current) void window.qboApi.revealFile(current.path);
      },
      label: t('preview.reveal_finder'),
      group: t('shortcuts.group.actions'),
    },
    {
      key: 'l',
      meta: true,
      handler: () => {
        if (matchingRow?.docNumber) {
          void window.qboApi.openUrl(
            `https://qbo.intuit.com/app/globalsearch?searchstring=${encodeURIComponent(matchingRow.docNumber)}`,
          );
        }
      },
      label: t('preview.search_qbo'),
      group: t('shortcuts.group.actions'),
    },
    {
      key: 'Escape',
      handler: () => setScreen('dashboard'),
      evenInInput: true,
      label: t('common.back'),
      group: t('shortcuts.group.navigation'),
    },
  ]);

  const sub = matchingRow
    ? [
        matchingRow.vendor,
        matchingRow.docNumber ? `facture ${matchingRow.docNumber}` : null,
        matchingRow.building,
        matchingRow.sheet,
      ]
        .filter(Boolean)
        .join(' · ')
    : current?.relDir
      ? current.relDir
      : '';

  return (
    <div className="screen">
      <div className="topbar">
        <div className="breadcrumb">
          <span>{company?.label ?? '—'}</span>
          <span>›</span>
          <b>{t('preview.title')}</b>
        </div>
        <div className="topbar-spacer" />
        <button className="btn btn-sm btn-ghost" onClick={() => setScreen('dashboard')}>
          {t('common.back')}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* Left: file list */}
        <aside
          style={{
            width: 320,
            borderRight: '1px solid var(--line)',
            background: 'var(--paper-2)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              fontFamily: 'var(--mono)',
              color: 'var(--ink)',
            }}
          >
            <Icon name="folder" size={13} />
            <span
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={folder}
            >
              {folder ? folder.split('/').pop() + '/' : '…'}
            </span>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              title={t('preview.open_folder')}
              onClick={() => folder && window.qboApi.openFolder(folder)}
            >
              <Icon name="external" size={11} />
            </button>
          </div>
          <div ref={listRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {loading && (
              <div style={{ padding: 20, color: 'var(--muted)', fontSize: 12 }}>
                {t('gsheets.loading')}
              </div>
            )}
            {!loading && files.length === 0 && (
              <div style={{ padding: 20, color: 'var(--muted)', fontSize: 12 }}>
                {t('preview.no_files')}
              </div>
            )}
            {files.map((f) => {
              const active = f.path === selected;
              return (
                <div
                  key={f.path}
                  data-file-path={f.path}
                  onClick={() => setSelected(f.path)}
                  style={{
                    padding: '10px 14px 10px 14px',
                    cursor: 'pointer',
                    background: active ? 'var(--paper)' : 'transparent',
                    borderLeft: active
                      ? '3px solid var(--accent)'
                      : '3px solid transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    borderBottom: '1px solid var(--line-2)',
                  }}
                >
                  <span
                    style={{
                      width: 18,
                      display: 'flex',
                      flexShrink: 0,
                      color: isPdf(f.name) ? '#a23a3a' : isImage(f.name) ? '#6b6131' : 'var(--muted)',
                    }}
                  >
                    <Icon name="file" size={14} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="mono"
                      style={{
                        fontSize: 11.5,
                        fontWeight: active ? 600 : 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={f.name}
                    >
                      {f.name}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1 }}>
                      {fmtSize(f.size)}
                      {f.relDir ? ` · ${f.relDir}` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* Right: viewer */}
        <section
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            background: 'var(--paper)',
          }}
        >
          {current ? (
            <>
              <header
                style={{
                  padding: '14px 18px',
                  borderBottom: '1px solid var(--line)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: '#fff',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="mono"
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={current.name}
                  >
                    {current.name}
                  </div>
                  {sub && (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: 'var(--muted)',
                        marginTop: 2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {sub}
                    </div>
                  )}
                </div>
                <button
                  className="btn btn-sm btn-ghost"
                  title={t('preview.open_default')}
                  onClick={() => window.qboApi.openFile(current.path)}
                >
                  <Icon name="external" size={12} /> {t('preview.open')}
                </button>
                {matchingRow?.docNumber && (
                  <button
                    className="btn btn-sm btn-ghost"
                    title={t('preview.search_qbo')}
                    onClick={() =>
                      window.qboApi.openUrl(
                        `https://qbo.intuit.com/app/globalsearch?searchstring=${encodeURIComponent(matchingRow.docNumber)}`,
                      )
                    }
                  >
                    <Icon name="external" size={12} /> {t('preview.qbo')}
                  </button>
                )}
                <button
                  className="btn btn-sm btn-ghost"
                  title={t('preview.reveal_finder')}
                  onClick={() => window.qboApi.revealFile(current.path)}
                >
                  <Icon name="folder" size={12} /> {t('preview.finder')}
                </button>
              </header>

              <div
                style={{
                  flex: 1,
                  background: '#ece8df',
                  minHeight: 0,
                  display: 'flex',
                  alignItems: 'stretch',
                  justifyContent: 'stretch',
                }}
              >
                {isPdf(current.name) ? (
                  <iframe
                    key={current.path}
                    src={toQboUrl(current.path)}
                    title={current.name}
                    style={{ flex: 1, border: 'none', background: '#ece8df' }}
                  />
                ) : isImage(current.name) ? (
                  <div
                    style={{
                      flex: 1,
                      overflow: 'auto',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 24,
                    }}
                  >
                    <img
                      src={toQboUrl(current.path)}
                      alt={current.name}
                      style={{
                        maxWidth: '100%',
                        maxHeight: '100%',
                        boxShadow: '0 2px 16px rgba(0,0,0,0.12)',
                        background: '#fff',
                      }}
                    />
                  </div>
                ) : (
                  <div
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexDirection: 'column',
                      gap: 10,
                      color: 'var(--muted)',
                      fontSize: 13,
                    }}
                  >
                    <Icon name="file" size={32} />
                    <div>{t('preview.unsupported')}</div>
                    <button
                      className="btn btn-sm"
                      onClick={() => window.qboApi.openFile(current.path)}
                    >
                      {t('preview.open_default')}
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              {t('preview.select_a_file')}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
