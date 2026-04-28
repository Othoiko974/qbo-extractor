import React, { useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../Icon';
import { t, useLang } from '../../i18n';
import type { Company } from '../../types/domain';

const NAMING_VARS: { key: string; desc: string }[] = [
  { key: '{num}', desc: 'N° de facture' },
  { key: '{fournisseur}', desc: 'Fournisseur (sanitisé)' },
  { key: '{date}', desc: 'Date YYYY-MM-DD' },
  { key: '{montant}', desc: 'Montant (ex : 350,10)' },
  { key: '{batiment}', desc: 'Bâtiment' },
  { key: '{sheet}', desc: 'Feuille source' },
];

const FOLDER_VARS: { key: string; desc: string }[] = [
  { key: '{year}', desc: '2025' },
  { key: '{month}', desc: '12' },
  { key: '{day}', desc: '31' },
  { key: '{date-month}', desc: '2025-12' },
  { key: '{date}', desc: '2025-12-31' },
  { key: '{sheet}', desc: 'Feuille — utilise "/" pour sous-dossier' },
  { key: '{fournisseur}', desc: 'Fournisseur' },
  { key: '{batiment}', desc: 'Bâtiment' },
];

const FOLDER_PRESETS: { label: string; value: string }[] = [
  { label: 'Par mois', value: '{year}-{month}' },
  { label: 'Année › mois', value: '{year}/{month}' },
  { label: 'Année › feuille', value: '{year}/{sheet}' },
  { label: 'Feuille › mois', value: '{sheet}/{year}-{month}' },
  { label: 'Un seul dossier (plat)', value: '' },
];

export function Settings() {
  useLang();
  const { settings, updateSettings, setScreen, companies, loadCompanies, setActiveCompany } = useStore();
  const [baseFolder, setBaseFolder] = useState(settings.base_folder ?? '');
  const [template, setTemplate] = useState(
    settings.naming_template ?? 'Depense_{num}_{fournisseur}_{date}_{montant}',
  );
  const [folderTemplate, setFolderTemplate] = useState(
    settings.folder_template ?? '{year}-{month}',
  );
  const [saved, setSaved] = useState<'idle' | 'saving' | 'ok'>('idle');
  const nameRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    setSaved('saving');
    await updateSettings({
      base_folder: baseFolder,
      naming_template: template,
      folder_template: folderTemplate,
    });
    setSaved('ok');
    setTimeout(() => setSaved('idle'), 1500);
  };

  const pickFolder = async () => {
    const res = (await window.qboApi.pickFolder()) as { ok: boolean; path?: string };
    if (res.ok && res.path) setBaseFolder(res.path);
  };

  const insertAt = (
    ref: React.RefObject<HTMLInputElement>,
    value: string,
    setValue: (s: string) => void,
    token: string,
  ) => {
    const el = ref.current;
    if (!el) {
      setValue(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    setValue(next);
    setTimeout(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  };

  // Live preview with sample data.
  const nameSample = useMemo(() => {
    return preview(template, {
      num: '89108',
      fournisseur: 'Home_Depot',
      date: '2025-09-24',
      montant: '350,10',
      batiment: '1310',
      sheet: '154-PLOMBERIE',
    });
  }, [template]);

  const folderSample = useMemo(() => {
    return previewFolder(folderTemplate, {
      year: '2025',
      month: '09',
      day: '24',
      'date-month': '2025-09',
      date: '2025-09-24',
      sheet: '154-PLOMBERIE',
      fournisseur: 'Home_Depot',
      batiment: '1310',
    });
  }, [folderTemplate]);

  const nameInvalid = /[\\/:*?"<>|]/.test(nameSample);

  return (
    <div className="screen">
      <div className="topbar">
        <div className="breadcrumb">
          <b>{t('settings.title')}</b>
        </div>
        <div className="topbar-spacer" />
        {saved === 'ok' && (
          <span
            style={{
              color: 'var(--ok)',
              fontSize: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Icon name="check" size={12} /> {t('settings.saved')}
          </span>
        )}
        <button
          className="btn btn-sm btn-primary"
          onClick={save}
          disabled={saved === 'saving'}
        >
          {saved === 'saving' ? t('connect.saving') : t('settings.save')}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setScreen('dashboard')}>
          {t('common.back')}
        </button>
      </div>

      <div className="content pad" style={{ maxWidth: 760, margin: '0 auto', width: '100%' }}>
        <div className="card-surface" style={{ padding: 18, marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{t('settings.section.destination')}</div>
          <Field label="Dossier de base (un sous-dossier par entreprise est créé automatiquement)">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input mono"
                value={baseFolder}
                onChange={(e) => setBaseFolder(e.target.value)}
                style={{ flex: 1, fontSize: 12 }}
                placeholder="~/Documents/QBO Extracts"
              />
              <button className="btn" onClick={pickFolder}>
                <Icon name="folder" size={12} /> Parcourir
              </button>
            </div>
          </Field>
        </div>

        <div className="card-surface" style={{ padding: 18, marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            {t('settings.section.folder_structure')}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>
            Utilise « / » pour créer des sous-dossiers imbriqués. Laisse vide pour tout mettre à plat.
          </div>

          <Field label="Gabarit de dossier">
            <input
              ref={folderRef}
              className="input mono"
              value={folderTemplate}
              onChange={(e) => setFolderTemplate(e.target.value)}
              style={{ fontSize: 12 }}
              placeholder="{year}-{month}"
            />
          </Field>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
            {FOLDER_VARS.map((v) => (
              <button
                key={v.key}
                type="button"
                className="chip"
                title={v.desc}
                onClick={() =>
                  insertAt(folderRef, folderTemplate, setFolderTemplate, v.key)
                }
                style={{ cursor: 'pointer', fontFamily: 'var(--mono)' }}
              >
                {v.key}
              </button>
            ))}
          </div>

          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>Présets</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {FOLDER_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`btn btn-sm${folderTemplate === p.value ? ' btn-primary' : ''}`}
                onClick={() => setFolderTemplate(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <PreviewBox label="Aperçu du chemin">
            <span className="mono" style={{ color: 'var(--muted)' }}>
              {baseFolder || '~/Documents/QBO Extracts'}/Altitude 233 Inc/
            </span>
            <span className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>
              {folderSample || '(plat)'}
            </span>
          </PreviewBox>
        </div>

        <div className="card-surface" style={{ padding: 18, marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{t('settings.section.naming')}</div>

          <Field label="Gabarit de nom de fichier">
            <input
              ref={nameRef}
              className="input mono"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              style={{ fontSize: 12 }}
            />
          </Field>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
            {NAMING_VARS.map((v) => (
              <button
                key={v.key}
                type="button"
                className="chip"
                title={v.desc}
                onClick={() => insertAt(nameRef, template, setTemplate, v.key)}
                style={{ cursor: 'pointer', fontFamily: 'var(--mono)' }}
              >
                {v.key}
              </button>
            ))}
          </div>

          <PreviewBox label="Aperçu du nom de fichier">
            <span className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>
              {nameSample || '(vide)'}
            </span>
            <span className="mono" style={{ color: 'var(--muted)' }}>.pdf</span>
          </PreviewBox>

          {nameInvalid && (
            <div
              style={{
                marginTop: 8,
                padding: '8px 10px',
                background: 'var(--danger-soft)',
                color: '#6d1e1e',
                border: '1px solid #e4c3c3',
                borderRadius: 6,
                fontSize: 11.5,
              }}
            >
              Le modèle produit des caractères interdits (\ / : * ? " &lt; &gt; |). Ils seront remplacés par « _ ».
            </div>
          )}
        </div>

        <div className="card-surface" style={{ padding: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            {t('settings.section.companies')}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>
            {t('settings.entity_aliases.help')}
          </div>
          {companies.map((c) => (
            <CompanyEditor
              key={c.key}
              company={c}
              onDelete={async () => {
                if (!confirm(`${t('settings.delete')} ${c.label} ?`)) return;
                await window.qboApi.deleteCompany(c.key);
                await loadCompanies();
              }}
              onAliasesChange={async (next) => {
                await window.qboApi.setEntityAliases(c.key, next);
                await loadCompanies();
              }}
              onConfigureQbo={() => {
                setActiveCompany(c.key);
                setScreen('connect');
              }}
              onConfigureBudget={() => {
                setActiveCompany(c.key);
                setScreen('gsheets');
              }}
            />
          ))}
          <button
            className="btn btn-primary btn-sm"
            style={{ marginTop: 12 }}
            onClick={() => {
              setActiveCompany(null);
              setScreen('connect');
            }}
          >
            <Icon name="plus" size={12} /> {t('settings.add_company')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 500 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function PreviewBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '10px 12px',
        background: 'var(--paper-2)',
        border: '1px solid var(--line)',
        borderRadius: 7,
        fontSize: 12,
      }}
    >
      <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ wordBreak: 'break-all' }}>{children}</div>
    </div>
  );
}

function preview(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v).replaceAll(`\${${k}}`, v);
  }
  return out.replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
}

function previewFolder(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out
    .split(/[\\/]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('/');
}

// One company row in the Settings → Entreprises card. Wraps the existing
// metadata + delete button and adds an editable list of "entity aliases":
// the strings the user expects in the budget's Fournisseur column for
// rows that should be routed to this company's QBO. Default = [label].
function CompanyEditor({
  company,
  onDelete,
  onAliasesChange,
  onConfigureQbo,
  onConfigureBudget,
}: {
  company: Company;
  onDelete: () => Promise<void>;
  onAliasesChange: (aliases: string[]) => Promise<void>;
  onConfigureQbo: () => void;
  onConfigureBudget: () => void;
}) {
  const aliases =
    company.entityAliases && company.entityAliases.length > 0
      ? company.entityAliases
      : [company.label];
  const [draft, setDraft] = useState('');

  const removeAlias = async (a: string) => {
    const next = aliases.filter((x) => x !== a);
    if (next.length === 0) return; // never let it go empty — at least the label.
    await onAliasesChange(next);
  };

  const addAlias = async () => {
    const v = draft.trim();
    if (!v) return;
    if (aliases.includes(v)) {
      setDraft('');
      return;
    }
    await onAliasesChange([...aliases, v]);
    setDraft('');
  };

  return (
    <div
      style={{
        padding: '12px 0',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            background: company.color,
            color: '#fff',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          {company.initials}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{company.label}</div>
          <div className="muted" style={{ fontSize: 11 }}>
            QBO :{' '}
            <span style={{ color: company.connected ? 'var(--ok)' : 'var(--muted)' }}>
              {company.connected ? t('settings.qbo_connected') : t('settings.qbo_disconnected')}
            </span>
            {' · '}
            {t('settings.budget')} :{' '}
            {company.budgetSource ?? t('settings.budget_not_configured')}
          </div>
        </div>
        <button className="btn btn-sm" onClick={onConfigureQbo} title={t('settings.configure_qbo_title')}>
          <Icon name="settings" size={11} /> {t('settings.configure_qbo')}
        </button>
        <button className="btn btn-sm" onClick={onConfigureBudget} title={t('settings.configure_budget_title')}>
          <Icon name="sheet" size={11} /> {t('settings.configure_budget')}
        </button>
        <button className="btn btn-sm btn-danger" onClick={() => void onDelete()}>
          {t('settings.delete')}
        </button>
      </div>

      <div style={{ marginTop: 10, marginLeft: 32 }}>
        <div
          className="muted"
          style={{ fontSize: 11, marginBottom: 6, fontWeight: 500 }}
        >
          {t('settings.entity_aliases.label')}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {aliases.map((a) => (
            <span
              key={a}
              className="chip"
              style={{
                fontSize: 11,
                padding: '3px 8px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span>{a}</span>
              {aliases.length > 1 && (
                <button
                  type="button"
                  onClick={() => void removeAlias(a)}
                  title={t('settings.entity_aliases.remove')}
                  style={{
                    appearance: 'none',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--muted)',
                    padding: 0,
                    display: 'inline-flex',
                  }}
                >
                  <Icon name="x" size={9} />
                </button>
              )}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="input input-sm"
            placeholder={t('settings.entity_aliases.placeholder')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addAlias();
            }}
            style={{ flex: 1, fontSize: 12 }}
          />
          <button
            className="btn btn-sm"
            onClick={() => void addAlias()}
            disabled={!draft.trim()}
          >
            <Icon name="plus" size={11} />{' '}
            {t('settings.entity_aliases.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
