import React, { useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon, fmtCurrency } from '../Icon';
import type { ExtractionStatus, ExtractionRow } from '../../types/domain';
import { t, useLang } from '../../i18n';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';

type Tab = 'amb' | 'nf' | 'nopj';

// Mirror of the same helper in Extraction.tsx — see comment there for
// rationale. Could be promoted to a shared util if a third screen needs it.
function isSplitChild(r: { amount: number; splitGroupSize?: number; splitIndex?: number }): boolean {
  return (r.splitGroupSize ?? 1) > 1 && (r.splitIndex ?? 0) > 0 && r.amount === 0;
}

// Build a URL that opens the exact bill / expense / invoice in the QBO
// web app instead of dropping the user on the global search page.
// QBO's URL conventions:
//   - Bill        → /app/bill?txnId={id}
//   - Purchase    → /app/expense?txnId={id}    (cash purchase / credit card)
//   - Invoice     → /app/invoice?txnId={id}    (outgoing customer invoice)
function qboTxnUrl(txnId: string, txnType: 'Bill' | 'Purchase' | 'Invoice'): string {
  const path =
    txnType === 'Bill'
      ? 'bill'
      : txnType === 'Invoice'
        ? 'invoice'
        : 'expense';
  return `https://qbo.intuit.com/app/${path}?txnId=${encodeURIComponent(txnId)}`;
}

