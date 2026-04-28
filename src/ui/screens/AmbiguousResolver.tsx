import React from 'react';
import { useStore } from '../../store/store';
import { Icon, fmtCurrency } from '../Icon';
import type { RunRowCandidate, SisterCandidate } from '../../types/domain';
import { t, useLang } from '../../i18n';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { qboTxnUrl } from '../../shared/qbo-url';

// Convert an absolute filesystem path into the qbo-file:// URL the
// renderer can load via <iframe>/<img>. Mirrors the helper in Preview.tsx.
function toLocalFileUrl(absPath: string): string {
  const encoded = absPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `qbo-file://local${encoded}`;
}

// Resolver screen — image 2 of the design handoff. Shown when the user
// clicks "Choisir" on an ambiguous row in the Review screen. The candidates
// were captured by the engine when amb was detected, so this view is
// offline (no QBO round-trip until the user picks one).
export function AmbiguousResolver() {
  useLang();
  const {
    resolverRowId,
    resolverCandidates,
    resolverLoading,
    resolverError,
    resolverSisterCandidates,
    resolverSisterLoading,
    resolverSisterSearched,
    extraction,
    activeCompanyKey,
    companies,
    closeResolver,
    resolveCandidate,
    searchInSisters,
  } = useStore();

  const row = extraction.find((r) => r.id === resolverRowId);
  // picked carries the optional sister companyKey so submit() can route
  // the resolve to the right QBO realm. undefined fetchFromCompanyKey =
  // active company (regular candidate).
  const [picked, setPicked] = React.useState<{
    txnId: string;
    txnType: 'Bill' | 'Purchase' | 'Invoice';
    fetchFromCompanyKey?: string;
  } | null>(null);

  const sisterCount = companies.filter(
    (c) => c.key !== activeCompanyKey && !!c.qboRealmId && c.connected,
  ).length;

  // Quick-look preview state — set when the user clicks a thumbnail.
  // Stays a popover within the resolver so closing it (Esc / backdrop)
  // returns to the candidate list with all picked / sister state intact,
  // unlike navigating away to the full Preview screen.
  const [previewState, setPreviewState] = React.useState<{
    filePath: string;
    contentType: string;
    fileName: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState<string | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  const openInlinePreview = async (
    companyKey: string,
    txnId: string,
    txnType: 'Bill' | 'Purchase' | 'Invoice',
  ) => {
    const key = `${companyKey}|${txnType}|${txnId}`;
    setPreviewLoading(key);
    setPreviewError(null);
    try {
      const res = (await window.qboApi.previewAttachable(
        companyKey,
        txnId,
        txnType,
      )) as { ok: boolean; filePath?: string; contentType?: string; fileName?: string; error?: string };
      if (!res.ok || !res.filePath) {
        setPreviewError(res.error ?? 'Échec du chargement de la pièce jointe.');
      } else {
        setPreviewState({
          filePath: res.filePath,
          contentType: res.contentType ?? '',
          fileName: res.fileName ?? '',
        });
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(null);
    }
  };

  React.useEffect(() => {
    setPicked(null);
  }, [resolverRowId]);

  if (!row) {
    return (
      <div className="screen">
        <div className="topbar">
          <div className="breadcrumb">
            <b>{t('resolver.breadcrumb')}</b>
          </div>
          <div className="topbar-spacer" />
          <button className="btn btn-sm btn-ghost" onClick={closeResolver}>
            {t('common.back')}
          </button>
        </div>
        <div className="content pad" style={{ color: 'var(--muted)' }}>
          {t('resolver.no_row')}
        </div>
      </div>
    );
  }

  const submit = () => {
    if (!picked) return;
    void resolveCandidate(picked.txnId, picked.txnType, picked.fetchFromCompanyKey);
  };

  // Explicit reject — user reviewed all candidates and none matches.
  // Marks the row as 'nf' so it leaves the Ambigus tab and lands in
  // Non trouvés. Esc / "Retour" still close without changing status.
  const reject = async () => {
    if (row.runRowId) {
      try {
        await window.qboApi.rejectAmbiguous(row.runRowId, row.id);
      } catch {
        /* ignore */
      }
    }
    closeResolver();
  };

  // Keyboard navigation. ↑/↓ moves between candidates, 1-9 jumps directly,
  // ↵ confirms (Télécharger), Esc closes. Listener short-circuits when no
  // candidates loaded yet (e.g. while resolverLoading).
  const pickedIndex = picked
    ? resolverCandidates.findIndex(
        (c) => c.txnId === picked.txnId && c.txnType === picked.txnType,
      )
    : -1;
  const movePick = (delta: number) => {
    if (resolverCandidates.length === 0) return;
    const i = pickedIndex < 0 ? 0 : pickedIndex;
    const next = Math.max(0, Math.min(resolverCandidates.length - 1, i + delta));
    const c = resolverCandidates[next];
    setPicked({
      txnId: c.txnId,
      txnType: c.txnType as 'Bill' | 'Purchase' | 'Invoice',
    });
  };
  useKeyboardShortcuts([
    {
      key: 'ArrowDown',
      handler: () => movePick(1),
      label: t('shortcuts.resolver.next'),
      group: t('shortcuts.group.navigation'),
    },
    {
      key: 'ArrowUp',
      handler: () => movePick(-1),
      label: t('shortcuts.resolver.prev'),
      group: t('shortcuts.group.navigation'),
    },
    {
      key: 'Enter',
      handler: submit,
      label: t('shortcuts.resolver.confirm'),
      group: t('shortcuts.group.actions'),
    },
    {
      key: 'Escape',
      handler: () => closeResolver(),
      evenInInput: true,
      label: t('shortcuts.resolver.dismiss'),
      group: t('shortcuts.group.actions'),
    },
    // 1..9 jump-to-candidate. We only label the first three to keep the
    // overlay tight; the others still work but stay implicit.
    ...Array.from({ length: 9 }, (_, i) => ({
      key: String(i + 1),
      handler: () => {
        const c = resolverCandidates[i];
        if (!c) return;
        setPicked({
          txnId: c.txnId,
          txnType: c.txnType as 'Bill' | 'Purchase' | 'Invoice',
        });
      },
      label:
        i < 3 && i < resolverCandidates.length
          ? t('shortcuts.resolver.pick_n', { n: i + 1 })
          : undefined,
      group: i < 3 ? t('shortcuts.group.selection') : undefined,
    })),
  ]);

  return (
    <div className="screen">
      <div className="topbar">
        <div className="breadcrumb">
          <span>{t('resolver.breadcrumb')}</span>
          <span>›</span>
          <b>{t('resolver.ambiguous')}</b>
        </div>
        <div className="topbar-spacer" />
        <button className="btn btn-sm btn-ghost" onClick={closeResolver}>
          {t('common.back')}
        </button>
      </div>

      <div className="content pad" style={{ maxWidth: 980, margin: '0 auto', width: '100%' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 16,
            marginBottom: 20,
          }}
        >
          <button
            onClick={closeResolver}
            className="btn btn-ghost btn-icon"
            title={t('common.back')}
            style={{ marginTop: 2 }}
          >
            ←
          </button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.3 }}>
              {t(
                resolverCandidates.length === 1 ? 'resolver.title_one' : 'resolver.title',
                { num: row.docNumber },
              )}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {resolverCandidates.length === 1
                ? t('resolver.subtitle_one')
                : t('resolver.subtitle', {
                    n: resolverCandidates.length,
                    s: 's',
                    s2: 'nt',
                  })}
            </div>
          </div>
          <span
            className="chip chip-warn"
            style={{ flexShrink: 0, fontSize: 11, padding: '4px 10px' }}
          >
            <Icon name="alert" size={11} /> {t('resolver.ambiguous')}
          </span>
        </header>

        {resolverLoading && (
          <div className="card-surface" style={{ padding: 16, color: 'var(--muted)', fontSize: 12 }}>
            {t('resolver.loading')}
          </div>
        )}

        {resolverError && (
          <div
            className="card-surface"
            style={{ padding: 12, color: 'var(--err)', fontSize: 12, marginBottom: 12 }}
          >
            {resolverError}
          </div>
        )}

        {!resolverLoading && resolverCandidates.length === 0 && !resolverError && (
          <div
            className="card-surface"
            style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}
          >
            {t('resolver.empty')}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {resolverCandidates.map((c) => {
            const previewKey = activeCompanyKey
              ? `${activeCompanyKey}|${c.txnType}|${c.txnId}`
              : null;
            return (
              <CandidateCard
                key={c.id}
                candidate={c}
                selected={
                  picked?.txnId === c.txnId &&
                  picked.txnType === c.txnType &&
                  !picked.fetchFromCompanyKey
                }
                onSelect={() =>
                  setPicked({
                    txnId: c.txnId,
                    txnType: c.txnType as 'Bill' | 'Purchase' | 'Invoice',
                  })
                }
                onPreview={openInlinePreview}
                previewLoading={previewLoading === previewKey}
              />
            );
          })}
        </div>

        {sisterCount > 0 && (
          <div style={{ marginTop: 18 }}>
            {!resolverSisterSearched && (
              <button
                className="btn btn-sm"
                onClick={() => void searchInSisters()}
                disabled={resolverSisterLoading}
                title={t('resolver.sister.search_title')}
              >
                {resolverSisterLoading
                  ? t('resolver.sister.searching')
                  : t('resolver.sister.search', { n: sisterCount })}
              </button>
            )}
            {resolverSisterSearched && resolverSisterCandidates.length === 0 && (
              <div
                className="card-surface"
                style={{ padding: 12, color: 'var(--muted)', fontSize: 12 }}
              >
                {t('resolver.sister.empty')}
              </div>
            )}
            {resolverSisterCandidates.length > 0 && (
              <>
                <div
                  className="muted"
                  style={{
                    fontSize: 10.5,
                    marginTop: 6,
                    marginBottom: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    fontWeight: 600,
                  }}
                >
                  {t('resolver.sister.section_title', {
                    n: resolverSisterCandidates.length,
                  })}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {resolverSisterCandidates.map((c, i) => {
                    const previewKey = `${c.companyKey}|${c.txnType}|${c.txnId}`;
                    return (
                      <SisterCandidateCard
                        key={`${c.companyKey}-${c.txnType}-${c.txnId}-${i}`}
                        candidate={c}
                        selected={
                          picked?.txnId === c.txnId &&
                          picked.txnType === c.txnType &&
                          picked.fetchFromCompanyKey === c.companyKey
                        }
                        onSelect={() =>
                          setPicked({
                            txnId: c.txnId,
                            txnType: c.txnType,
                            fetchFromCompanyKey: c.companyKey,
                          })
                        }
                        onPreview={openInlinePreview}
                        previewLoading={previewLoading === previewKey}
                      />
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {(resolverCandidates.length > 0 || resolverSisterCandidates.length > 0) && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              marginTop: 24,
            }}
          >
            <button className="btn" onClick={reject} disabled={resolverLoading}>
              {t('resolver.no_match')}
            </button>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={!picked || resolverLoading}
            >
              {resolverLoading ? t('resolver.downloading') : t('resolver.download')}
            </button>
          </div>
        )}
      </div>
      {previewError && (
        <div
          style={{
            position: 'fixed',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: 24,
            background: 'var(--err)',
            color: '#fff',
            padding: '8px 14px',
            borderRadius: 8,
            fontSize: 12,
            zIndex: 999,
          }}
          onClick={() => setPreviewError(null)}
        >
          {previewError}
        </div>
      )}
      {previewState && (
        <InlinePreviewOverlay
          filePath={previewState.filePath}
          contentType={previewState.contentType}
          fileName={previewState.fileName}
          onClose={() => setPreviewState(null)}
        />
      )}
    </div>
  );
}

// Quick-look overlay shown when the user clicks an attachable thumbnail.
// Loads the temp file the IPC dropped in userData/preview-cache via the
// qbo-file:// protocol. Esc / backdrop click / X button close — all
// preserve the resolver's picked / sister state.
function InlinePreviewOverlay({
  filePath,
  contentType,
  fileName,
  onClose,
}: {
  filePath: string;
  contentType: string;
  fileName: string;
  onClose: () => void;
}) {
  const url = toLocalFileUrl(filePath);
  const lower = (fileName + ' ' + contentType).toLowerCase();
  const isPdf = /\.pdf\b/.test(lower) || lower.includes('pdf');
  const isImage =
    /\.(jpe?g|png|gif|webp|tiff?|heic|bmp)\b/.test(lower) ||
    lower.includes('image/');

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.72)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          padding: 12,
          maxWidth: '92vw',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          minWidth: 320,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            paddingBottom: 6,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={fileName}
          >
            {fileName || t('resolver.preview_attachable')}
          </span>
          <span
            className="muted"
            style={{ fontSize: 11, fontStyle: 'italic' }}
          >
            {t('resolver.preview_close_hint')}
          </span>
          <button
            className="btn btn-sm btn-ghost"
            onClick={onClose}
            aria-label={t('common.back')}
            style={{ flexShrink: 0 }}
          >
            ×
          </button>
        </div>
        {isPdf && (
          <iframe
            src={url}
            style={{
              width: '80vw',
              height: '80vh',
              border: 0,
              background: '#fff',
              borderRadius: 6,
            }}
            title={fileName}
          />
        )}
        {!isPdf && isImage && (
          <img
            src={url}
            alt={fileName}
            style={{
              maxWidth: '80vw',
              maxHeight: '80vh',
              objectFit: 'contain',
              background: '#fff',
              borderRadius: 6,
            }}
          />
        )}
        {!isPdf && !isImage && (
          <div
            style={{
              padding: 32,
              color: 'var(--muted)',
              fontSize: 13,
              textAlign: 'center',
            }}
          >
            {t('resolver.preview_unsupported', { type: contentType || 'inconnu' })}
          </div>
        )}
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  selected,
  onSelect,
  onPreview,
  previewLoading,
}: {
  candidate: RunRowCandidate;
  selected: boolean;
  onSelect: () => void;
  onPreview?: (
    companyKey: string,
    txnId: string,
    txnType: 'Bill' | 'Purchase' | 'Invoice',
  ) => void;
  previewLoading?: boolean;
}) {
  // Pull the active company's realmId so the deep-link URL routes to the
  // correct QBO company instead of whichever company the user's web
  // session happens to be on.
  const activeCompanyKey = useStore((s) => s.activeCompanyKey);
  const companies = useStore((s) => s.companies);
  const realmId = companies.find((c) => c.key === activeCompanyKey)?.qboRealmId;
  const typeChipClass =
    candidate.txnType === 'Bill'
      ? 'chip-info'
      : candidate.txnType === 'Purchase'
        ? 'chip-warn'
        : '';

  return (
    <div
      onClick={onSelect}
      className="card-surface"
      style={{
        padding: 16,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        cursor: 'pointer',
        borderColor: selected ? 'var(--accent)' : 'var(--line)',
        borderWidth: selected ? 2 : 1,
        // Compensate the extra border so cards don't shift when selected.
        margin: selected ? -1 : 0,
      }}
    >
      <input
        type="radio"
        checked={selected}
        onChange={onSelect}
        style={{ flexShrink: 0, accentColor: 'var(--accent)' }}
      />
      <span
        className={`chip ${typeChipClass}`}
        style={{ flexShrink: 0, fontSize: 11, padding: '3px 10px' }}
      >
        {candidate.txnType}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>
            {candidate.vendorName ?? '—'}
          </span>
          <span
            className="mono"
            style={{ fontSize: 10.5, color: 'var(--muted)' }}
          >
            txnId {candidate.txnId}
          </span>
        </div>
        <div
          className="mono"
          style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}
        >
          {candidate.txnDate ?? '—'} ·{' '}
          {candidate.totalAmount != null
            ? fmtCurrency(candidate.totalAmount)
            : '—'}{' '}
          ·{' '}
          {candidate.attachableCount === 0
            ? t('resolver.no_attachment')
            : t('resolver.attachments', {
                n: candidate.attachableCount,
                s: candidate.attachableCount > 1 ? 's' : '',
              })}
        </div>
      </div>
      <ThumbnailStack
        kinds={candidate.attachableKinds}
        count={candidate.attachableCount}
        loading={previewLoading}
        onClick={
          onPreview && activeCompanyKey && candidate.attachableCount > 0
            ? () => onPreview(activeCompanyKey, candidate.txnId, candidate.txnType)
            : undefined
        }
      />
      <button
        className="btn btn-ghost btn-icon"
        title={t('resolver.open_qbo_txn')}
        onClick={(e) => {
          e.stopPropagation();
          void window.qboApi.openUrl(qboTxnUrl(candidate.txnId, candidate.txnType, realmId));
        }}
        style={{ flexShrink: 0 }}
      >
        <Icon name="external" size={12} />
      </button>
    </div>
  );
}

// Mirror of CandidateCard for sister-company hits. Renders an extra
// company badge so the user knows which set of QBO books the row would
// be downloaded from, and uses the sister's realmId for the deep-link
// (otherwise the browser would land on the same-id txn in the active
// company's realm, which is wrong).
function SisterCandidateCard({
  candidate,
  selected,
  onSelect,
  onPreview,
  previewLoading,
}: {
  candidate: SisterCandidate;
  selected: boolean;
  onSelect: () => void;
  onPreview?: (
    companyKey: string,
    txnId: string,
    txnType: 'Bill' | 'Purchase' | 'Invoice',
  ) => void;
  previewLoading?: boolean;
}) {
  const sister = useStore((s) =>
    s.companies.find((c) => c.key === candidate.companyKey),
  );
  const realmId = sister?.qboRealmId;
  const typeChipClass =
    candidate.txnType === 'Bill'
      ? 'chip-info'
      : candidate.txnType === 'Purchase'
        ? 'chip-warn'
        : '';

  return (
    <div
      onClick={onSelect}
      className="card-surface"
      style={{
        padding: 16,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        cursor: 'pointer',
        borderColor: selected ? 'var(--accent)' : 'var(--line)',
        borderWidth: selected ? 2 : 1,
        margin: selected ? -1 : 0,
      }}
    >
      <input
        type="radio"
        checked={selected}
        onChange={onSelect}
        style={{ flexShrink: 0, accentColor: 'var(--accent)' }}
      />
      <span
        className="chip chip-accent"
        style={{ flexShrink: 0, fontSize: 11, padding: '3px 10px', fontWeight: 600 }}
        title={t('resolver.sister.from_company', { name: candidate.companyLabel })}
      >
        {candidate.companyLabel}
      </span>
      <span
        className={`chip ${typeChipClass}`}
        style={{ flexShrink: 0, fontSize: 11, padding: '3px 10px' }}
      >
        {candidate.txnType}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>
            {candidate.vendorName ?? '—'}
          </span>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
            txnId {candidate.txnId}
          </span>
        </div>
        <div
          className="mono"
          style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}
        >
          {candidate.txnDate ?? '—'} ·{' '}
          {candidate.totalAmount != null
            ? fmtCurrency(candidate.totalAmount)
            : '—'}{' '}
          ·{' '}
          {candidate.attachableCount === 0
            ? t('resolver.no_attachment')
            : t('resolver.attachments', {
                n: candidate.attachableCount,
                s: candidate.attachableCount > 1 ? 's' : '',
              })}
        </div>
      </div>
      <ThumbnailStack
        kinds={candidate.attachableKinds}
        count={candidate.attachableCount}
        loading={previewLoading}
        onClick={
          onPreview && candidate.attachableCount > 0
            ? () => onPreview(candidate.companyKey, candidate.txnId, candidate.txnType)
            : undefined
        }
      />
      <button
        className="btn btn-ghost btn-icon"
        title={t('resolver.open_qbo_txn')}
        onClick={(e) => {
          e.stopPropagation();
          void window.qboApi.openUrl(
            qboTxnUrl(candidate.txnId, candidate.txnType, realmId),
          );
        }}
        style={{ flexShrink: 0 }}
      >
        <Icon name="external" size={12} />
      </button>
    </div>
  );
}

function ThumbnailStack({
  kinds,
  count,
  onClick,
  loading,
}: {
  kinds: string[];
  count: number;
  onClick?: () => void;
  loading?: boolean;
}) {
  if (count === 0) {
    return (
      <div
        style={{
          width: 64,
          height: 70,
          border: '1.5px dashed var(--line)',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--muted-2)',
          fontSize: 10,
          fontStyle: 'italic',
          flexShrink: 0,
        }}
      >
        aucune
      </div>
    );
  }

  // Display up to 2 stacked thumbnails; if there are more, show "+N".
  const shown = kinds.slice(0, 2);
  const overflow = Math.max(0, count - shown.length);
  return (
    <div
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
      title={onClick ? t('resolver.preview_attachable') : undefined}
      style={{
        position: 'relative',
        width: 86,
        height: 70,
        flexShrink: 0,
        cursor: onClick ? 'pointer' : 'default',
        opacity: loading ? 0.5 : 1,
        transition: 'opacity 120ms',
      }}
    >
      {shown.map((k, i) => (
        <Thumb
          key={i}
          kind={k}
          style={{
            position: 'absolute',
            left: i * 26,
            top: i * 4,
            transform: i === 0 ? 'rotate(-3deg)' : 'rotate(2deg)',
            zIndex: shown.length - i,
          }}
        />
      ))}
      {loading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 99,
            fontSize: 10,
            color: 'var(--muted)',
            fontWeight: 600,
          }}
        >
          …
        </div>
      )}
      {overflow > 0 && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 24,
            height: 24,
            borderRadius: 12,
            background: 'var(--ink)',
            color: '#fff',
            fontSize: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
            fontFamily: 'var(--mono)',
            zIndex: 10,
          }}
        >
          +{overflow}
        </div>
      )}
    </div>
  );
}

