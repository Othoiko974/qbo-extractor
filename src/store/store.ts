import { create } from 'zustand';
import type {
  Company,
  BudgetRow,
  ExtractionRow,
  ExtractionStatus,
  Screen,
  VendorCluster,
  RunRowCandidate,
} from '../types/domain';

// Backend-shaped company (more fields than the UI type).
export type BackendCompany = Company & {
  qboEnv?: 'sandbox' | 'production';
  gsheetsWorkbookId?: string | null;
  gsheetsWorkbookName?: string | null;
  gsheetsEmail?: string | null;
  excelPath?: string | null;
  gsheetsConnected?: boolean;
};

export type ExtractionUpdate = {
  runId: string;
  rowId: string;
  runRowId?: string;
  status: ExtractionStatus;
  filePath?: string;
  txnId?: string;
  txnType?: 'Bill' | 'Purchase' | 'Invoice';
  error?: string;
  counts: { ok: number; amb: number; nf: number; nopj: number; total: number; done: number };
  finished?: boolean;
};

type Store = {
  companies: BackendCompany[];
  activeCompanyKey: string | null;
  screen: Screen;
  budget: BudgetRow[];
  extraction: ExtractionRow[];
  lastSync: number | null;
  settings: Record<string, string>;
  runId: string | null;
  running: boolean;
  paused: boolean;
  loading: boolean;
  error: string | null;
  counts: { ok: number; amb: number; nf: number; nopj: number; total: number; done: number };
  pendingClusters: VendorCluster[];
  previewFilePath: string | null;
  // Resolver state — set when the user clicks "Choisir" on an amb row.
  resolverRowId: string | null;
  resolverCandidates: RunRowCandidate[];
  resolverLoading: boolean;
  resolverError: string | null;

  setScreen: (s: Screen) => void;
  openPreview: (filePath: string) => void;
  openResolver: (rowId: string) => Promise<void>;
  closeResolver: () => void;
  resolveCandidate: (txnId: string, txnType: 'Bill' | 'Purchase' | 'Invoice') => Promise<void>;
  setActiveCompany: (k: string | null) => void;
  dismissClusters: () => void;
  confirmClusters: (entries: { rawName: string; canonicalName: string }[]) => Promise<void>;

  loadCompanies: () => Promise<void>;
  loadSettings: () => Promise<void>;
  loadBudget: (companyKey: string) => Promise<void>;
  resyncBudget: () => Promise<void>;
  startExtraction: (rowIds: string[]) => Promise<void>;
  pauseExtraction: () => Promise<void>;
  resumeExtraction: () => Promise<void>;
  stopExtraction: () => Promise<void>;
  applyUpdate: (u: ExtractionUpdate) => void;
  updateSettings: (patch: Record<string, string>) => Promise<void>;
  setError: (msg: string | null) => void;
};

