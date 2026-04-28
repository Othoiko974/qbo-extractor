import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../Icon';
import type { VendorAlias } from '../../types/domain';
import { t, useLang } from '../../i18n';

export function Vendors() {
  useLang();
  const { activeCompanyKey, companies, resyncBudget } = useStore();
  const [aliases, setAliases] = useState<VendorAlias[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ raw: string; canonical: string } | null>(null);
  const [addingRaw, setAddingRaw] = useState('');
  const [addingCanonical, setAddingCanonical] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const company = companies.find((c) => c.key === activeCompanyKey);

  const load = async () => {
    if (!activeCompanyKey) return;
    setLoading(true);
    const list = (await window.qboApi.listVendorAliases(activeCompanyKey)) as VendorAlias[];
    setAliases(list);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompanyKey]);

  // Group aliases by canonical name → editable roll-up.
  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of aliases) {
      const bucket = m.get(a.canonicalName) ?? [];
      bucket.push(a.rawName);
      m.set(a.canonicalName, bucket);
    }
    const out = Array.from(m.entries()).map(([canonical, raws]) => ({
      canonical,
      raws: raws.sort((a, b) => a.localeCompare(b)),
    }));
    out.sort((a, b) => a.canonical.localeCompare(b.canonical));
    return out;
  }, [aliases]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        g.canonical.toLowerCase().includes(q) ||
        g.raws.some((r) => r.toLowerCase().includes(q)),
    );
  }, [groups, query]);

  const addAlias = async () => {
    if (!activeCompanyKey) return;
    const raw = addingRaw.trim();
    const canonical = addingCanonical.trim();
    if (!raw || !canonical) {
      setErr('Renseigne à la fois le nom brut et le nom canonique.');
      return;
    }
    setErr(null);
    await window.qboApi.upsertVendorAlias(activeCompanyKey, raw, canonical);
    setAddingRaw('');
    setAddingCanonical('');
    await load();
  };

  const removeAlias = async (raw: string) => {
    if (!activeCompanyKey) return;
    await window.qboApi.deleteVendorAlias(activeCompanyKey, raw);
    await load();
  };

  const renameCanonical = async (oldName: string, newName: string) => {
    if (!activeCompanyKey) return;
    const clean = newName.trim();
    if (!clean || clean === oldName) return;
    await window.qboApi.renameVendorCanonical(activeCompanyKey, oldName, clean);
    setEditing(null);
    await load();
  };

  const resyncAndReload = async () => {
    await resyncBudget();
    await load();
  };

  if (!company) {
    return (
      <div className="screen">
        <div className="content pad">
          <div className="card-surface" style={{ padding: 20 }}>
            Sélectionne une entreprise dans la barre latérale.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="topbar">
        <div className="breadcrumb">
          <span>{company.label}</span>
          <span>›</span>
          <b>{t('vendors.title')}</b>
        </div>
        <div className="topbar-spacer" />
        <button className="btn btn-sm" onClick={() => void resyncAndReload()}>
          <Icon name="refresh" size={12} /> {t('dashboard.resync')}
        </button>
      </div>

      <div className="content pad">
        <div className="card-surface" style={{ padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Normalisation des noms de fournisseurs
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Les noms bruts extraits des commentaires Excel (ex. <i>Home Depot</i>, <i>THE HOME DEPOT</i>,
            <i> Home Depot #6123</i>) sont mappés vers un nom canonique (ex. <i>The Home Depot</i>), utilisé
            pour rechercher dans QuickBooks. L'entité (Altitude 233 / TDL / VSL) reste séparée et
            conserve la colonne Fournisseur du budget.
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="input input-sm"
              placeholder="Nom brut (ex. HOME DEPOT #6123)"
              value={addingRaw}
              onChange={(e) => setAddingRaw(e.target.value)}
              style={{ flex: '1 1 220px' }}
            />
            <span style={{ color: 'var(--muted)' }}>→</span>
            <input
              className="input input-sm"
              placeholder="Nom canonique (ex. The Home Depot)"
              value={addingCanonical}
              onChange={(e) => setAddingCanonical(e.target.value)}
              style={{ flex: '1 1 220px' }}
            />
            <button className="btn btn-sm btn-primary" onClick={() => void addAlias()}>
              <Icon name="plus" size={11} /> Ajouter l'alias
            </button>
          </div>
          {err && (
            <div style={{ color: 'var(--err)', fontSize: 12, marginTop: 6 }}>{err}</div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <input
            className="input input-sm"
            placeholder="Filtrer (nom canonique ou alias)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 320 }}
          />
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {filtered.length} nom{filtered.length > 1 ? 's' : ''} canonique{filtered.length > 1 ? 's' : ''} · {aliases.length} alias
          </span>
        </div>

        <div className="card-surface" style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th style={{ width: '30%' }}>{t('vendors.col.canonical')}</th>
                <th>{t('vendors.col.aliases')}</th>
                <th style={{ width: 160 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr key={g.canonical}>
                  <td style={{ verticalAlign: 'top' }}>
                    {editing?.canonical === g.canonical ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          className="input input-sm"
                          autoFocus
                          value={editing.raw}
                          onChange={(e) => setEditing({ ...editing, raw: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void renameCanonical(g.canonical, editing.raw);
                            if (e.key === 'Escape') setEditing(null);
                          }}
                        />
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => void renameCanonical(g.canonical, editing.raw)}
                        >
                          OK
                        </button>
                        <button className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>
                          Annuler
                        </button>
                      </div>
                    ) : (
                      <div style={{ fontWeight: 600 }}>{g.canonical}</div>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {g.raws.map((raw) => (
                        <span
                          key={raw}
                          className="chip"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 11,
                            paddingRight: 4,
                          }}
                          title={raw}
                        >
                          {raw}
                          <button
                            onClick={() => void removeAlias(raw)}
                            style={{
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              color: 'var(--muted)',
                              padding: 0,
                              marginLeft: 2,
                              fontSize: 13,
                              lineHeight: 1,
                            }}
                            title="Supprimer cet alias"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setEditing({ canonical: g.canonical, raw: g.canonical })}
                    >
                      Renommer
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>
                    {loading ? t('gsheets.loading') : t('vendors.empty')}
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
