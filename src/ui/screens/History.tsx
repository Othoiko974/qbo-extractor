import React, { useEffect, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon, fmtCurrency } from '../Icon';
import { t, useLang } from '../../i18n';

type Run = {
  id: string;
  company_key: string;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'paused' | 'done' | 'cancelled';
  total: number;
  ok_count: number;
  amb_count: number;
  nf_count: number;
  nopj_count: number;
  folder: string | null;
};

type RunRow = {
  id: string;
  run_id: string;
  row_idx: number;
  doc_number: string | null;
  vendor: string | null;
  booking_entity: string | null;
  amount: number | null;
  date: string | null;
  sheet: string | null;
  building: string | null;
  status: 'queue' | 'run' | 'ok' | 'amb' | 'nf' | 'nopj';
  qbo_txn_id: string | null;
  qbo_txn_type: string | null;
  file_path: string | null;
  error: string | null;
  updated_at: number | null;
};

export function History() {
  useLang();
  const { activeCompanyKey, setScreen, openPreview } = useStore();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);
  // Set of expanded run IDs + cache of their rows. Rows are fetched on
  // first expand (lazy) and kept in memory while the screen is mounted.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rowCache, setRowCache] = useState<Map<string, RunRow[]>>(new Map());
  const [rowsLoading, setRowsLoading] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!activeCompanyKey) return;
    setLoading(true);
    window.qboApi
      .listRuns(activeCompanyKey)
      .then((r) => setRuns(r as Run[]))
      .finally(() => setLoading(false));
  }, [activeCompanyKey]);

  const toggleExpanded = async (runId: string) => {
    const next = new Set(expanded);
    if (next.has(runId)) {
      next.delete(runId);
      setExpanded(next);
      return;
    }
    next.add(runId);
    setExpanded(next);
    if (!rowCache.has(runId)) {
      setRowsLoading((s) => new Set(s).add(runId));
      const rows = (await window.qboApi.listRunRows(runId)) as RunRow[];
      setRowCache((m) => {
        const copy = new Map(m);
        copy.set(runId, rows);
        return copy;
      });
      setRowsLoading((s) => {
        const copy = new Set(s);
        copy.delete(runId);
        return copy;
      });
    }
  };

  return (
    <div className="screen">
      <div className="topbar">
        <div className="breadcrumb">
          <b>{t('history.title')}</b>
        </div>
        <div className="topbar-spacer" />
        <button className="btn btn-sm btn-ghost" onClick={() => setScreen('dashboard')}>
          {t('common.back')}
        </button>
      </div>

      <div className="content pad">
        <div className="card-surface" style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ minWidth: 920 }}>
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>{t('history.col.started')}</th>
                <th>{t('history.col.duration')}</th>
                <th>{t('history.col.total')}</th>
                <th>{t('history.col.ok')}</th>
                <th>{t('review.tab.amb')}</th>
                <th>{t('review.tab.nf')}</th>
                <th>{t('review.tab.nopj')}</th>
                <th>{t('history.col.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const duration = r.finished_at
                  ? Math.round((r.finished_at - r.started_at) / 1000)
                  : null;
                const isOpen = expanded.has(r.id);
                const rows = rowCache.get(r.id);
                const isLoading = rowsLoading.has(r.id);
                return (
                  <React.Fragment key={r.id}>
                    <tr
                      onClick={() => void toggleExpanded(r.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ paddingLeft: 10 }}>
                        <Icon name={isOpen ? 'chev-down' : 'chev-right'} size={11} />
                      </td>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {new Date(r.started_at).toLocaleString('fr-CA')}
                      </td>
                      <td className="mono">{duration != null ? `${duration}s` : '—'}</td>
                      <td className="mono">{r.total}</td>
                      <td className="mono" style={{ color: 'var(--ok)' }}>
                        {r.ok_count}
                      </td>
                      <td className="mono" style={{ color: 'var(--warn)' }}>
                        {r.amb_count}
                      </td>
                      <td className="mono" style={{ color: 'var(--err)' }}>
                        {r.nf_count}
                      </td>
                      <td className="mono" style={{ color: 'var(--warn)' }}>
                        {r.nopj_count}
                      </td>
                      <td>
                        <span className={`chip ${r.status === 'done' ? 'chip-ok' : ''}`}>
                          {t(`history.status.${r.status}`)}
                        </span>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {r.folder && (
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => window.qboApi.openFolder(r.folder!)}
                            title={t('history.open_folder')}
                          >
                            <Icon name="folder" size={12} />
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td
                          colSpan={10}
                          style={{
                            padding: 0,
                            background: 'var(--paper-2)',
                            borderTop: '1px solid var(--line)',
                          }}
                        >
                          <RunRowsTable
                            rows={rows}
                            loading={isLoading}
                            onPreview={(p) => openPreview(p)}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>
                    {loading ? t('gsheets.loading') : t('history.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Inner table rendered when a run is expanded. Status chip echoes the
// extraction status so the user can scan failures without re-opening the
// Review screen. Eye / external icons surface the same shortcuts as the
// live Extraction screen.
function RunRowsTable({
  rows,
  loading,
  onPreview,
}: {
  rows: RunRow[] | undefined;
  loading: boolean;
  onPreview: (filePath: string) => void;
}) {
  if (loading || !rows) {
    return (
      <div style={{ padding: 18, color: 'var(--muted)', fontSize: 12 }}>
        {t('gsheets.loading')}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div style={{ padding: 18, color: 'var(--muted)', fontSize: 12 }}>
        {t('history.empty_rows')}
      </div>
    );
  }

  const openTxn = (txnId: string, txnType: string | null) => {
    const path =
      txnType === 'Bill' ? 'bill' : txnType === 'Invoice' ? 'invoice' : 'expense';
    window.qboApi.openUrl(
      `https://qbo.intuit.com/app/${path}?txnId=${encodeURIComponent(txnId)}`,
    );
  };

  return (
    <div style={{ padding: '4px 8px 12px' }}>
      <table className="tbl" style={{ fontSize: 11.5, minWidth: 880 }}>
        <thead>
          <tr>
            <th style={{ width: 28 }}>#</th>
            <th style={{ width: 90 }}>{t('review.col.date')}</th>
            <th style={{ width: 110 }}>{t('review.col.num')}</th>
            <th>{t('review.col.vendor')}</th>
            <th style={{ width: 110, textAlign: 'right' }}>{t('review.col.amount')}</th>
            <th style={{ width: 130 }}>{t('history.col.status')}</th>
            <th style={{ width: 110 }}>{t('history.col.row_actions')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td className="mono" style={{ color: 'var(--muted)' }}>
                {i + 1}
              </td>
              <td className="mono" style={{ color: 'var(--muted)' }}>
                {r.date ?? '—'}
              </td>
              <td className="mono" style={{ fontWeight: 500 }}>
                {r.doc_number ?? '—'}
              </td>
              <td>{r.vendor ?? '—'}</td>
              <td className="mono" style={{ textAlign: 'right' }}>
                {r.amount != null && r.amount > 0 ? fmtCurrency(r.amount) : '—'}
              </td>
              <td>
                <StatusChip status={r.status} error={r.error} />
              </td>
              <td>
                <div style={{ display: 'flex', gap: 4 }}>
                  {r.status === 'ok' && r.file_path && (
                    <button
                      className="btn btn-ghost btn-icon btn-sm"
                      title={t('extraction.preview')}
                      onClick={() => onPreview(r.file_path!)}
                    >
                      <Icon name="eye" size={11} />
                    </button>
                  )}
                  {r.qbo_txn_id && (
                    <button
                      className="btn btn-ghost btn-icon btn-sm"
                      title={t('history.open_txn')}
                      onClick={() => openTxn(r.qbo_txn_id!, r.qbo_txn_type)}
                    >
                      <Icon name="external" size={11} />
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusChip({
  status,
  error,
}: {
  status: RunRow['status'];
  error: string | null;
}) {
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
    <span className={cls} title={error ?? undefined}>
      <span className={`dot ${dot}`} />
      {t(`status.${status}`)}
    </span>
  );
}
