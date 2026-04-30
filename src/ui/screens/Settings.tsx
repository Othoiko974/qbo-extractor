import React, { useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../Icon';
import { t, useLang } from '../../i18n';
import type { Company, Project } from '../../types/domain';

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
  const { settings, updateSettings, setScreen, companies, projects, loadCompanies, loadProjects, setActiveCompany } = useStore();
  const [baseFolder, setBaseFolder] = useState(settings.base_folder ?? '');
  const [template, setTemplate] = useState(
    settings.naming_template ?? 'Depense_{num}_{fournisseur}_{date}_{montant}',
  );
  const [folderTemplate, setFolderTemplate] = useState(
    settings.folder_template ?? '',
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

  // Sample company label for the path preview. Pick the first real
  // company so the user sees a realistic preview tied to their actual
  // setup instead of a hardcoded "Altitude 233 Inc.". Falls back to a
  // generic placeholder when there are no companies yet (fresh install).
  const previewCompany = companies[0]?.label ?? 'Compagnie';

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
        {/* Sortie — destination du dossier de base + structure des
            sous-dossiers + nom des fichiers extraits. Une seule carte
            avec sous-sections pour réduire la dispersion visuelle. */}
        <div className="card-surface" style={{ padding: 18, marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Sortie</div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 16 }}>
            Où vont les PJ extraites et comment elles sont nommées.
          </div>

          <SubSection title="Dossier de base">
            <Field label="Un sous-dossier par compagnie est créé automatiquement.">
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
          </SubSection>

          <SubSection title="Structure des sous-dossiers">
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
              Utilise « / » pour imbriquer. Laisse vide pour tout mettre à plat.
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
                {baseFolder || '~/Documents/QBO Extracts'}/{previewCompany}/
              </span>
              <span className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>
                {folderSample || '(plat)'}
              </span>
            </PreviewBox>
          </SubSection>

          <SubSection title="Nom des fichiers" last>
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
          </SubSection>
        </div>

        <ProjectsSection
          companies={companies}
          projects={projects}
          reloadProjects={loadProjects}
          reloadCompanies={loadCompanies}
          onConfigureQbo={(companyKey) => {
            setActiveCompany(companyKey);
            setScreen('connect');
          }}
          onConfigureBudget={(projectId) => {
            // Budget config still flows through a company on the
            // gsheets screen — pick any company in the project so OAuth
            // and the workbook picker have a context. The picked workbook
            // is written back to the project, not just the company.
            const anyInProject = companies.find((c) => c.projectId === projectId);
            if (!anyInProject) {
              window.alert(
                "Ajoute d'abord une compagnie au projet — la configuration du budget passe par la connexion Google d'une compagnie.",
              );
              return;
            }
            setActiveCompany(anyInProject.key);
            setScreen('gsheets');
          }}
          onExportImportQbo={(companyKey) => {
            setActiveCompany(companyKey);
            setScreen('connect');
          }}
          onAddCompany={(projectId) => {
            // Stash the target project so the Connect screen can pre-
            // fill it on creation. We use sessionStorage to avoid
            // plumbing a new field through the store for a transient
            // hand-off.
            try {
              sessionStorage.setItem('pending_project_id', projectId);
            } catch {
              /* private mode / quota — fall through */
            }
            setActiveCompany(null);
            setScreen('connect');
          }}
        />
      </div>
    </div>
  );
}

