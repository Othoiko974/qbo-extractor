import * as XLSX from 'xlsx';
import type { BudgetRow } from '../../types/domain';
import { parseBudgetSheets } from './parser';

export function readExcelBudget(filePath: string): BudgetRow[] {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheets: { name: string; rows: Record<string, unknown>[] }[] = wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: false });
    return { name, rows };
  });
  return parseBudgetSheets(sheets);
}
