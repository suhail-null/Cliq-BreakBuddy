import type { State } from '../types';
import {panelVisibleInFocusedWindow} from './panelManager';
export async function updateBadge(state: State) {
  const badge = state.backPending ? 'BACK' : state.status === 'BREAK_SCHEDULED' ? 'WAIT' : state.status === 'AVAILABLE' ? '' : '!';
  await chrome.action.setBadgeText({text:badge});
  await chrome.action.setBadgeBackgroundColor({color:state.backPending ? '#d97706' : '#215e54'});
  await chrome.action.setTitle({title:`Cliq BreakBuddy · ${state.status.replaceAll('_',' ')}`});
}
export async function notify(id: string, title: string, message: string, buttons: string[] = []) {
  await chrome.notifications.create(id, {type:'basic', iconUrl:'icons/icon128.png', title, message, priority:2, requireInteraction:true, buttons:buttons.map(title=>({title}))});
}
export async function reminderWindow() {
  // Notifications and the badge still appear; a visible panel already has the Back action.
  if(await panelVisibleInFocusedWindow()) return;
  const url = chrome.runtime.getURL('reminder.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t:{url?:string})=>t.url === url);
  if (existing) return;
  await chrome.windows.create({url, type:'popup', width:440, height:620, focused:false});
}
export async function closeReminder() {
  const url = chrome.runtime.getURL('reminder.html');
  for (const tab of await chrome.tabs.query({})) if (tab.url === url) await chrome.tabs.remove(tab.id).catch(()=>{});
  await chrome.notifications.clear('bb-back');
}
