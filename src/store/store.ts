import { create } from 'zustand';
import type {
  Company,
  Project,
  BudgetRow,
  ExtractionRow,
  ExtractionStatus,
  Screen,
  VendorCluster,
  RunRowCandidate,
  SisterCandidate,
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
  // Project records loaded from main. Lives in the global store so the
  // sidebar header, Settings → Projets section, and any other consumer
  // stay in sync after rename / create / delete without each component
  // having to wire its own re-fetch trigger.
  projects: Project[];
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
  // Sister-company candidates loaded on demand via the resolver's
  // "Chercher dans les autres compagnies" button. Empty until the user
  // triggers the search; lives in memory only (not persisted to DB).
  resolverSisterCandidates: SisterCandidate[];
  resolverSisterLoading: boolean;
  resolverSisterSearched: boolean;

  // Sliding-window of timestamps for QBO API requests (one entry per Intuit
  // /v3 hit; signed-URL CDN downloads are filtered upstream). Lives at the
  // store level so the cadence chip on Extraction stays accurate across
  // run boundaries AND screen navigation — Intuit's 500/min/realm rate
  // limit is server-side over a rolling 60 s window, so a fresh local
  // count would under-report the budget when relaunching within the minute.
  qboRequestTimes: number[];
  pushQboRequestTime: (ts: number) => void;

  // Cross-machine extraction lock state. Populated when startExtraction
  // hits a 409 from the proxy — the dialog reads this and offers to wait
  // (poll the proxy every 10 s) or cancel. Cleared once the lock frees
  // and the run actually starts.
  busyLock: {
    api_key_label: string;
    total_rows: number;
    estimated_requests: number;
    started_at: number;
    last_heartbeat: number;
    eta_seconds: number;
    pendingRowIds: string[]; // remembered so we can retry when free
  } | null;
  dismissBusyLock: () => void;
  retryBusyLock: () => Promise<void>;

  setScreen: (s: Screen) => void;
  openPreview: (filePath: string) => void;
  openResolver: (rowId: string) => Promise<void>;
  closeResolver: () => void;
  resolveCandidate: (
    txnId: string,
    txnType: 'Bill' | 'Purchase' | 'Invoice',
    fetchFromCompanyKey?: string,
  ) => Promise<void>;
  searchInSisters: () => Promise<void>;
  setActiveCompany: (k: string | null) => void;
  dismissClusters: () => void;
  confirmClusters: (entries: { rawName: string; canonicalName: string }[]) => Promise<void>;

  loadCompanies: () => Promise<void>;
  loadProjects: () => Promise<void>;
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
  projects: [],
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
  resolverSisterCandidates: [],
  resolverSisterLoading: false,
  resolverSisterSearched: false,
  qboRequestTimes: [],
  busyLock: null,

  pushQboRequestTime: (ts) =>
    set((s) => {
      const cutoff = Date.now() - 60_000;
      const next = s.qboRequestTimes.filter((t) => t > cutoff);
      next.push(ts);
      return { qboRequestTimes: next };
    }),

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
      resolverSisterCandidates: [],
      resolverSisterLoading: false,
      resolverSisterSearched: false,
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
  closeResolver: () =>
    set({
      resolverRowId: null,
      resolverCandidates: [],
      resolverError: null,
      resolverSisterCandidates: [],
      resolverSisterLoading: false,
      resolverSisterSearched: false,
      screen: 'review',
    }),
  resolveCandidate: async (txnId, txnType, fetchFromCompanyKey) => {
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
      fetchFromCompanyKey,
    })) as { ok: boolean; status?: ExtractionStatus; filePath?: string; error?: string };
    if (!res.ok) {
      set({ resolverLoading: false, resolverError: res.error ?? 'Échec du téléchargement.' });
      return;
    }
    set({
      resolverLoading: false,
      resolverRowId: null,
      resolverCandidates: [],
      resolverSisterCandidates: [],
      resolverSisterLoading: false,
      resolverSisterSearched: false,
      screen: 'review',
    });
  },
  searchInSisters: async () => {
    const state = get();
    const rowId = state.resolverRowId;
    const companyKey = state.activeCompanyKey;
    const row = state.extraction.find((r) => r.id === rowId);
    if (!rowId || !row || !companyKey) return;
    set({ resolverSisterLoading: true, resolverError: null });
    try {
      const res = (await window.qboApi.searchInSisters(
        companyKey,
        row.docNumber,
      )) as { ok: boolean; results?: SisterCandidate[]; error?: string };
      if (!res.ok) {
        set({
          resolverSisterLoading: false,
          resolverSisterSearched: true,
          resolverError: res.error ?? 'Échec de la recherche dans les autres compagnies.',
        });
        return;
      }
      set({
        resolverSisterCandidates: res.results ?? [],
        resolverSisterLoading: false,
        resolverSisterSearched: true,
      });
    } catch (err) {
      set({
        resolverSisterLoading: false,
        resolverSisterSearched: true,
        resolverError: err instanceof Error ? err.message : String(err),
      });
    }
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
    // First-time launch: pick the first *real* company as active so the
    // user doesn't land on the disconnected fallback bucket. We only
    // fall through to an owner if no real sister exists yet — same
    // result as the legacy behavior in that edge case.
    if (!get().activeCompanyKey && list.length > 0) {
      const firstReal = list.find((c) => !c.isProjectOwner) ?? list[0];
      set({ activeCompanyKey: firstReal.key });
      void get().loadBudget(firstReal.key);
    }
    // Onboarding screen only triggers when there's *nothing* — owners
    // alone count as nothing real.
    if (list.length === 0 || list.every((c) => c.isProjectOwner)) {
      set({ screen: 'onboarding' });
    }
  },

  loadProjects: async () => {
    const list = (await window.qboApi.projectsList()) as Project[];
    set({ projects: list });
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
      busyLock: null,
    });
    const res = (await window.qboApi.extractionStart(key, rowIds)) as {
      ok: boolean;
      runId?: string;
      error?: string;
      busy?: {
        api_key_label: string;
        total_rows: number;
        estimated_requests: number;
        started_at: number;
        last_heartbeat: number;
        eta_seconds: number;
      };
    };
    if (res.busy) {
      // Another teammate holds the lock. Park the row selection so the
      // "Attendre" path can retry once the lock frees, and roll the UI
      // back to dashboard so the user isn't stuck on an empty Extraction
      // screen mid-modal.
      set({
        running: false,
        busyLock: { ...res.busy, pendingRowIds: rowIds },
        screen: 'dashboard',
      });
      return;
    }
    if (!res.ok) {
      set({ running: false, error: res.error ?? 'Démarrage impossible.' });
      return;
    }
    set({ runId: res.runId ?? null });
  },

  dismissBusyLock: () => set({ busyLock: null }),

  retryBusyLock: async () => {
    const lock = get().busyLock;
    if (!lock) return;
    await get().startExtraction(lock.pendingRowIds);
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
  void store.loadProjects();
  void store.loadSettings();
  window.qboApi.onExtractionUpdate((u) => {
    useStore.getState().applyUpdate(u as ExtractionUpdate);
  });
  // Subscribe at app boot so the cadence chip survives screen unmounts and
  // run boundaries — needed to honor Intuit's rolling-60 s rate limit.
  window.qboApi.onQboRequest((evt) => {
    useStore.getState().pushQboRequestTime(evt.ts);
  });
}
