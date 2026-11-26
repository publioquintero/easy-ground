import type { TimeWindow } from '@easy-ground/core';

/** "14:00" → "2 PM", "14:30" → "2:30 PM". */
export function formatHhmm(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`;
}

/** {14:00, 17:00} → "2–5 PM"; {11:30, 13:00} → "11:30 AM–1 PM". */
export function formatWindow(w: TimeWindow): string {
  const from = formatHhmm(w.from);
  const to = formatHhmm(w.to);
  const fromSuffix = from.slice(-2);
  return fromSuffix === to.slice(-2) ? `${from.slice(0, -3)}–${to}` : `${from}–${to}`;
}

/** 16:00 today as epoch ms → "4:00 PM". */
export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
