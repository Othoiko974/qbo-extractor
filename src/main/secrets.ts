import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// Tokens are stored in `<userData>/secrets.json`. Each value is encrypted via
// Electron's safeStorage (Keychain on macOS, libsecret/DPAPI elsewhere).
// This is more reliable than keytar for unsigned builds — no keychain prompt
// that can fail silently with "An unknown error occurred."

export type QboToken = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  refresh_expires_at: number;
  realm_id: string;
  env: 'sandbox' | 'production';
};

export type GoogleToken = {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
};

export type QboAppCreds = {
  client_id: string;
  client_secret: string;
};

type Store = Record<string, string>; // key -> base64-encoded ciphertext (or plain JSON if encryption unavailable)

function storePath(): string {
  return path.join(app.getPath('userData'), 'secrets.json');
}

function readStore(): Store {
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8');
    return JSON.parse(raw) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function encrypt(plaintext: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(plaintext).toString('base64');
  }
  // Fallback: store plaintext (dev only). Better than refusing to save at all.
  return 'raw:' + Buffer.from(plaintext, 'utf-8').toString('base64');
}

function decrypt(stored: string): string | null {
  if (stored.startsWith('enc:')) {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
  }
  if (stored.startsWith('raw:')) {
    return Buffer.from(stored.slice(4), 'base64').toString('utf-8');
  }
  // Legacy: assume raw JSON string.
  return stored;
}

function setValue(key: string, value: string): void {
  const store = readStore();
  store[key] = encrypt(value);
  writeStore(store);
}

function getValue(key: string): string | null {
  const store = readStore();
  const v = store[key];
  if (!v) return null;
  try {
    return decrypt(v);
  } catch {
    return null;
  }
}

function deleteValue(key: string): void {
  const store = readStore();
  if (key in store) {
    delete store[key];
    writeStore(store);
  }
}

export const Secrets = {
  async getQbo(companyKey: string): Promise<QboToken | null> {
    const raw = getValue(`qbo:${companyKey}`);
    return raw ? (JSON.parse(raw) as QboToken) : null;
  },
  async setQbo(companyKey: string, token: QboToken): Promise<void> {
    setValue(`qbo:${companyKey}`, JSON.stringify(token));
  },
  async deleteQbo(companyKey: string): Promise<void> {
    deleteValue(`qbo:${companyKey}`);
  },

  async getQboAppCreds(): Promise<QboAppCreds | null> {
    const raw = getValue('qbo:appCreds');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as QboAppCreds;
    } catch {
      return null;
    }
  },
  async setQboAppCreds(creds: QboAppCreds): Promise<void> {
    setValue('qbo:appCreds', JSON.stringify(creds));
  },
  async deleteQboAppCreds(): Promise<void> {
    deleteValue('qbo:appCreds');
  },

  async getQboProxyApiKey(companyKey: string): Promise<string | null> {
    return getValue(`qbo:proxyApiKey:${companyKey}`);
  },
  async setQboProxyApiKey(companyKey: string, key: string): Promise<void> {
    setValue(`qbo:proxyApiKey:${companyKey}`, key);
  },
  async deleteQboProxyApiKey(companyKey: string): Promise<void> {
    deleteValue(`qbo:proxyApiKey:${companyKey}`);
  },

  async getGoogle(companyKey: string): Promise<GoogleToken | null> {
    const raw = getValue(`google:${companyKey}`);
    return raw ? (JSON.parse(raw) as GoogleToken) : null;
  },
  async setGoogle(companyKey: string, token: GoogleToken): Promise<void> {
    setValue(`google:${companyKey}`, JSON.stringify(token));
  },
  async deleteGoogle(companyKey: string): Promise<void> {
    deleteValue(`google:${companyKey}`);
  },
};
