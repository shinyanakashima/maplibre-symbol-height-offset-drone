export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function m(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)} m`;
}

export function n(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

export const STATUS_LABEL: Record<string, string> = {
  ok: '確定',
  reference: '参考',
  unsupported: '未対応',
};

/** droneEnumValue / droneSubEnumValue から機種名（分かる範囲） */
export function droneName(e: number | null, sub: number | null): string {
  if (e === null) return '不明';
  if (e === 77) {
    const s: Record<number, string> = { 0: 'Mavic 3E', 1: 'Mavic 3T', 2: 'Mavic 3M', 3: 'Mavic 3TA' };
    return `${s[sub ?? -1] ?? 'Mavic 3 Enterprise シリーズ'}（${e}-${sub ?? '?'}）`;
  }
  const known: Record<number, string> = { 60: 'M300 RTK', 67: 'M30/M30T', 89: 'M350 RTK', 91: 'M3D/M3TD', 99: 'M4E/M4T', 100: 'M4D/M4TD', 103: 'M400', 130: 'M5TD' };
  return known[e] ? `${known[e]}（${e}-${sub ?? '?'}）` : `機種コード ${e}-${sub ?? '?'}`;
}
