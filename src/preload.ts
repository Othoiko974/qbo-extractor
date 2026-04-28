import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // Companies
  listCompanies: () => ipcRenderer.invoke('companies:list'),
  addCompany: (payload: unknown) => ipcRenderer.invoke('companies:add', payload),
  updateCompany: (key: string, patch: unknown) => ipcRenderer.invoke('companies:update', key, patch),
  deleteCompany: (key: string) => ipcRenderer.invoke('companies:delete', key),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Record<string, string>) => ipcRenderer.invoke('settings:update', patch),

  // QBO OAuth
  qboConnect: (companyKey: string, env?: 'sandbox' | 'production') =>
    ipcRenderer.invoke('qbo:connect', companyKey, env ?? 'sandbox'),
  qboDisconnect: (companyKey: string) => ipcRenderer.invoke('qbo:disconnect', companyKey),
  qboPickTokenFile: () => ipcRenderer.invoke('qbo:pickTokenFile'),
  qboImportToken: (
    companyKey: string,
    filePath: string,
    realmId: string,
    env?: 'sandbox' | 'production',
  ) => ipcRenderer.invoke('qbo:importToken', companyKey, filePath, realmId, env ?? 'production'),
  qboTest: (companyKey: string) => ipcRenderer.invoke('qbo:test', companyKey),
  qboGetAppCredsStatus: () => ipcRenderer.invoke('qbo:getAppCredsStatus'),
  qboSetAppCreds: (clientId: string, clientSecret: string) =>
    ipcRenderer.invoke('qbo:setAppCreds', clientId, clientSecret),
  qboDeleteAppCreds: () => ipcRenderer.invoke('qbo:deleteAppCreds'),

  // Google OAuth + Sheets
  googleConnect: (companyKey: string) => ipcRenderer.invoke('google:connect', companyKey),
  googleDisconnect: (companyKey: string) => ipcRenderer.invoke('google:disconnect', companyKey),
  googleListWorkbooks: (companyKey: string) => ipcRenderer.invoke('google:listWorkbooks', companyKey),
  googlePickWorkbook: (companyKey: string, workbookId: string, workbookName: string) =>
    ipcRenderer.invoke('google:pickWorkbook', companyKey, workbookId, workbookName),

  // Excel
  excelPickFile: () => ipcRenderer.invoke('excel:pickFile'),
  excelSetFile: (companyKey: string, filePath: string) =>
    ipcRenderer.invoke('excel:setFile', companyKey, filePath),

  // Budget
  readBudget: (companyKey: string) => ipcRenderer.invoke('budget:read', companyKey),
  resyncBudget: (companyKey: string) => ipcRenderer.invoke('budget:resync', companyKey),

  // Vendor aliases
  listVendorAliases: (companyKey: string) => ipcRenderer.invoke('vendors:list', companyKey),
  upsertVendorAlias: (companyKey: string, rawName: string, canonicalName: string) =>
    ipcRenderer.invoke('vendors:upsert', companyKey, rawName, canonicalName),
  upsertVendorAliases: (
    companyKey: string,
    entries: { rawName: string; canonicalName: string }[],
  ) => ipcRenderer.invoke('vendors:upsertMany', companyKey, entries),
  deleteVendorAlias: (companyKey: string, rawName: string) =>
    ipcRenderer.invoke('vendors:delete', companyKey, rawName),
  renameVendorCanonical: (companyKey: string, oldName: string, newName: string) =>
    ipcRenderer.invoke('vendors:rename', companyKey, oldName, newName),

  // Extraction
  extractionStart: (companyKey: string, rowIds: string[]) =>
    ipcRenderer.invoke('extraction:start', companyKey, rowIds),
  extractionPause: () => ipcRenderer.invoke('extraction:pause'),
  extractionResume: () => ipcRenderer.invoke('extraction:resume'),
  extractionStop: () => ipcRenderer.invoke('extraction:stop'),
  onExtractionUpdate: (cb: (update: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, update: unknown) => cb(update);
    ipcRenderer.on('extraction:update', handler);
    return () => ipcRenderer.removeListener('extraction:update', handler);
  },
  onQboRequest: (
    cb: (evt: { ts: number; method: string; status: number; endpoint: string }) => void,
  ): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, evt: unknown) =>
      cb(evt as { ts: number; method: string; status: number; endpoint: string });
    ipcRenderer.on('qbo:request', handler);
    return () => {
      ipcRenderer.removeListener('qbo:request', handler);
    };
  },

  // Runs
  listRuns: (companyKey: string) => ipcRenderer.invoke('runs:list', companyKey),
  listRunRows: (runId: string) => ipcRenderer.invoke('runs:rows', runId),

  setEntityAliases: (key: string, aliases: string[]) =>
    ipcRenderer.invoke('companies:setEntityAliases', key, aliases),

  // Ambiguous resolver
  listCandidates: (runRowId: string) =>
    ipcRenderer.invoke('extraction:listCandidates', runRowId),
  resolveCandidate: (args: {
    runRowId: string;
    rowId: string;
    txnId: string;
    txnType: 'Bill' | 'Purchase' | 'Invoice';
    companyKey: string;
  }) => ipcRenderer.invoke('extraction:resolveCandidate', args),
  dismissCandidates: (runRowId: string) =>
    ipcRenderer.invoke('extraction:dismissCandidates', runRowId),

  // Filesystem
  openFolder: (p: string) => ipcRenderer.invoke('fs:openFolder', p),
  openUrl: (url: string) => ipcRenderer.invoke('fs:openUrl', url),
  revealFile: (p: string) => ipcRenderer.invoke('fs:revealFile', p),
  openFile: (p: string) => ipcRenderer.invoke('fs:openFile', p),
  listExtractedFiles: (companyKey: string) =>
    ipcRenderer.invoke('fs:listExtractedFiles', companyKey),
  pickFolder: () => ipcRenderer.invoke('fs:pickFolder'),

  // Logs
  logsOpen: () => ipcRenderer.invoke('logs:open'),
  logsTail: (lines?: number) => ipcRenderer.invoke('logs:tail', lines),
};

export type QboExtractorApi = typeof api;

contextBridge.exposeInMainWorld('qboApi', api);
