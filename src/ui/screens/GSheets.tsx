import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../Icon';
import { t, useLang } from '../../i18n';

type Workbook = { id: string; name: string; modifiedTime: string };

export function GSheets() {
  useLang();
  const { companies, activeCompanyKey, loadCompanies, setScreen, resyncBudget } = useStore();
  const company = companies.find((c) => c.key === activeCompanyKey);

  const [query, setQuery] = useState('');
  const [workbooks, setWorkbooks] = useState<Workbook[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!activeCompanyKey) return;
    setLoading(true);
    setError(null);
    const res = (await window.qboApi.googleListWorkbooks(activeCompanyKey)) as {
      ok: boolean;
      workbooks?: Workbook[];
      error?: string;
    };
    if (!res.ok) {
      setError(res.error ?? 'Impossible de lister les classeurs.');
      setLoading(false);
      return;
    }
    setWorkbooks(res.workbooks ?? []);
    setLoading(false);
  };

  useEffect(() => {
    if (company?.gsheetsConnected) void load();
  }, [activeCompanyKey, company?.gsheetsConnected]);

  const connectGoogle = async () => {
    if (!activeCompanyKey) return;
    setLoading(true);
    setError(null);
    const res = (await window.qboApi.googleConnect(activeCompanyKey)) as {
      ok: boolean;
      email?: string;
      error?: string;
    };
    if (!res.ok) {
      setError(res.error ?? 'Connexion Google échouée.');
      setLoading(false);
      return;
    }
    await loadCompanies();
    await load();
  };

  const disconnectGoogle = async () => {
    if (!activeCompanyKey) return;
    await window.qboApi.googleDisconnect(activeCompanyKey);
    await loadCompanies();
    setWorkbooks([]);
  };

  const pick = async (wb: Workbook) => {
    if (!activeCompanyKey) return;
    await window.qboApi.googlePickWorkbook(activeCompanyKey, wb.id, wb.name);
    await loadCompanies();
    await resyncBudget();
    setScreen('dashboard');
  };

  const pickExcel = async () => {
    const res = (await window.qboApi.excelPickFile()) as { ok: boolean; path?: string };
    if (!res.ok || !res.path || !activeCompanyKey) return;
    await window.qboApi.excelSetFile(activeCompanyKey, res.path);
    await loadCompanies();
    await resyncBudget();
    setScreen('dashboard');
  };

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return workbooks.filter((w) => w.name.toLowerCase().includes(q));
  }, [workbooks, query]);

  return (
    <div className="screen">
      <div className="topbar">
        <div className="breadcrumb">
          <span>{company?.label ?? '—'}</span>
          <span>›</span>
          <b>{t('gsheets.title')}</b>
        </div>
        <div className="topbar-spacer" />
        <button className="btn btn-sm btn-ghost" onClick={() => setScreen('dashboard')}>
          {t('common.back')}
        </button>
      </div>

      <div className="content pad" style={{ maxWidth: 720, margin: '0 auto', width: '100%' }}>
        <div className="card-surface" style={{ padding: 18, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{t('gsheets.section.gsheets')}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {company?.gsheetsConnected
                  ? `${t('gsheets.connected_as')} : ${company.gsheetsEmail ?? 'Google'}`
                  : t('gsheets.connect_hint')}
              </div>
            </div>
            {company?.gsheetsConnected ? (
              <button className="btn btn-sm" onClick={disconnectGoogle}>
                {t('gsheets.disconnect')}
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={connectGoogle} disabled={loading}>
                <Icon name="external" size={12} /> {t('gsheets.connect')}
              </button>
            )}
          </div>
        </div>

        {company?.gsheetsConnected && (
          <div className="card-surface" style={{ padding: 18, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Icon name="search" size={14} />
              <input
                className="input"
                placeholder={t('gsheets.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ flex: 1 }}
              />
              <button className="btn btn-sm" onClick={load} disabled={loading}>
                <Icon name="refresh" size={12} /> {t('gsheets.refresh')}
              </button>
            </div>
            <div style={{ maxHeight: 360, overflow: 'auto', borderTop: '1px solid var(--line)' }}>
              {filtered.map((w) => (
                <div
                  key={w.id}
                  onClick={() => pick(w)}
                  style={{
                    padding: '10px 8px',
                    borderBottom: '1px solid var(--line)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <Icon name="sheet" size={14} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{w.name}</div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {t('gsheets.modified')} : {new Date(w.modifiedTime).toLocaleDateString('fr-CA')}
                    </div>
                  </div>
                  {company?.gsheetsWorkbookId === w.id && (
                    <span className="chip chip-ok">
                      <Icon name="check" size={10} /> {t('gsheets.active')}
                    </span>
                  )}
                </div>
              ))}
              {filtered.length === 0 && !loading && (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                  {t('gsheets.no_workbooks')}
                </div>
              )}
              {loading && (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                  {t('gsheets.loading')}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="card-surface" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{t('gsheets.section.excel')}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {company?.excelPath
                  ? `${t('gsheets.file_label')} : ${company.excelPath}`
                  : t('gsheets.excel_hint')}
              </div>
            </div>
            <button className="btn btn-sm" onClick={pickExcel}>
              <Icon name="file" size={12} /> {t('gsheets.choose_file')}
            </button>
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 12, color: 'var(--err)', fontSize: 12 }}>{error}</div>
        )}
      </div>
    </div>
  );
}