export function Review() {
  useLang();
  const { extraction, setScreen, openResolver } = useStore();
  const tabLabel: Record<Tab, string> = {
    amb: t('review.tab.amb'),
    nf: t('review.tab.nf'),
    nopj: t('review.tab.nopj'),
  };
  const [tab, setTab] = useState<Tab>('amb');

  const searchInQbo = (r: ExtractionRow) => {
    const url = `https://qbo.intuit.com/app/globalsearch?searchstring=${encodeURIComponent(r.docNumber)}`;
    window.qboApi.openUrl(url);
  };
  // Deep-link straight to the matched QBO transaction when the engine
  // identified it (status='nopj' has txnId because we found the bill but
  // it had no PJ; same for status='ok'). Falls back to a global search
  // by docNumber if for some reason the txn id isn't on the row.
  const openInQbo = (r: ExtractionRow) => {
    if (r.qboTxnId && r.qboTxnType) {
      window.qboApi.openUrl(qboTxnUrl(r.qboTxnId, r.qboTxnType));
      return;
    }
    searchInQbo(r);
  };
  const choose = (r: ExtractionRow) => {
    void openResolver(r.id);
  };

  // Bulk action — mark every amb row as "Aucune correspondance" (status=nf).
  // Useful before re-running extraction with a fixed parser/engine: the user
  // doesn't want to walk every amb row through the resolver only to reject it.
  const bulkDismissAmb = async () => {
    const ambRows = extraction.filter((r) => r.status === 'amb' && r.runRowId);
    if (ambRows.length === 0) return;
    if (!window.confirm(t('review.bulk_dismiss_confirm', { n: ambRows.length }))) return;
    await Promise.allSettled(
      ambRows.map((r) => window.qboApi.rejectAmbiguous(r.runRowId!, r.id)),
    );
  };

  // 1/2/3 → tab switch, Esc → back to extraction. Tabs map to the same
  // visual order as the chips above the table.
  useKeyboardShortcuts([
    {
      key: '1',
      handler: () => setTab('amb'),
      label: t('shortcuts.review.tab_amb'),
      group: t('shortcuts.group.tabs'),
    },
    {
      key: '2',
      handler: () => setTab('nf'),
      label: t('shortcuts.review.tab_nf'),
      group: t('shortcuts.group.tabs'),
    },
    {
      key: '3',
      handler: () => setTab('nopj'),
      label: t('shortcuts.review.tab_nopj'),
      group: t('shortcuts.group.tabs'),
    },
    {
      key: 'Escape',
      handler: () => setScreen('extraction'),
      evenInInput: true,
      label: t('common.back'),
      group: t('shortcuts.group.navigation'),
    },
  ]);

  const counts = useMemo(() => {
    const c = { amb: 0, nf: 0, nopj: 0 };
    for (const r of extraction) {
      if (r.status === 'amb') c.amb++;
      else if (r.status === 'nf') c.nf++;
      else if (r.status === 'nopj') c.nopj++;
    }
    return c;
  }, [extraction]);

  const rows = extraction.filter((r) => r.status === (tab as ExtractionStatus));

  return (
    <div className="screen">
      <div className="topbar">
        <div className="breadcrumb">
          <b>{t('review.title')}</b>
        </div>
        <div className="topbar-spacer" />
        <button className="btn btn-sm btn-ghost" onClick={() => window.qboApi.logsOpen()}>
          {t('review.see_logs')}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setScreen('extraction')}>
          {t('review.back_to_extraction')}
        </button>
      </div>

      <div className="content pad">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          {(['amb', 'nf', 'nopj'] as Tab[]).map((tk) => (
            <button
              key={tk}
              className={`chip ${tab === tk ? 'chip-accent' : ''}`}
              onClick={() => setTab(tk)}
              style={{ cursor: 'pointer' }}
            >
              {tabLabel[tk]} ({counts[tk]})
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {tab === 'amb' && counts.amb > 0 && (
            <button className="btn btn-sm" onClick={bulkDismissAmb}>
              {t('review.bulk_dismiss', { n: counts.amb })}
            </button>
          )}
        </div>

        <div className="card-surface" style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ minWidth: 980 }}>
            <thead>
              <tr>
                <th style={{ width: 90 }}>{t('review.col.date')}</th>
                <th style={{ width: 90 }}>{t('review.col.num')}</th>
                <th>{t('review.col.vendor')}</th>
                <th style={{ width: 120 }}>{t('review.col.entity')}</th>
                <th style={{ width: 120, textAlign: 'right' }}>{t('review.col.amount')}</th>
                <th>{t('review.col.sheet')}</th>
                <th style={{ width: 200 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono" style={{ color: 'var(--muted)' }}>
                    {r.date}
                  </td>
                  <td className="mono" style={{ fontWeight: 500 }}>
                    {r.docNumber}
                  </td>
                  <td>
                    <div>{r.vendor}</div>
                    {r.rawVendor && r.rawVendor !== r.vendor && (
                      <div style={{ fontSize: 10.5, color: 'var(--muted-2)', marginTop: 1, fontStyle: 'italic' }}>
                        {t('review.brut_prefix')} : {r.rawVendor}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 11.5 }}>
                    {r.bookingEntity ? (
                      <span className="chip" style={{ fontSize: 10.5 }}>{r.bookingEntity}</span>
                    ) : (
                      <span style={{ color: 'var(--muted-2)' }}>—</span>
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
                        ? "Ligne issue d'une cellule multi-factures — montant individuel non tracé"
                        : undefined
                    }
                  >
                    {isSplitChild(r) ? '—' : fmtCurrency(r.amount)}
                  </td>
                  <td style={{ color: 'var(--muted)' }}>{r.sheet}</td>
                  <td>
                    {tab === 'nopj' && (
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => openInQbo(r)}
                        title={
                          r.qboTxnId
                            ? t('review.action.open_txn_title', {
                                type: r.qboTxnType ?? '',
                                num: r.docNumber,
                              })
                            : t('review.action.open_qbo_fallback')
                        }
                      >
                        <Icon name="external" size={11} />{' '}
                        {r.qboTxnId
                          ? t('review.action.open_txn')
                          : t('review.action.open_qbo')}
                      </button>
                    )}
                    {tab === 'amb' && (
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => choose(r)}
                        disabled={!r.runRowId}
                        title={
                          r.runRowId
                            ? t('review.action.choose_title')
                            : t('review.action.choose_disabled')
                        }
                      >
                        {t('review.action.choose')}
                      </button>
                    )}
                    {tab === 'nf' && (
                      <button className="btn btn-sm" onClick={() => searchInQbo(r)}>
                        <Icon name="external" size={11} /> {t('review.action.search_qbo')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>
                    {t('review.empty')}
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
