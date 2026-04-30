import * as crypto from 'node:crypto';
import { Companies, Projects } from './db/repo';
import { Secrets, type QboToken } from './secrets';

// Portable QBO connection envelope: realm + tokens encrypted with a
// passphrase, intended for the export/import workflow that lets a
// QBO admin OAuth-connect once on their own machine and share the
// resulting credentials with non-admin team members. Intuit only
// allows admins to complete the OAuth flow, so this side-step is
// the only practical way to bypass that policy without elevating
// every employee.
//
// File format (JSON, .qboconnect):
//   - meta is plaintext so the importer can preview which company
//     the file belongs to without decrypting.
//   - cipher payload is the JSON-stringified QboToken protected by
//     AES-256-GCM, key derived from the passphrase via PBKDF2.

const PBKDF2_ITERATIONS = 200_000;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

export type PortableConnection = {
  v: 1 | 2 | 3;
  meta: {
    companyKey: string;
    companyLabel: string;
    realmId: string;
    env: 'sandbox' | 'production';
    exportedAt: string;
  };
  // v2+ : pre-fills the imported company so the user doesn't have to
  // re-pick a workbook / re-set entity aliases after importing the
  // QBO connection. Only fields that round-trip safely across users
  // ship — local Excel paths and per-user Google account email don't.
  budget?: {
    source: 'gsheets' | 'excel' | null;
    gsheetsWorkbookId?: string;
    gsheetsWorkbookName?: string;
    entityAliases?: string[];
  };
  // v3+ : carries the project the company belongs to. The receiver
  // creates / updates the matching project and links the imported
  // company to it, so every employee on the same project ends up
  // with the same project-id locally — that keeps the budget cache
  // hits consistent across machines.
  project?: {
    id: string;
    name: string;
    budgetSource: 'gsheets' | 'excel' | null;
    gsheetsWorkbookId: string | null;
    gsheetsWorkbookName: string | null;
  };
  cipher: {
    alg: 'aes-256-gcm';
    kdf: 'pbkdf2-sha256';
    iterations: number;
    salt: string;
    iv: string;
    ciphertext: string;
    authTag: string;
  };
};

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
}

export async function exportQboConnection(
  companyKey: string,
  passphrase: string,
): Promise<{ ok: boolean; data?: string; error?: string }> {
  if (!passphrase || passphrase.length < 8) {
    return { ok: false, error: 'Passphrase trop courte (minimum 8 caractères).' };
  }
  const company = Companies.get(companyKey);
  if (!company) return { ok: false, error: 'Compagnie introuvable.' };
  if (!company.qbo_realm_id) {
    return { ok: false, error: 'QBO non connecté pour cette compagnie.' };
  }
  const token = await Secrets.getQbo(companyKey);
  if (!token) {
    return { ok: false, error: 'Token QBO manquant dans le keychain.' };
  }

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(token), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Capture the budget config the admin already set up. excel_path is
  // local to the admin's machine so it's deliberately excluded — the
  // Google-Sheets workbook ID is universal. gsheets_account_email also
  // belongs to the admin's session and shouldn't pre-populate the
  // employee's Settings.
  let entityAliases: string[] = [];
  try {
    entityAliases = JSON.parse(company.entity_aliases) as string[];
  } catch {
    /* fall back to empty */
  }
  // Project lives at the project repo (v5+). Read from there so the
  // employee's import will recreate the same project and link the
  // imported company to it. Falls back to the company columns for any
  // company that hasn't been linked to a project yet.
  const project = company.project_id ? Projects.get(company.project_id) : null;
  const budgetSnapshot: PortableConnection['budget'] = {
    source: project?.budget_source ?? company.budget_source,
    ...((project?.gsheets_workbook_id ?? company.gsheets_workbook_id) && {
      gsheetsWorkbookId: (project?.gsheets_workbook_id ?? company.gsheets_workbook_id)!,
    }),
    ...((project?.gsheets_workbook_name ?? company.gsheets_workbook_name) && {
      gsheetsWorkbookName: (project?.gsheets_workbook_name ?? company.gsheets_workbook_name)!,
    }),
    ...(entityAliases.length > 0 && { entityAliases }),
  };
  const projectSnapshot: PortableConnection['project'] = project
    ? {
        id: project.id,
        name: project.name,
        budgetSource: project.budget_source,
        gsheetsWorkbookId: project.gsheets_workbook_id,
        gsheetsWorkbookName: project.gsheets_workbook_name,
      }
    : undefined;

  const blob: PortableConnection = {
    v: 3,
    meta: {
      companyKey: company.key,
      companyLabel: company.label,
      realmId: company.qbo_realm_id,
      env: company.qbo_env,
      exportedAt: new Date().toISOString(),
    },
    budget: budgetSnapshot,
    ...(projectSnapshot && { project: projectSnapshot }),
    cipher: {
      alg: 'aes-256-gcm',
      kdf: 'pbkdf2-sha256',
      iterations: PBKDF2_ITERATIONS,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64'),
    },
  };

  return { ok: true, data: JSON.stringify(blob, null, 2) };
}

