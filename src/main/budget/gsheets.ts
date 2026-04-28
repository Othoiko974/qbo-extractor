import { google } from 'googleapis';
import type { BudgetRow } from '../../types/domain';
import { getGoogleClient } from '../oauth-google';
import { parseBudgetSheets } from './parser';

export type Workbook = {
  id: string;
  name: string;
  modifiedTime: string;
  driveId?: string;
  sheetCount?: number;
};

export type SharedDrive = {
  id: string;
  name: string;
};

// `corpora: 'allDrives'` + `includeItemsFromAllDrives: true` is the combination
// required by Drive API V3 to surface files that live in a Shared Drive
// ("Drive entreprise") alongside the user's own Drive. `supportsAllDrives` must
// also be set on every read so the call is accepted when the file resolves to
// a Shared Drive.
export async function listWorkbooks(
  companyKey: string,
  driveId?: string,
): Promise<Workbook[]> {
  const auth = await getGoogleClient(companyKey);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: 'files(id,name,modifiedTime,driveId)',
    pageSize: 100,
    orderBy: 'modifiedTime desc',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: driveId ? 'drive' : 'allDrives',
    driveId: driveId ?? undefined,
  });
  return (res.data.files ?? []).map((f) => ({
    id: f.id!,
    name: f.name ?? 'Sans titre',
    modifiedTime: f.modifiedTime ?? '',
    driveId: f.driveId ?? undefined,
  }));
}

export async function listSharedDrives(companyKey: string): Promise<SharedDrive[]> {
  const auth = await getGoogleClient(companyKey);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.drives.list({
    fields: 'drives(id,name)',
    pageSize: 100,
  });
  return (res.data.drives ?? []).map((d) => ({
    id: d.id!,
    name: d.name ?? 'Drive sans nom',
  }));
}

export async function readBudget(companyKey: string, spreadsheetId: string): Promise<BudgetRow[]> {
  const auth = await getGoogleClient(companyKey);
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetTitles = (meta.data.sheets ?? []).map((s) => s.properties?.title).filter((t): t is string => !!t);

  const input: { name: string; rows: Record<string, unknown>[] }[] = [];
  for (const title of sheetTitles) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${title}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const values = res.data.values ?? [];
    if (values.length < 2) continue;
    const [headers, ...rest] = values;
    const rows = rest.map((row) => {
      const obj: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        obj[String(h)] = row[i] ?? null;
      });
      return obj;
    });
    input.push({ name: title, rows });
  }
  return parseBudgetSheets(input);
}