function SubSection({
  title,
  last,
  children,
}: {
  title: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        paddingBottom: last ? 0 : 14,
        marginBottom: last ? 0 : 14,
        borderBottom: last ? 'none' : '1px solid var(--line)',
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      {children}
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

// One company row, rendered inline inside its project card. Shows
// avatar + label + connection status, exposes the entity-aliases editor
// (the actual data the user tweaks here), and packs the secondary
// actions (Configurer QBO, Exporter / Importer la connexion, Supprimer)
// into the right-hand button row. Budget is intentionally absent — it
// lives at the project level since v5.
function CompanyEditor({
  company,
  allProjects,
  onDelete,
  onAliasesChange,
  onMoveProject,
  onConfigureQbo,
  onExportQbo,
  onImportQbo,
}: {
  company: Company;
  allProjects: Project[];
  onDelete: () => Promise<void>;
  onAliasesChange: (aliases: string[]) => Promise<void>;
  onMoveProject: (projectId: string) => void;
  onConfigureQbo: () => void;
  onExportQbo: () => void;
  onImportQbo: () => void;
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
          </div>
        </div>
        {/* Project-move dropdown — only useful when there are at least
            two projects (otherwise there's nowhere to move to). Lets the
            user reassign without leaving the card. */}
        {allProjects.length > 1 && (
          <select
            className="input input-sm"
            value={company.projectId ?? ''}
            onChange={(e) => onMoveProject(e.target.value)}
            style={{ width: 160, fontSize: 12 }}
            title="Réaffecter cette compagnie à un autre projet"
          >
            {!company.projectId && <option value="">— sans projet —</option>}
            {allProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-sm" onClick={onConfigureQbo} title={t('settings.configure_qbo_title')}>
          <Icon name="settings" size={11} /> {t('settings.configure_qbo')}
        </button>
        {company.connected && (
          <button
            className="btn btn-sm"
            onClick={onExportQbo}
            title={t('settings.export_qbo_title')}
          >
            ⤓
          </button>
        )}
        <button
          className="btn btn-sm"
          onClick={onImportQbo}
          title={t('settings.import_qbo_title')}
        >
          ⤒
        </button>
        <button
          className="btn btn-sm btn-danger"
          onClick={() => void onDelete()}
          title={t('settings.delete')}
        >
          ✕
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

// Hierarchical projects-and-companies card. Each project is rendered as
// its own sub-card containing: name, budget config row, the companies
// that belong to it (CompanyEditor inline), the virtual Compte item,
// and an "Ajouter une compagnie" button scoped to the project. Orphan
// companies (no project_id) get a dedicated "Sans projet" sub-card so
// the user can reassign them. A new-project input lives at the bottom.
function ProjectsSection({
  companies,
  projects,
  reloadProjects,
  reloadCompanies,
  onConfigureQbo,
  onConfigureBudget,
  onExportImportQbo,
  onAddCompany,
}: {
  companies: Company[];
  projects: Project[];
  reloadProjects: () => Promise<void>;
  reloadCompanies: () => Promise<void>;
  onConfigureQbo: (companyKey: string) => void;
  onConfigureBudget: (projectId: string) => void;
  onExportImportQbo: (companyKey: string) => void;
  onAddCompany: (projectId: string) => void;
}) {
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    const trimmed = newName.trim();
    if (!trimmed) return;
    const res = (await window.qboApi.projectsCreate(trimmed)) as {
      ok: boolean;
      error?: string;
    };
    if (!res.ok) {
      setError(res.error ?? 'Échec.');
      return;
    }
    setNewName('');
    await reloadProjects();
  };

  const rename = async (projectId: string, name: string) => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = (await window.qboApi.projectsRename(projectId, trimmed)) as {
      ok: boolean;
      error?: string;
    };
    if (!res.ok) setError(res.error ?? 'Échec.');
    await reloadProjects();
  };

  const remove = async (projectId: string) => {
    setError(null);
    const res = (await window.qboApi.projectsDelete(projectId)) as {
      ok: boolean;
      error?: string;
    };
    if (!res.ok) {
      setError(res.error ?? 'Échec.');
      return;
    }
    await reloadProjects();
  };

  const setProject = async (companyKey: string, projectId: string) => {
    setError(null);
    await window.qboApi.companiesSetProject(companyKey, projectId);
    await reloadCompanies();
    await reloadProjects();
  };

  const orphans = companies.filter((c) => !c.projectId);

  return (
    <div className="card-surface" style={{ padding: 18, marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
        Projets et compagnies
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 16 }}>
        Un projet regroupe les compagnies qui partagent le même budget. Le « Compte »
        virtuel reçoit les factures que personne ne réclame (fournisseurs externes).
      </div>

      {projects.map((p) => {
        const linked = companies.filter((c) => c.projectId === p.id);
        return (
          <ProjectCard
            key={p.id}
            project={p}
            linkedCompanies={linked}
            allProjects={projects}
            onRename={(name) => void rename(p.id, name)}
            onDelete={() => void remove(p.id)}
            onConfigureBudget={() => onConfigureBudget(p.id)}
            onAddCompany={() => onAddCompany(p.id)}
            onConfigureQbo={onConfigureQbo}
            onExportImportQbo={onExportImportQbo}
            onMoveCompany={setProject}
            onCompanyChanged={() => void reloadCompanies()}
          />
        );
      })}

      {orphans.length > 0 && (
        <OrphanCompaniesBlock
          orphans={orphans}
          allProjects={projects}
          onMoveCompany={setProject}
          onConfigureQbo={onConfigureQbo}
          onExportImportQbo={onExportImportQbo}
          onCompanyChanged={() => void reloadCompanies()}
        />
      )}

      <div
        style={{
          display: 'flex',
          gap: 8,
          marginTop: 14,
          paddingTop: 14,
          borderTop: '1px solid var(--line)',
        }}
      >
        <input
          className="input"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nom du nouveau projet (ex. 1310 Charlevoix)"
          style={{ flex: 1 }}
        />
        <button
          className="btn btn-primary btn-sm"
          onClick={() => void create()}
          disabled={!newName.trim()}
        >
          <Icon name="plus" size={11} /> Créer un projet
        </button>
      </div>

      {error && (
        <div style={{ marginTop: 10, color: 'var(--err)', fontSize: 11.5 }}>
          {error}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  linkedCompanies,
  allProjects,
  onRename,
  onDelete,
  onConfigureBudget,
  onAddCompany,
  onConfigureQbo,
  onExportImportQbo,
  onMoveCompany,
  onCompanyChanged,
}: {
  project: Project;
  linkedCompanies: Company[];
  allProjects: Project[];
  onRename: (name: string) => void;
  onDelete: () => void;
  onConfigureBudget: () => void;
  onAddCompany: () => void;
  onConfigureQbo: (companyKey: string) => void;
  onExportImportQbo: (companyKey: string) => void;
  onMoveCompany: (companyKey: string, projectId: string) => Promise<void>;
  onCompanyChanged: () => void;
}) {
  const budgetLabel =
    project.budgetSource === 'gsheets' && project.gsheetsWorkbookName
      ? `Sheets : ${project.gsheetsWorkbookName}`
      : project.budgetSource === 'excel' && project.excelPath
        ? `Excel : …${project.excelPath.slice(-32)}`
        : 'Aucune source de budget configurée';

  return (
    <div
      style={{
        padding: 14,
        border: '1px solid var(--line)',
        borderRadius: 8,
        marginBottom: 12,
        background: 'var(--paper-1)',
      }}
    >
      {/* Header — name + delete (disabled while companies are linked). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <input
          className="input"
          defaultValue={project.name}
          onBlur={(e) => {
            if (e.target.value.trim() && e.target.value !== project.name) {
              onRename(e.target.value);
            }
          }}
          style={{ flex: 1, fontWeight: 600, fontSize: 14 }}
        />
        <button
          className="btn btn-sm btn-danger"
          onClick={onDelete}
          disabled={linkedCompanies.length > 0}
          title={
            linkedCompanies.length > 0
              ? `Migre les ${linkedCompanies.length} compagnie(s) vers un autre projet d'abord.`
              : 'Supprimer ce projet'
          }
        >
          Supprimer le projet
        </button>
      </div>

      {/* Budget source row — single CTA, label reflects current state. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          background: 'var(--paper-2)',
          border: '1px solid var(--line)',
          borderRadius: 7,
          marginBottom: 14,
        }}
      >
        <Icon name="sheet" size={13} />
        <span style={{ flex: 1, fontSize: 12.5 }}>{budgetLabel}</span>
        <button className="btn btn-sm" onClick={onConfigureBudget}>
          {project.budgetSource ? 'Changer la source' : 'Configurer une source'}
        </button>
      </div>

      {/* Companies list — full CompanyEditor inline. */}
      <div style={{ marginBottom: 8 }}>
        {linkedCompanies.length === 0 && (
          <div
            className="muted"
            style={{ fontSize: 11.5, padding: '10px 0', fontStyle: 'italic' }}
          >
            Aucune compagnie liée pour l'instant.
          </div>
        )}
        {linkedCompanies.map((c) => (
          <CompanyEditor
            key={c.key}
            company={c}
            allProjects={allProjects}
            onDelete={async () => {
              if (!confirm(`Supprimer la compagnie ${c.label} ?`)) return;
              await window.qboApi.deleteCompany(c.key);
              onCompanyChanged();
            }}
            onAliasesChange={async (next) => {
              await window.qboApi.setEntityAliases(c.key, next);
              onCompanyChanged();
            }}
            onMoveProject={(pid) => void onMoveCompany(c.key, pid)}
            onConfigureQbo={() => onConfigureQbo(c.key)}
            onExportQbo={() => onExportImportQbo(c.key)}
            onImportQbo={() => onExportImportQbo(c.key)}
          />
        ))}
        <CompteRowReadonly projectName={project.name} />
      </div>

      <button className="btn btn-sm" onClick={onAddCompany}>
        <Icon name="plus" size={11} /> Ajouter une compagnie au projet
      </button>
    </div>
  );
}

function CompteRowReadonly({ projectName }: { projectName: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 0',
        borderBottom: '1px solid var(--line)',
      }}
      title="Bucket virtuel : reçoit les factures dont le fournisseur ne correspond à aucune compagnie du projet. Pas d'extraction QBO possible."
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 5,
          background: 'var(--paper-2)',
          color: 'var(--muted)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px dashed var(--line)',
        }}
      >
        <Icon name="folder" size={11} />
      </span>
      <div style={{ flex: 1 }}>
        <div
          style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--muted)' }}
        >
          Compte {projectName}
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Bucket virtuel — fournisseurs externes
        </div>
      </div>
    </div>
  );
}

function OrphanCompaniesBlock({
  orphans,
  allProjects,
  onMoveCompany,
  onConfigureQbo,
  onExportImportQbo,
  onCompanyChanged,
}: {
  orphans: Company[];
  allProjects: Project[];
  onMoveCompany: (companyKey: string, projectId: string) => Promise<void>;
  onConfigureQbo: (companyKey: string) => void;
  onExportImportQbo: (companyKey: string) => void;
  onCompanyChanged: () => void;
}) {
  return (
    <div
      style={{
        padding: 14,
        border: '1px dashed var(--line)',
        borderRadius: 8,
        marginBottom: 12,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Sans projet</div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>
        Affecte chacune à un projet pour la rendre fonctionnelle (le budget vit au niveau du projet).
      </div>
      {orphans.map((c) => (
        <CompanyEditor
          key={c.key}
          company={c}
          allProjects={allProjects}
          onDelete={async () => {
            if (!confirm(`Supprimer la compagnie ${c.label} ?`)) return;
            await window.qboApi.deleteCompany(c.key);
            onCompanyChanged();
          }}
          onAliasesChange={async (next) => {
            await window.qboApi.setEntityAliases(c.key, next);
            onCompanyChanged();
          }}
          onMoveProject={(pid) => void onMoveCompany(c.key, pid)}
          onConfigureQbo={() => onConfigureQbo(c.key)}
          onExportQbo={() => onExportImportQbo(c.key)}
          onImportQbo={() => onExportImportQbo(c.key)}
        />
      ))}
    </div>
  );
}
