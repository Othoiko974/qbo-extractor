import { google, sheets_v4 } from 'googleapis';
import { getGoogleClient } from '../oauth-google';

export type ValueInputOption = 'RAW' | 'USER_ENTERED';
export type InsertDataOption = 'OVERWRITE' | 'INSERT_ROWS';
export type CellValue = string | number | boolean | null;
export type CellRow = CellValue[];

export type SheetMeta = {
  spreadsheetId: string;
  title: string;
  sheets: { sheetId: number; title: string; rowCount: number; columnCount: number }[];
};

async function sheetsClient(companyKey: string) {
  const auth = await getGoogleClient(companyKey);
  return google.sheets({ version: 'v4', auth });
}

async function driveClient(companyKey: string) {
  const auth = await getGoogleClient(companyKey);
  return google.drive({ version: 'v3', auth });
}

export async function getSpreadsheetMeta(
  companyKey: string,
  spreadsheetId: string,
): Promise<SheetMeta> {
  const sheets = await sheetsClient(companyKey);
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'spreadsheetId,properties.title,sheets.properties(sheetId,title,gridProperties)',
  });
  return {
    spreadsheetId: res.data.spreadsheetId!,
    title: res.data.properties?.title ?? '',
    sheets: (res.data.sheets ?? []).map((s) => ({
      sheetId: s.properties?.sheetId ?? 0,
      title: s.properties?.title ?? '',
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
      columnCount: s.properties?.gridProperties?.columnCount ?? 0,
    })),
  };
}

export async function readRange(
  companyKey: string,
  spreadsheetId: string,
  range: string,
): Promise<CellRow[]> {
  const sheets = await sheetsClient(companyKey);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  return (res.data.values ?? []) as CellRow[];
}

export async function updateRange(
  companyKey: string,
  spreadsheetId: string,
  range: string,
  values: CellRow[],
  valueInputOption: ValueInputOption = 'USER_ENTERED',
): Promise<{ updatedCells: number; updatedRange: string }> {
  const sheets = await sheetsClient(companyKey);
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption,
    requestBody: { values },
  });
  return {
    updatedCells: res.data.updatedCells ?? 0,
    updatedRange: res.data.updatedRange ?? range,
  };
}

export async function appendRange(
  companyKey: string,
  spreadsheetId: string,
  range: string,
  values: CellRow[],
  valueInputOption: ValueInputOption = 'USER_ENTERED',
  insertDataOption: InsertDataOption = 'INSERT_ROWS',
): Promise<{ updatedCells: number; updatedRange: string }> {
  const sheets = await sheetsClient(companyKey);
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption,
    insertDataOption,
    requestBody: { values },
  });
  return {
    updatedCells: res.data.updates?.updatedCells ?? 0,
    updatedRange: res.data.updates?.updatedRange ?? range,
  };
}

export async function clearRange(
  companyKey: string,
  spreadsheetId: string,
  range: string,
): Promise<{ clearedRange: string }> {
  const sheets = await sheetsClient(companyKey);
  const res = await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range,
    requestBody: {},
  });
  return { clearedRange: res.data.clearedRange ?? range };
}

export async function batchUpdateValues(
  companyKey: string,
  spreadsheetId: string,
  data: { range: string; values: CellRow[] }[],
  valueInputOption: ValueInputOption = 'USER_ENTERED',
): Promise<{ totalUpdatedCells: number }> {
  const sheets = await sheetsClient(companyKey);
  const res = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption,
      data: data.map((d) => ({ range: d.range, values: d.values })),
    },
  });
  return { totalUpdatedCells: res.data.totalUpdatedCells ?? 0 };
}

// Generic structural / formatting batchUpdate. The caller supplies an array of
// Sheets API Request objects (AddSheet, UpdateCells, RepeatCell, etc.). Replies
// are returned in the same order so the caller can read back generated IDs.
export async function batchUpdateSpreadsheet(
  companyKey: string,
  spreadsheetId: string,
  requests: sheets_v4.Schema$Request[],
): Promise<sheets_v4.Schema$Response[]> {
  const sheets = await sheetsClient(companyKey);
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
  return res.data.replies ?? [];
}

export async function addSheet(
  companyKey: string,
  spreadsheetId: string,
  title: string,
  rowCount = 1000,
  columnCount = 26,
): Promise<{ sheetId: number; title: string }> {
  const replies = await batchUpdateSpreadsheet(companyKey, spreadsheetId, [
    {
      addSheet: {
        properties: {
          title,
          gridProperties: { rowCount, columnCount },
        },
      },
    },
  ]);
  const props = replies[0]?.addSheet?.properties;
  return {
    sheetId: props?.sheetId ?? 0,
    title: props?.title ?? title,
  };
}

export async function deleteSheet(
  companyKey: string,
  spreadsheetId: string,
  sheetId: number,
): Promise<void> {
  await batchUpdateSpreadsheet(companyKey, spreadsheetId, [
    { deleteSheet: { sheetId } },
  ]);
}

export async function findReplace(
  companyKey: string,
  spreadsheetId: string,
  find: string,
  replacement: string,
  options: {
    sheetId?: number;
    matchCase?: boolean;
    matchEntireCell?: boolean;
    searchByRegex?: boolean;
    allSheets?: boolean;
  } = {},
): Promise<{ valuesChanged: number; occurrencesChanged: number }> {
  const replies = await batchUpdateSpreadsheet(companyKey, spreadsheetId, [
    {
      findReplace: {
        find,
        replacement,
        matchCase: options.matchCase ?? false,
        matchEntireCell: options.matchEntireCell ?? false,
        searchByRegex: options.searchByRegex ?? false,
        allSheets: options.allSheets ?? !options.sheetId,
        sheetId: options.sheetId,
      },
    },
  ]);
  const r = replies[0]?.findReplace;
  return {
    valuesChanged: r?.valuesChanged ?? 0,
    occurrencesChanged: r?.occurrencesChanged ?? 0,
  };
}

// Drive-side helpers below — Shared Drive support requires `supportsAllDrives`
// on every mutating call, otherwise the API rejects the request when the file
// (or its destination parent) lives on a Shared Drive.

export async function getDriveFile(
  companyKey: string,
  fileId: string,
): Promise<{ id: string; name: string; mimeType: string; driveId?: string; parents?: string[] }> {
  const drive = await driveClient(companyKey);
  const res = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType,driveId,parents',
    supportsAllDrives: true,
  });
  return {
    id: res.data.id!,
    name: res.data.name ?? '',
    mimeType: res.data.mimeType ?? '',
    driveId: res.data.driveId ?? undefined,
    parents: res.data.parents ?? undefined,
  };
}

export async function copyDriveFile(
  companyKey: string,
  fileId: string,
  newName?: string,
  parentFolderId?: string,
): Promise<{ id: string; name: string }> {
  const drive = await driveClient(companyKey);
  const res = await drive.files.copy({
    fileId,
    supportsAllDrives: true,
    requestBody: {
      name: newName,
      parents: parentFolderId ? [parentFolderId] : undefined,
    },
    fields: 'id,name',
  });
  return { id: res.data.id!, name: res.data.name ?? newName ?? '' };
}

export async function renameDriveFile(
  companyKey: string,
  fileId: string,
  newName: string,
): Promise<void> {
  const drive = await driveClient(companyKey);
  await drive.files.update({
    fileId,
    supportsAllDrives: true,
    requestBody: { name: newName },
  });
}
