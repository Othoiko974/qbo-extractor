import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon, fmtCurrency } from '../Icon';
import type { ExtractionStatus } from '../../types/domain';
import { t, useLang } from '../../i18n';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';

function statusLabel(status: ExtractionStatus): string {
  return t(`status.${status}`);
}

// Split-cell siblings (multi-invoice rows from a single Excel cell)
// inherit amount = 0 except the head, which carries the full amount of
// the originating cell. Showing "$0,00" on the children was misleading
// — they're not really zero, they just don't have an individual amount
// recorded in the budget. Render "—" instead.
function isSplitChild(r: { amount: number; splitGroupSize?: number; splitIndex?: number }): boolean {
  return (r.splitGroupSize ?? 1) > 1 && (r.splitIndex ?? 0) > 0 && r.amount === 0;
}

// Compact M:SS (or H:MM:SS) formatter for short durations. ETA + elapsed
// share this so they line up visually when both are shown side by side.
function formatEta(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatElapsed(ms: number): string {
  return formatEta(ms);
}

function Chip({ status }: { status: ExtractionStatus }) {
  const cls = ({
    ok: 'chip chip-ok',
    run: 'chip chip-info',
    queue: 'chip',
    nf: 'chip chip-err',
    amb: 'chip chip-warn',
    nopj: 'chip chip-warn',
  } as const)[status];
  const dot = ({
    ok: 'dot-ok',
    run: 'dot-run',
    queue: 'dot-idle',
    nf: 'dot-err',
    amb: 'dot-warn',
    nopj: 'dot-warn',
  } as const)[status];
  return (
    <span className={cls}>
      <span className={`dot ${dot}`} />
      {statusLabel(status)}
    </span>
  );
}

export function Extraction({ onOpenReview }: { onOpenReview: () => void }) {
  useLang();
  const {
    extraction,
    counts,
    running,
    paused,
    companies,
    activeCompanyKey,
    pauseExtraction,
    resumeExtraction,
    stopExtraction,
    openPreview,
  } = useStore();
  const company = companies.find((c) => c.key === activeCompanyKey);

  const done = counts.done;
  const total = counts.total || extraction.length;
  const pct = total === 0 ? 0 : (done / total) * 100;
  const failed = counts.amb + counts.nf + counts.nopj;

  // === ETA + cadence ===
  // ETA tracks elapsed extraction time minus paused intervals so the
  // estimate stays honest if the user pauses. Cadence counts *real* HTTP
  // requests against Intuit's v3 API in the last 60 s — not row count —
  // because each row fans out to 2-4+ calls (search, getAttachables,
  // download URL fetch). The signed-URL CDN download is filtered upstream
  // (it doesn't count toward Intuit's 500/min rate limit).
  const [tick, setTick] = useState(0);
  const startRef = useRef<number | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const pausedTotalRef = useRef(0);
  const qboRequestTimes = useStore((s) => s.qboRequestTimes);

  // 1 Hz clock so ETA / Elapsed / Cadence numbers stay live. Always on,
  // regardless of run state, so the cadence chip ages out entries within
  // the rolling 60 s window even between runs (otherwise a finished
  // extraction would freeze its req/min count until the next launch).
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Run-boundary bookkeeping: capture the start, accumulate paused time.
  // The cadence array (reqTimesRef) intentionally is NOT cleared here —
  // QBO's rate limit (500 req/min/realm) is enforced server-side over a
  // rolling 60s window, so back-to-back runs share that window. Wiping
  // the local count on run start would under-report the budget for the
  // first ~minute of a follow-up run. The sliding-window prune below
  // ages out entries naturally.
  useEffect(() => {
    if (running && startRef.current === null) {
      startRef.current = Date.now();
      pausedTotalRef.current = 0;
    }
    if (!running && pausedAtRef.current !== null) {
      pausedTotalRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
    }
  }, [running]);

  useEffect(() => {
    if (paused) {
      pausedAtRef.current = Date.now();
    } else if (pausedAtRef.current !== null) {
      pausedTotalRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
    }
  }, [paused]);

  // Cadence subscription lives in the store (initStore) — the array is
  // shared so it persists across screen mounts and run boundaries.

  const elapsedMs = (() => {
    if (startRef.current === null) return 0;
    let e = Date.now() - startRef.current - pausedTotalRef.current;
    if (pausedAtRef.current !== null) {
      e -= Date.now() - pausedAtRef.current;
    }
    return Math.max(0, e);
  })();

  const avgPerRowMs = done > 0 ? elapsedMs / done : 0;
  const remaining = Math.max(0, total - done);
  const etaMs = avgPerRowMs > 0 && remaining > 0 ? remaining * avgPerRowMs : 0;

  // Real req/min in the rolling 60 s window. Computed live on every render
  // so the chip ages out entries between runs (the 1 Hz tick re-fires this).
  const cutoff = Date.now() - 60_000;
  const reqPerMin = qboRequestTimes.filter((t) => t > cutoff).length;
  void tick;

  // Space toggles pause / resume while a run is active. Esc requests stop
  // (with confirmation since it's destructive). Both ignore key events
  // coming from inputs so search fields stay usable.
  useKeyboardShortcuts([
    {
      key: ' ',
      handler: () => {
        if (!running) return;
        if (paused) void resumeExtraction();
        else void pauseExtraction();
      },
      label: t('shortcuts.extraction.toggle'),
      group: t('shortcuts.group.actions'),
    },
    {
      key: 'Escape',
      handler: () => {
        if (!running) return;
        const ok = window.confirm(t('extraction.stop_confirm'));
        if (ok) void stopExtraction();
      },
      evenInInput: true,
      label: t('shortcuts.extraction.stop'),
      group: t('shortcuts.group.actions'),
    },
  ]);

  return (
    <div className="screen">
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)', background: '#fff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {running
                ? paused
                  ? t('extraction.paused')
                  : t('extraction.in_progress')
                : t('extraction.done')}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {done} / {total} {t('extraction.processed')} · {counts.ok}{' '}
              {t('extraction.successful')} · {failed} {t('extraction.to_check')}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {running && (
            <button
              className="btn btn-sm"
              onClick={() => (paused ? resumeExtraction() : pauseExtraction())}
            >
              <Icon name={paused ? 'play' : 'pause'} size={12} />{' '}
              {paused ? t('extraction.resume') : t('extraction.pause')}
            </button>
          )}
          {running && (
            <button className="btn btn-sm btn-danger" onClick={() => stopExtraction()}>
              {t('extraction.stop')}
            </button>
          )}
          {!running && failed > 0 && (
            <button className="btn btn-sm btn-primary" onClick={onOpenReview}>
              {t('extraction.see_failed', { n: failed })}
            </button>
          )}
        </div>
        <div className="progress-track" style={{ height: 6 }}>
          <div className="progress-fill" style={{ width: pct + '%' }} />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            marginTop: 6,
            fontSize: 11,
            color: 'var(--muted)',
          }}
        >
          <span>
            {t('extraction.account')} : {company?.label ?? '—'}
          </span>
          <span style={{ flex: 1 }} />
          {/* Live metrics — only meaningful while the engine is running. */}
          {running && (
            <>
              <span title={t('extraction.eta_title')}>
                ETA{' '}
                <span className="mono" style={{ color: 'var(--ink)', fontWeight: 500 }}>
                  {paused ? '—' : etaMs > 0 ? formatEta(etaMs) : '…'}
                </span>
              </span>
              <span title={t('extraction.elapsed_title')}>
                {t('extraction.elapsed')}{' '}
                <span className="mono" style={{ color: 'var(--ink)' }}>
                  {formatElapsed(elapsedMs)}
                </span>
              </span>
              <span title={t('extraction.rate_title')}>
                {t('extraction.rate')}{' '}
                <span
                  className="mono"
                  style={{
                    color:
                      reqPerMin >= 400
                        ? 'var(--err)'
                        : reqPerMin >= 250
                          ? 'var(--warn)'
                          : 'var(--ink)',
                    fontWeight: 500,
                  }}
                >
                  {reqPerMin} req/min
                </span>
              </span>
            </>
          )}
          <span className="mono">{Math.round(pct)} %</span>
        </div>
      </div>

      <div className="content" style={{ overflowX: 'auto' }}>
        <table className="tbl" style={{ minWidth: 880 }}>
          <thead>
            <tr>
              <th style={{ width: 26 }}>#</th>
              <th style={{ width: 90 }}>{t('review.col.date')}</th>
              <th style={{ width: 90 }}>{t('review.col.num')}</th>
              <th>{t('review.col.vendor')}</th>
              <th style={{ width: 100, textAlign: 'right' }}>{t('review.col.amount')}</th>
              <th style={{ width: 170 }}>{t('history.col.status')}</th>
              <th style={{ width: 120 }} />
            </tr>
          </thead>
          <tbody>
            {extraction.map((r, i) => (
              <tr key={r.id}>
                <td className="mono muted" style={{ fontSize: 11 }}>
                  {i + 1}
                </td>
                <td className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {r.date}
                </td>
                <td className="mono" style={{ fontWeight: 500 }}>
                  {r.docNumber}
                </td>
                <td>
                  {r.vendor}
                  {r.resultFileName && (
                    <div
                      className="mono"
                      style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}
                    >
                      {r.resultFileName}
                    </div>
                  )}
                </td>
                <td
                  className="mono"
                  style={{
                    textAlign: 'right',
                    color: isSplitChild(r) ? 'var(--muted-2)' : undefined,
                  }}
                  title={
                    isSplitChild(r)
                      ? t('extraction.amount_split_child')
                      : undefined
                  }
                >
                  {isSplitChild(r) ? '—' : fmtCurrency(r.amount)}
                </td>
                <td>
                  <Chip status={r.status} />
                </td>
                <td>
                  {(r.status === 'amb' || r.status === 'nf' || r.status === 'nopj') && (
                    <button className="btn btn-sm" onClick={onOpenReview}>
                      {t('extraction.resolve')}
                    </button>
                  )}
                  {r.status === 'ok' && r.resultFilePath && (
                    <button
                      className="btn btn-ghost btn-icon btn-sm"
                      title={t('extraction.preview')}
                      onClick={() => openPreview(r.resultFilePath!)}
                    >
                      <Icon name="eye" size={12} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