const KIND_STYLES: Record<string, { bg: string; fg: string; label: string }> = {
  pdf: { bg: '#f3e0e0', fg: '#7a2929', label: 'PDF' },
  jpg: { bg: '#e5dfb6', fg: '#5b4a14', label: 'JPG' },
  jpeg: { bg: '#e5dfb6', fg: '#5b4a14', label: 'JPG' },
  png: { bg: '#dee9d8', fg: '#2d4a23', label: 'PNG' },
  heic: { bg: '#e2dfe9', fg: '#3a2e58', label: 'HEIC' },
  tiff: { bg: '#dde6e9', fg: '#1f4451', label: 'TIFF' },
  gif: { bg: '#f0dfe5', fg: '#5e1f3a', label: 'GIF' },
  webp: { bg: '#dde9e8', fg: '#1f4a48', label: 'WEBP' },
};

function Thumb({ kind, style }: { kind: string; style?: React.CSSProperties }) {
  const k = (kind || '').toLowerCase();
  const palette = KIND_STYLES[k] ?? { bg: '#eee', fg: 'var(--muted)', label: k.toUpperCase() || 'FILE' };
  return (
    <div
      style={{
        width: 56,
        height: 64,
        borderRadius: 4,
        background: palette.bg,
        border: '1px solid rgba(0,0,0,0.08)',
        boxShadow: '0 2px 4px rgba(0,0,0,0.08)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        padding: 4,
        ...style,
      }}
    >
      <span
        style={{
          fontSize: 9.5,
          fontFamily: 'var(--mono)',
          fontWeight: 700,
          color: palette.fg,
          letterSpacing: '0.04em',
        }}
      >
        {palette.label}
      </span>
    </div>
  );
}
