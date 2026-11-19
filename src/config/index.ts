import type { Destination, Group, Profile, State } from '../types';
// Structure observed in the user's three authenticated DOM reports. Reserved @ modes are not CSS.
export const CLIQ_PROFILE: Profile = {
  root:'.currentchat.selcht',chatIdAttribute:'id',header:'.zctle[chid]',
  editor:'.ProseMirror[contenteditable="true"]',send:'@cliq-enter',
  row:'.msgtxt[msguid][id]',rowIdAttribute:'msguid',body:':scope > pre.zcmsgcnt',
  own:'.msgtxt.me[mymsg]',acknowledged:'@fresh-chat',
};
export const BASE = 'https://cliq.zoho.com/company/717321507';
export const GROUPS = {
  // Legacy internal alias; the personal testing destination is no longer shipped.
  test: {name: 'Retired destination', id: 'CT_retired_destination'},
  production: {name: 'MarTech', id: 'CT_1424876136100496778_717321507'},
} as const;
export function parseCustomDestination(url: string, name: string): Destination {
  const u = new URL(url.trim());
  const match = u.pathname.match(/^\/company\/717321507\/(?:chats|channels)\/([A-Za-z0-9_-]+)\/?$/);
  if(u.origin !== 'https://cliq.zoho.com' || u.username || u.password || u.search || u.hash || !match) throw new Error('Paste a direct chat/channel URL from your company on https://cliq.zoho.com, without query parameters or a fragment.');
  const title = name.trim().replace(/^#\s*/, '');
  if(!title || title.length>100) throw new Error('Enter the exact chat/channel title (up to 100 characters).');
  return {name:title,id:match[1],url:`${u.origin}${u.pathname.replace(/\/$/, '')}`};
}
export function destinationFor(group: Group, custom?: Destination | null): Destination {
  if(group==='custom') {
    if(!custom) throw new Error('Configure a custom destination first.');
    return parseCustomDestination(custom.url,custom.name);
  }
  return {...GROUPS[group],url:`${BASE}/chats/${GROUPS[group].id}`};
}
export const groupUrl = (g: Group, custom?: Destination | null) => destinationFor(g,custom).url;
export function isGroupUrl(url: string, group: Group, custom?: Destination | null) {
  try { const u = new URL(url); return u.origin === 'https://cliq.zoho.com' && u.pathname.replace(/\/$/, '') === new URL(groupUrl(group,custom)).pathname; } catch { return false; }
}
export const BREAK_ALARM = 'breakbuddy-break';
export const REMINDER_ALARM = 'breakbuddy-reminder';
export const WATCHDOG = 'breakbuddy-recovery';
export const LATE_GRACE_MS = 60_000;
export const defaultState = (): State => ({
  version: 1, group: 'production', productionEnabled: false, customDestination:null,
  profile: {...CLIQ_PROFILE},
  status:'AVAILABLE', scheduledAt:null, breakSentAt:null, backPending:false, lastBackAt:null,
  snoozeUntil:null, lastReminderAt:null, operation:null, submission:'none', error:null, history:[],
});
