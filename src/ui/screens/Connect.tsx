import React, { useEffect, useState } from 'react';
import { useStore } from '../../store/store';
import { Icon } from '../Icon';
import { t, useLang } from '../../i18n';

const PRESET_COLORS = ['#2e4d39', '#7a5a2a', '#5a3a6a', '#3a5a7a', '#7a3a4a', '#4a5a3a'];

export function Connect() {
  useLang();
  const { companies, activeCompanyKey, setScreen, loadCompanies, setActiveCompany } = useStore();
  const company = companies.find((c) => c.key === activeCompanyKey);

  const [mode, setMode] = useState<'add' | 'connect'>(company ? 'connect' : 'add');
  const [label, setLabel] = useState('');
  const [initials, setInitials] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [env, setEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [status, setStatus] = useState<'idle' | 'waiting' | 'error' | 'ok'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [tokenPath, setTokenPath] = useState<string>('');
  const [realmId, setRealmId] = useState<string>('');
  const [testResult, setTestResult] = useState<string | null>(null);

  // Portable connection share — admin exports, non-admin imports. Lets a
  // QBO Standard User Full Access bypass the OAuth admin gate by
  // receiving an encrypted token bundle from a teammate who already
  // OAuth-connected on their own admin account.
  const [showExportForm, setShowExportForm] = useState(false);
  const [exportPass, setExportPass] = useState('');
  const [exportPassConfirm, setExportPassConfirm] = useState('');
  const [exportStatus, setExportStatus] = useState<{
    kind: 'idle' | 'ok' | 'error';
    msg?: string;
  }>({ kind: 'idle' });
  const [importMeta, setImportMeta] = useState<{
    companyLabel: string;
    realmId: string;
    env: string;
    exportedAt: string;
  } | null>(null);
  const [importContent, setImportContent] = useState<string>('');
  const [importPass, setImportPass] = useState('');
  const [importStatus, setImportStatus] = useState<{
    kind: 'idle' | 'ok' | 'error';
    msg?: string;
  }>({ kind: 'idle' });

  const handleExportConnection = async () => {
    if (!activeCompanyKey) return;
    if (exportPass.length < 8) {
      setExportStatus({ kind: 'error', msg: 'Passphrase trop courte (minimum 8 caractères).' });
      return;
    }
    if (exportPass !== exportPassConfirm) {
      setExportStatus({ kind: 'error', msg: 'La confirmation ne correspond pas.' });
      return;
    }
    setExportStatus({ kind: 'idle' });
    const res = (await window.qboApi.qboExportConnection(
      activeCompanyKey,
      exportPass,
    )) as { ok: boolean; filePath?: string; error?: string };
    if (res.ok && res.filePath) {
      setExportStatus({
        kind: 'ok',
        msg: `Exporté → ${res.filePath}. Envoie le fichier ET la passphrase à l'utilisateur (par canaux séparés idéalement).`,
      });
      setExportPass('');
      setExportPassConfirm('');
      setShowExportForm(false);
    } else {
      setExportStatus({ kind: 'error', msg: res.error ?? 'Échec.' });
    }
  };

  const handlePickImport = async () => {
    setImportStatus({ kind: 'idle' });
    const res = (await window.qboApi.qboPeekImportFile()) as {
      ok: boolean;
      content?: string;
      meta?: { companyLabel: string; realmId: string; env: string; exportedAt: string };
      error?: string;
    };
    if (res.ok && res.meta && res.content) {
      setImportMeta(res.meta);
      setImportContent(res.content);
    } else if (res.error && res.error !== 'Import annulé.') {
      setImportStatus({ kind: 'error', msg: res.error });
    }
  };

  const handleImportConnection = async () => {
    if (!activeCompanyKey || !importContent) return;
    if (!importPass) {
      setImportStatus({ kind: 'error', msg: 'Passphrase requise.' });
      return;
    }
    const res = (await window.qboApi.qboImportConnection(
      activeCompanyKey,
      importContent,
      importPass,
    )) as {
      ok: boolean;
      meta?: { companyLabel: string };
      error?: string;
    };
    if (res.ok) {
      setImportStatus({
        kind: 'ok',
        msg: `Connexion importée pour ${res.meta?.companyLabel ?? company?.label ?? 'cette compagnie'}.`,
      });
      setImportPass('');
      setImportMeta(null);
      setImportContent('');
      await loadCompanies();
    } else {
      setImportStatus({ kind: 'error', msg: res.error ?? 'Échec.' });
    }
  };

  // Intuit app credentials (client_id / client_secret) — stored encrypted.
  const [credsConfigured, setCredsConfigured] = useState(false);
  const [credsPreview, setCredsPreview] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [credsStatus, setCredsStatus] = useState<'idle' | 'waiting' | 'ok' | 'error'>('idle');
  const [credsError, setCredsError] = useState<string | null>(null);

  // Edit form (for the currently-active company).
  const [editLabel, setEditLabel] = useState('');
  const [editInitials, setEditInitials] = useState('');
  const [editColor, setEditColor] = useState(PRESET_COLORS[0]);
  const [editStatus, setEditStatus] = useState<'idle' | 'waiting' | 'ok' | 'error'>('idle');
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = (await window.qboApi.qboGetAppCredsStatus()) as {
        configured: boolean;
        clientIdPreview: string | null;
      };
      setCredsConfigured(res.configured);
      setCredsPreview(res.clientIdPreview);
    })();
  }, []);

  useEffect(() => {
    if (company) {
      setEditLabel(company.label);
      setEditInitials(company.initials);
      setEditColor(company.color);
      setEditStatus('idle');
      setEditError(null);
      setRealmId(company.qboRealmId ?? '');
      if (company.qboEnv) setEnv(company.qboEnv);
    } else {
      // No active company — force the Nouvelle entreprise form and clear inputs
      // so the user isn't shown stale data from a previous company.
      setMode('add');
      setLabel('');
      setInitials('');
      setColor(PRESET_COLORS[0]);
      setStatus('idle');
      setError(null);
    }
  }, [company?.key, company?.label, company?.initials, company?.color, company?.qboRealmId, company?.qboEnv]);

  const addCompany = async () => {
    if (!label || !initials) return;
    setStatus('waiting');
    const res = (await window.qboApi.addCompany({ label, initials: initials.toUpperCase().slice(0, 3), color })) as {
      ok: boolean;
      company?: { key: string };
      error?: string;
    };
    if (!res.ok || !res.company) {
      setStatus('error');
      setError(res.error ?? 'Création impossible.');
      return;
    }
    await loadCompanies();
    setActiveCompany(res.company.key);
    setStatus('idle');
    setLabel('');
    setInitials('');
    setColor(PRESET_COLORS[0]);
    setMode('connect');
  };

  const connect = async () => {
    if (!activeCompanyKey) return;
    setStatus('waiting');
    setError(null);
    const res = (await window.qboApi.qboConnect(activeCompanyKey, env)) as {
      ok: boolean;
      realmId?: string;
      error?: string;
    };
    if (!res.ok) {
      setStatus('error');
      setError(res.error ?? 'Connexion QuickBooks échouée.');
      return;
    }
    setStatus('ok');
    await loadCompanies();
  };

  const pickTokenFile = async () => {
    const res = (await window.qboApi.qboPickTokenFile()) as { ok: boolean; path?: string };
    if (res.ok && res.path) setTokenPath(res.path);
  };

  const importToken = async () => {
    if (!activeCompanyKey || !tokenPath || !realmId) return;
    setStatus('waiting');
    setError(null);
    const res = (await window.qboApi.qboImportToken(activeCompanyKey, tokenPath, realmId.trim(), env)) as {
      ok: boolean;
      error?: string;
    };
    if (!res.ok) {
      setStatus('error');
      setError(res.error ?? "Import du token échoué.");
      return;
    }
    setStatus('ok');
    await loadCompanies();
  };

  const saveEdit = async () => {
    if (!activeCompanyKey || !editLabel || !editInitials) return;
    setEditStatus('waiting');
    setEditError(null);
    try {
      await window.qboApi.updateCompany(activeCompanyKey, {
        label: editLabel,
        initials: editInitials.toUpperCase().slice(0, 2),
        color: editColor,
      });
      await loadCompanies();
      setEditStatus('ok');
    } catch (err) {
      setEditStatus('error');
      setEditError(err instanceof Error ? err.message : 'Enregistrement impossible.');
    }
  };

  const saveCreds = async () => {
    if (!clientId.trim() || !clientSecret.trim()) return;
    setCredsStatus('waiting');
    setCredsError(null);
    const res = (await window.qboApi.qboSetAppCreds(clientId.trim(), clientSecret.trim())) as {
      ok: boolean;
      error?: string;
    };
    if (!res.ok) {
      setCredsStatus('error');
      setCredsError(res.error ?? 'Enregistrement impossible.');
      return;
    }
    const status = (await window.qboApi.qboGetAppCredsStatus()) as {
      configured: boolean;
      clientIdPreview: string | null;
    };
    setCredsConfigured(status.configured);
    setCredsPreview(status.clientIdPreview);
    setClientId('');
    setClientSecret('');
    setCredsStatus('ok');
  };

  const clearCreds = async () => {
    const ok = window.confirm('Supprimer les credentials Intuit stockés ?');
    if (!ok) return;
    await window.qboApi.qboDeleteAppCreds();
    setCredsConfigured(false);
    setCredsPreview(null);
    setCredsStatus('idle');
  };

  const testQbo = async () => {
    if (!activeCompanyKey) return;
    setTestResult('Test en cours…');
    const res = await window.qboApi.qboTest(activeCompanyKey);
    setTestResult(JSON.stringify(res, null, 2));
  };

  const switchEnv = async (next: 'sandbox' | 'production') => {
    setEnv(next);
    if (activeCompanyKey && company?.connected) {
      await window.qboApi.updateCompany(activeCompanyKey, { qbo_env: next });
      await loadCompanies();
    }
  };

  const deleteCompany = async () => {
    if (!activeCompanyKey || !company) return;
    const ok = window.confirm(
      `Supprimer "${company.label}" ? Les tokens stockés et l'historique seront effacés. Cette action est irréversible.`,
    );
    if (!ok) return;
    await window.qboApi.deleteCompany(activeCompanyKey);
    setActiveCompany(null);
    await loadCompanies();
    setMode('add');
  };

  return (
    <div className="screen">
      <div className="topbar">
        <div className="breadcrumb">
          {company && (
            <>
              <span>{company.label}</span>
              <span>›</span>
            </>
          )}
          <b>{t('connect.title')}</b>
        </div>
        <div className="topbar-spacer" />
        <button className="btn btn-sm btn-ghost" onClick={() => setScreen('dashboard')}>
          {t('common.back')}
        </button>
      </div>

      <div className="content pad" style={{ maxWidth: 640, margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button
            className={`chip ${mode === 'add' ? 'chip-accent' : ''}`}
            onClick={() => setMode('add')}
            style={{ cursor: 'pointer' }}
          >
            {t('connect.tab.add')}
          </button>
          <button
            className={`chip ${mode === 'connect' ? 'chip-accent' : ''}`}
            onClick={() => setMode('connect')}
            style={{ cursor: 'pointer' }}
            disabled={!activeCompanyKey}
          >
            {t('connect.tab.connect')}
          </button>
        </div>

        {mode === 'add' && company && (
          <div className="card-surface" style={{ padding: 20, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ width: 22, height: 22, borderRadius: 5, background: company.color, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)' }}>
                {company.initials}
              </span>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Modifier l'entreprise active</div>
            </div>
            <Field label={t('connect.full_name')}>
              <input
                className="input"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
              />
            </Field>
            <Field label={t('connect.initials')}>
              <input
                className="input"
                value={editInitials}
                onChange={(e) => setEditInitials(e.target.value.toUpperCase().slice(0, 3))}
                maxLength={3}
              />
            </Field>
            <Field label={t('connect.color')}>
              <div style={{ display: 'flex', gap: 8 }}>
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setEditColor(c)}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      border: editColor === c ? '2px solid var(--ink)' : '1px solid var(--line)',
                      background: c,
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </div>
            </Field>
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary"
                onClick={saveEdit}
                disabled={!editLabel || !editInitials || editStatus === 'waiting'}
              >
                {editStatus === 'waiting' ? t('connect.saving') : t('connect.save')}
              </button>
              <button className="btn btn-danger" onClick={deleteCompany}>
                {t('connect.delete')}
              </button>
              <div style={{ flex: 1 }} />
              <button className="btn btn-sm" onClick={() => setMode('connect')}>
                {t('connect.configure_token')}
              </button>
            </div>
            {editStatus === 'ok' && (
              <div style={{ marginTop: 8, color: 'var(--ok)', fontSize: 12 }}>Enregistré ✓</div>
            )}
            {editStatus === 'error' && editError && (
              <div style={{ marginTop: 8, color: 'var(--err)', fontSize: 12 }}>{editError}</div>
            )}
          </div>
        )}

        {mode === 'add' && (
          <div className="card-surface" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{t('connect.new_company')}</div>
            <Field label={t('connect.full_name')}>
              <input
                className="input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Altitude 233 Inc."
              />
            </Field>
            <Field label={t('connect.initials')}>
              <input
                className="input"
                value={initials}
                onChange={(e) => setInitials(e.target.value.toUpperCase().slice(0, 3))}
                placeholder="A2"
                maxLength={3}
              />
            </Field>
            <Field label={t('connect.color')}>
              <div style={{ display: 'flex', gap: 8 }}>
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      border: color === c ? '2px solid var(--ink)' : '1px solid var(--line)',
                      background: c,
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </div>
            </Field>
            <div style={{ marginTop: 16 }}>
              <button
                className="btn btn-primary"
                onClick={addCompany}
                disabled={!label || !initials || status === 'waiting'}
              >
                {status === 'waiting' ? t('connect.creating') : t('connect.create')}
              </button>
            </div>
            {status === 'error' && error && (
              <div style={{ marginTop: 12, color: 'var(--err)', fontSize: 12 }}>{error}</div>
            )}
          </div>
        )}

        {mode === 'connect' && (
          <div className="card-surface" style={{ padding: 20, marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
              Credentials Intuit (app)
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
              Le <code>client_id</code> et <code>client_secret</code> de ton app Intuit.
              Nécessaire pour le refresh automatique des tokens (sinon tu dois ré-importer
              un fichier frais toutes les heures). Stockés chiffrés via le Keychain macOS.
            </div>
            {credsConfigured && (
              <div
                style={{
                  padding: 10,
                  background: '#eef5ec',
                  border: '1px solid #cbdcc4',
                  borderRadius: 6,
                  fontSize: 12,
                  marginBottom: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span style={{ color: 'var(--ok)' }}>✓</span>
                Configuré — client_id: <code>{credsPreview}</code>
                <div style={{ flex: 1 }} />
                <button className="btn btn-sm btn-ghost" onClick={clearCreds}>
                  Supprimer
                </button>
              </div>
            )}
            <Field label="Client ID">
              <input
                className="input"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="ABxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Client Secret">
              <input
                className="input"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="••••••••••••••••••••••••••••"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary"
                onClick={saveCreds}
                disabled={!clientId.trim() || !clientSecret.trim() || credsStatus === 'waiting'}
              >
                {credsStatus === 'waiting' ? 'Enregistrement…' : credsConfigured ? 'Remplacer' : 'Enregistrer'}
              </button>
            </div>
            {credsStatus === 'ok' && (
              <div style={{ marginTop: 8, color: 'var(--ok)', fontSize: 12 }}>
                Enregistrés ✓ — le refresh automatique est actif.
              </div>
            )}
            {credsStatus === 'error' && credsError && (
              <div style={{ marginTop: 8, color: 'var(--err)', fontSize: 12 }}>{credsError}</div>
            )}
          </div>
        )}

        {mode === 'connect' && (
          <div className="card-surface" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
              Connecter {company?.label ?? '—'}
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
              Un navigateur va s'ouvrir pour l'authentification Intuit. Revenez ensuite à QBO Extractor.
            </div>
            <Field label="Environnement QuickBooks">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className={`chip ${env === 'sandbox' ? 'chip-accent' : ''}`}
                  onClick={() => switchEnv('sandbox')}
                  style={{ cursor: 'pointer' }}
                >
                  Sandbox
                </button>
                <button
                  className={`chip ${env === 'production' ? 'chip-accent' : ''}`}
                  onClick={() => switchEnv('production')}
                  style={{ cursor: 'pointer' }}
                >
                  Production
                </button>
                {company?.connected && (
                  <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
                    (appliqué immédiatement)
                  </span>
                )}
              </div>
            </Field>
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary"
                onClick={connect}
                disabled={!activeCompanyKey || status === 'waiting'}
              >
                <Icon name="external" size={12} />{' '}
                {status === 'waiting' ? 'En attente du navigateur…' : 'Connecter à QuickBooks'}
              </button>
              {status === 'waiting' && (
                <button
                  className="btn"
                  onClick={() => {
                    setStatus('idle');
                    setError(null);
                  }}
                >
                  Annuler
                </button>
              )}
              {company?.connected && (
                <button
                  className="btn"
                  onClick={async () => {
                    if (!activeCompanyKey) return;
                    await window.qboApi.qboDisconnect(activeCompanyKey);
                    await loadCompanies();
                  }}
                >
                  Déconnecter
                </button>
              )}
            </div>
            {status === 'ok' && (
              <div style={{ marginTop: 12, color: 'var(--ok)', fontSize: 12 }}>
                Connecté ✓ — vous pouvez maintenant configurer le budget.
              </div>
            )}
            {status === 'error' && error && (
              <div style={{ marginTop: 12, color: 'var(--err)', fontSize: 12 }}>{error}</div>
            )}
            <div className="divider-h" style={{ margin: '20px 0' }} />

            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              Importer un token existant (test)
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>
              Pour un premier test sans passer par OAuth, importez un fichier JSON de tokens
              déjà émis par Intuit. Le Realm ID (Company ID) se trouve dans le dashboard
              Intuit Developer ou l'URL de QuickBooks.
            </div>
            <Field label="Fichier token (.json)">
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="input"
                  value={tokenPath}
                  onChange={(e) => setTokenPath(e.target.value)}
                  placeholder="/chemin/vers/.qbo_token_*.json"
                  style={{ flex: 1 }}
                />
                <button className="btn" onClick={pickTokenFile}>
                  Parcourir…
                </button>
              </div>
            </Field>
            <Field label="Realm ID (Company ID)">
              <input
                className="input"
                value={realmId}
                onChange={(e) => setRealmId(e.target.value)}
                placeholder="4620816365208703604"
              />
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn"
                onClick={importToken}
                disabled={!tokenPath || !realmId || status === 'waiting'}
              >
                Importer le token
              </button>
              {!!company?.qboRealmId && (
                <button className="btn" onClick={testQbo}>
                  Tester la connexion QBO
                </button>
              )}
            </div>
            {testResult && (
              <pre
                style={{
                  marginTop: 12,
                  padding: 10,
                  background: '#f4f1ea',
                  borderRadius: 6,
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  border: '1px solid var(--line)',
                }}
              >
                {testResult}
              </pre>
            )}

            <div className="divider-h" style={{ margin: '20px 0' }} />

            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              Partage de connexion (admin → utilisateur non-admin)
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>
              Intuit n'autorise que les comptes admin à compléter le flow OAuth.
              Si tu (admin) connectes ici, tu peux exporter cette connexion dans
              un fichier chiffré (.qboconnect) avec une passphrase. Un utilisateur
              Standard User Full Access importe ensuite ce fichier dans son app
              sans avoir à OAuth-connect lui-même.
            </div>

            {company?.connected && (
              <div style={{ marginBottom: 14 }}>
                {!showExportForm ? (
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setShowExportForm(true);
                      setExportStatus({ kind: 'idle' });
                    }}
                  >
                    Exporter cette connexion
                  </button>
                ) : (
                  <div className="card-surface" style={{ padding: 12 }}>
                    <Field label="Passphrase (min. 8 caractères)">
                      <input
                        className="input"
                        type="password"
                        value={exportPass}
                        onChange={(e) => setExportPass(e.target.value)}
                        placeholder="Choisis une passphrase forte"
                      />
                    </Field>
                    <Field label="Confirmer la passphrase">
                      <input
                        className="input"
                        type="password"
                        value={exportPassConfirm}
                        onChange={(e) => setExportPassConfirm(e.target.value)}
                      />
                    </Field>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-sm" onClick={handleExportConnection}>
                        Exporter…
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setShowExportForm(false);
                          setExportPass('');
                          setExportPassConfirm('');
                          setExportStatus({ kind: 'idle' });
                        }}
                      >
                        Annuler
                      </button>
                    </div>
                  </div>
                )}
                {exportStatus.kind === 'ok' && (
                  <div style={{ marginTop: 8, color: 'var(--ok)', fontSize: 11.5 }}>
                    {exportStatus.msg}
                  </div>
                )}
                {exportStatus.kind === 'error' && (
                  <div style={{ marginTop: 8, color: 'var(--err)', fontSize: 11.5 }}>
                    {exportStatus.msg}
                  </div>
                )}
              </div>
            )}

            <div>
              {!importMeta ? (
                <button className="btn btn-sm" onClick={handlePickImport}>
                  Importer une connexion (.qboconnect)
                </button>
              ) : (
                <div className="card-surface" style={{ padding: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                    Fichier de : {importMeta.companyLabel}
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>
                    Realm: <span className="mono">{importMeta.realmId}</span> ·{' '}
                    {importMeta.env} · Exporté le{' '}
                    {new Date(importMeta.exportedAt).toLocaleString()}
                  </div>
                  <Field label="Passphrase reçue de l'admin">
                    <input
                      className="input"
                      type="password"
                      value={importPass}
                      onChange={(e) => setImportPass(e.target.value)}
                    />
                  </Field>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn btn-sm"
                      onClick={handleImportConnection}
                      disabled={!importPass}
                    >
                      Importer dans {company?.label ?? 'cette compagnie'}
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setImportMeta(null);
                        setImportContent('');
                        setImportPass('');
                        setImportStatus({ kind: 'idle' });
                      }}
                    >
                      Annuler
                    </button>
                  </div>
                </div>
              )}
              {importStatus.kind === 'ok' && (
                <div style={{ marginTop: 8, color: 'var(--ok)', fontSize: 11.5 }}>
                  {importStatus.msg}
                </div>
              )}
              {importStatus.kind === 'error' && (
                <div style={{ marginTop: 8, color: 'var(--err)', fontSize: 11.5 }}>
                  {importStatus.msg}
                </div>
              )}
            </div>

            <div style={{ marginTop: 24 }}>
              <button className="btn btn-sm" onClick={() => setScreen('gsheets')}>
                Étape suivante — source du budget →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 500 }}>{label}</div>
      {children}
    </div>
  );
}
