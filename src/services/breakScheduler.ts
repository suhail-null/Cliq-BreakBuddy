import { BREAK_ALARM, LATE_GRACE_MS, REMINDER_ALARM, WATCHDOG } from '../config';
import type { State } from '../types';
export function dueDecision(state: State, now: number): 'none' | 'wait' | 'send' | 'overdue' {
  if (state.status !== 'BREAK_SCHEDULED' || state.scheduledAt === null) return 'none';
  if (now < state.scheduledAt) return 'wait';
  return now - state.scheduledAt > LATE_GRACE_MS ? 'overdue' : 'send';
}
export function validMinutes(minutes: number) {
  const deadline=Date.now()+minutes*60_000;
  return Number.isSafeInteger(minutes) && minutes>=1 && Number.isSafeInteger(deadline) && deadline<=8.64e15;
}
export async function restoreAlarms(state: State) {
  if (!(await chrome.alarms.get(WATCHDOG))) await chrome.alarms.create(WATCHDOG, {periodInMinutes: 1});
  if (state.status === 'BREAK_SCHEDULED' && state.scheduledAt && state.scheduledAt > Date.now()) {
    await chrome.alarms.create(BREAK_ALARM, {when: state.scheduledAt});
  } else await chrome.alarms.clear(BREAK_ALARM);
  if (state.backPending) {
    const when = Math.max(Date.now() + 30_000, state.snoozeUntil ?? (state.lastReminderAt ?? Date.now()) + 5 * 60_000);
    const existing = await chrome.alarms.get(REMINDER_ALARM);
    if(!existing || (state.snoozeUntil && Math.abs(existing.scheduledTime - when)>1000)) await chrome.alarms.create(REMINDER_ALARM, {when});
  } else await chrome.alarms.clear(REMINDER_ALARM);
}