export const useStore = create<Store>((set, get) => ({
  companies: [],
  activeCompanyKey: null,
  screen: 'dashboard',
  budget: [],
  extraction: [],
  lastSync: null,
  settings: {},
  runId: null,
  running: false,
  paused: false,
  loading: false,
  error: null,
  counts: { ok: 0, amb: 0, nf: 0, nopj: 0, total: 0, done: 0 },
  pendingClusters: [],
  previewFilePath: null,
  resolverRowId: null,
  resolverCandidates: [],
  resolverLoading: false,
  resolverError: null,

  setScreen: (screen) => set({ screen }),
  openPreview: (filePath) => set({ previewFilePath: filePath, screen: 'preview' }),
  openResolver: async (rowId) => {
    const row = get().extraction.find((r) => r.id === rowId);
    if (!row || !row.runRowId) {
      set({ resolverError: 'Aucun candidat enregistré pour cette ligne.' });
      return;
    }
    set({
      resolverRowId: rowId,
      resolverCandidates: [],
      resolverLoading: true,
      resolverError: null,
      screen: 'resolver',
    });
    try {
      const candidates = (await window.qboApi.listCandidates(row.runRowId)) as RunRowCandidate[];
      set({ resolverCandidates: candidates, resolverLoading: false });
    } catch (err) {
      set({
        resolverLoading: false,
        resolverError: err instanceof Error ? err.message : String(err),
      });
    }
  },
  closeResolver: () => set({ resolverRowId: null, resolverCandidates: [], resolverError: null, screen: 'review' }),
  resolveCandidate: async (txnId, txnType) => {
    const state = get();
    const rowId = state.resolverRowId;
    const companyKey = state.activeCompanyKey;
    const row = state.extraction.find((r) => r.id === rowId);
    if (!rowId || !row || !row.runRowId || !companyKey) return;
    set({ resolverLoading: true, resolverError: null });
    const res = (await window.qboApi.resolveCandidate({
      runRowId: row.runRowId,
      rowId,
      txnId,
      txnType,
      companyKey,
    })) as { ok: boolean; status?: ExtractionStatus; filePath?: string; error?: string };
    if (!res.ok) {
      set({ resolverLoading: false, resolverError: res.error ?? 'Échec du téléchargement.' });
      return;
    }
    set({
      resolverLoading: false,
      resolverRowId: null,
      resolverCandidates: [],
      screen: 'review',
    });
  },
  dismissClusters: () => set({ pendingClusters: [] }),
  confirmClusters: async (entries) => {
    const key = get().activeCompanyKey;
    if (!key || entries.length === 0) {
      set({ pendingClusters: [] });
      return;
    }
    await window.qboApi.upsertVendorAliases(key, entries);
    set({ pendingClusters: [] });
    await get().resyncBudget();
  },
  setActiveCompany: (activeCompanyKey) => {
    set({ activeCompanyKey });
    if (activeCompanyKey) void get().loadBudget(activeCompanyKey);
    else set({ budget: [], extraction: [] });
  },

  setError: (error) => set({ error }),

  loadCompanies: async () => {
    const list = (await window.qboApi.listCompanies()) as BackendCompany[];
    set({ companies: list });
    if (!get().activeCompanyKey && list.length > 0) {
      set({ activeCompanyKey: list[0].key });
      void get().loadBudget(list[0].key);
    }
    if (list.length === 0) set({ screen: 'onboarding' });
  },

  loadSettings: async () => {
    const s = (await window.qboApi.getSettings()) as Record<string, string>;
    set({ settings: s });
  },

  loadBudget: async (companyKey: string) => {
    set({ loading: true, error: null });
    const res = (await window.qboApi.readBudget(companyKey)) as {
      ok: boolean;
      rows?: BudgetRow[];
      lastSync?: number | null;
      error?: string;
    };
    if (!res.ok) {
      set({ loading: false, error: res.error ?? null, budget: [] });
      return;
    }
    set({ budget: res.rows ?? [], lastSync: res.lastSync ?? null, loading: false });
  },

  resyncBudget: async () => {
    const key = get().activeCompanyKey;
    if (!key) return;
    set({ loading: true, error: null });
    const res = (await window.qboApi.resyncBudget(key)) as {
      ok: boolean;
      rows?: BudgetRow[];
      lastSync?: number;
      clusters?: VendorCluster[];
      error?: string;
    };
    if (!res.ok) {
      set({ loading: false, error: res.error ?? 'Échec de la synchronisation.' });
      return;
    }
    set({
      budget: res.rows ?? [],
      lastSync: res.lastSync ?? Date.now(),
      loading: false,
      pendingClusters: res.clusters ?? [],
    });
  },

  startExtraction: async (rowIds: string[]) => {
    const key = get().activeCompanyKey;
    if (!key) return;
    const budget = get().budget;
    const selected = rowIds.length > 0 ? budget.filter((r) => rowIds.includes(r.id)) : budget;
    const initial: ExtractionRow[] = selected.map((r) => ({ ...r, status: 'queue' }));
    set({
      extraction: initial,
      counts: { ok: 0, amb: 0, nf: 0, nopj: 0, total: selected.length, done: 0 },
      running: true,
      paused: false,
      screen: 'extraction',
      error: null,
    });
    const res = (await window.qboApi.extractionStart(key, rowIds)) as {
      ok: boolean;
      runId?: string;
      error?: string;
    };
    if (!res.ok) {
      set({ running: false, error: res.error ?? 'Démarrage impossible.' });
      return;
    }
    set({ runId: res.runId ?? null });
  },

  pauseExtraction: async () => {
    await window.qboApi.extractionPause();
    set({ paused: true });
  },
  resumeExtraction: async () => {
    await window.qboApi.extractionResume();
    set({ paused: false });
  },
  stopExtraction: async () => {
    await window.qboApi.extractionStop();
    set({ running: false, paused: false });
  },

  applyUpdate: (u: ExtractionUpdate) => {
    const state = get();
    const extraction = state.extraction.map((r) =>
      r.id === u.rowId
        ? {
            ...r,
            status: u.status,
            runRowId: u.runRowId ?? r.runRowId,
            qboTxnId: u.txnId ?? r.qboTxnId,
            qboTxnType: u.txnType ?? r.qboTxnType,
            resultFilePath: u.filePath ?? r.resultFilePath,
            resultFileName: u.filePath ? u.filePath.split('/').pop() : r.resultFileName,
          }
        : r,
    );
    set({
      extraction,
      counts: u.counts,
      running: !u.finished,
    });
  },

  updateSettings: async (patch: Record<string, string>) => {
    const next = (await window.qboApi.updateSettings(patch)) as Record<string, string>;
    set({ settings: next });
  },
}));

export function initStore() {
  const store = useStore.getState();
  void store.loadCompanies();
  void store.loadSettings();
  window.qboApi.onExtractionUpdate((u) => {
    useStore.getState().applyUpdate(u as ExtractionUpdate);
  });
}
