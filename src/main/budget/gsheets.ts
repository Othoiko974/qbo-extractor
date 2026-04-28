import { google } from 'googleapis';
import type { BudgetRow } from '../../types/domain';
import { getGoogleClient } from '../oauth-google';
import { parseBudgetSheets } from './parser';

export type Workbook = {
  id: string;
  name: string;
  modifiedTime: string;
  sheetCount?: number;
};

export async function listWorkbooks(companyKey: string): Promise<Workbook[]> {
  const auth = await getGoogleClient(companyKey);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: 'files(id,name,modifiedTime)',
    pageSize: 50,
    orderBy: 'modifiedTime desc',
  });
  return (res.data.files ?? []).map((f) => ({
    id: f.id!,
    name: f.name ?? 'Sans titre',
    modifiedTime: f.modifiedTime ?? '',
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