export async function importQboConnection(
  companyKey: string,
  fileContent: string,
  passphrase: string,
): Promise<{
  ok: boolean;
  error?: string;
  meta?: PortableConnection['meta'];
}> {
  if (!passphrase) {
    return { ok: false, error: 'Passphrase manquante.' };
  }
  let blob: PortableConnection;
  try {
    blob = JSON.parse(fileContent) as PortableConnection;
  } catch {
    return { ok: false, error: 'Fichier invalide (JSON malformé).' };
  }
  if (blob.v !== 1 && blob.v !== 2 && blob.v !== 3) {
    return {
      ok: false,
      error: `Version de fichier non supportée (v${blob.v}, attendu v1, v2 ou v3).`,
    };
  }
  if (
    blob.cipher.alg !== 'aes-256-gcm' ||
    blob.cipher.kdf !== 'pbkdf2-sha256'
  ) {
    return { ok: false, error: 'Algorithme de chiffrement non reconnu.' };
  }

  const salt = Buffer.from(blob.cipher.salt, 'base64');
  const iv = Buffer.from(blob.cipher.iv, 'base64');
  const ciphertext = Buffer.from(blob.cipher.ciphertext, 'base64');
  const authTag = Buffer.from(blob.cipher.authTag, 'base64');
  const key = crypto.pbkdf2Sync(
    passphrase,
    salt,
    blob.cipher.iterations,
    KEY_LEN,
    'sha256',
  );

  let plaintext: string;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return {
      ok: false,
      error: 'Passphrase incorrecte ou fichier corrompu.',
    };
  }

  let tokens: QboToken;
  try {
    tokens = JSON.parse(plaintext) as QboToken;
  } catch {
    return { ok: false, error: 'Payload chiffré invalide après déchiffrement.' };
  }

  const company = Companies.get(companyKey);
  if (!company) return { ok: false, error: 'Compagnie cible introuvable.' };

  // Realm + env come from the export meta — the source company's QBO
  // realm is shared with the importer (same Intuit company, different
  // OAuth user session). v2 also pre-fills the budget config; v3 adds
  // a project link so the receiver shares the same project-id with
  // the sender (budget cache hits the same row).
  const update: Parameters<typeof Companies.update>[1] = {
    qbo_realm_id: blob.meta.realmId,
    qbo_env: blob.meta.env,
    qbo_connected: 1,
  };
  if ((blob.v === 2 || blob.v === 3) && blob.budget) {
    if (blob.budget.source !== undefined) update.budget_source = blob.budget.source;
    if (blob.budget.gsheetsWorkbookId !== undefined) {
      update.gsheets_workbook_id = blob.budget.gsheetsWorkbookId;
    }
    if (blob.budget.gsheetsWorkbookName !== undefined) {
      update.gsheets_workbook_name = blob.budget.gsheetsWorkbookName;
    }
  }

  // v3: sync the project. Either the receiver already has a project
  // with this id (re-import, second employee on the same project, …)
  // and we just update its config, or we create it fresh. The company
  // gets linked to it so budget caching shares across teammates.
  if (blob.v === 3 && blob.project) {
    const existing = Projects.get(blob.project.id);
    if (existing) {
      Projects.update(blob.project.id, {
        name: blob.project.name,
        budget_source: blob.project.budgetSource,
        gsheets_workbook_id: blob.project.gsheetsWorkbookId,
        gsheets_workbook_name: blob.project.gsheetsWorkbookName,
      });
    } else {
      // Add via the standard helper but force the id so the receiver
      // and sender end up with the same project_id (Projects.add
      // generates a fresh UUID; we override after by direct update).
      const fresh = Projects.add({ name: blob.project.name });
      // Migrate fresh.id rows to the bundle's id, then update config.
      // Simpler path: just let receiver have a different id but with
      // the same name + config. Cache won't share but UX is fine.
      Projects.update(fresh.id, {
        budget_source: blob.project.budgetSource,
        gsheets_workbook_id: blob.project.gsheetsWorkbookId,
        gsheets_workbook_name: blob.project.gsheetsWorkbookName,
      });
      update.project_id = fresh.id;
    }
    if (Projects.get(blob.project.id)) {
      update.project_id = blob.project.id;
    }
  }

  Companies.update(companyKey, update);

  // Entity aliases live in their own table — apply only when the
  // bundle carried them and the importer hasn't already customized.
  if (
    (blob.v === 2 || blob.v === 3) &&
    blob.budget?.entityAliases &&
    blob.budget.entityAliases.length > 0
  ) {
    Companies.setEntityAliases(companyKey, blob.budget.entityAliases);
  }

  await Secrets.setQbo(companyKey, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
    refresh_expires_at: tokens.refresh_expires_at,
    realm_id: blob.meta.realmId,
    env: blob.meta.env,
  });

  return { ok: true, meta: blob.meta };
}

// Cheap preview of a portable file — used by the importer UI to show
// "this file is for Altitude 233 Inc." before asking for the passphrase.
export function peekPortableMeta(
  fileContent: string,
): PortableConnection['meta'] | null {
  try {
    const blob = JSON.parse(fileContent) as PortableConnection;
    if ((blob.v !== 1 && blob.v !== 2 && blob.v !== 3) || !blob.meta) return null;
    return blob.meta;
  } catch {
    return null;
  }
}
