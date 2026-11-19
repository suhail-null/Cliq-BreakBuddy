import { groupUrl, isGroupUrl } from '../config';
import type { Destination, Group, Operation, Profile, Receipt } from '../types';
async function loaded(tabId: number) {
  const initial=await chrome.tabs.get(tabId);
  if(initial.discarded) await chrome.tabs.reload(tabId);
  else if(initial.status === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); };
    const listener = (id: number, info: {status?: string}) => { if (id === tabId && info.status === 'complete') { done(); resolve(); } };
    const timeout = setTimeout(() => {done(); reject(new Error('Cliq did not finish loading. Sign in and retry.'));}, 20_000);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((t: {status:string}) => {if (t.status === 'complete') {done(); resolve();}}).catch(() => {done(); reject(new Error('Cliq tab was closed.'));});
  });
}
async function chooseTab(group: Group, open = false, custom?: Destination | null, forceNew = false): Promise<{id:number;created:boolean}> {
  const tabs = await chrome.tabs.query({url:'https://cliq.zoho.com/*'});
  const exact = !forceNew && tabs.find((t: {url?: string}) => isGroupUrl(t.url ?? '', group,custom));
  if (exact?.id !== undefined) {
    if(open) {await chrome.tabs.update(exact.id,{active:true}); await chrome.windows.update(exact.windowId,{focused:true});}
    await loaded(exact.id); return {id:exact.id,created:false};
  }
  // Login is shared by Chrome tabs in this profile; no pre-existing Cliq tab is necessary.
  // Always create a separate tab rather than navigating the user's current conversation.
  const tab = await chrome.tabs.create({url:groupUrl(group,custom), active:open});
  await loaded(tab.id); return {id:tab.id,created:true};
}
export async function findTab(group: Group, open = false, custom?: Destination | null): Promise<number> {
  return (await chooseTab(group,open,custom)).id;
}
async function connect(tabId: number) {
  try { await chrome.tabs.sendMessage(tabId, {type:'BB_PING'}); }
  catch { await chrome.scripting.executeScript({target:{tabId}, files:['content.js']}); }
}
async function ready(tabId:number,group:Group,profile:Profile,custom?:Destination|null) {
  await connect(tabId);
  const response=await chrome.tabs.sendMessage(tabId,{type:'BB_READY',group,profile,destination:custom});
  if(!response?.ok) throw new Error(response?.error ?? 'Cliq did not initialize the selected conversation.');
}
async function prepareDestination(group:Group,profile:Profile,custom?:Destination|null):Promise<number> {
  const selected=await chooseTab(group,false,custom);
  try {await ready(selected.id,group,profile,custom);return selected.id;}
  catch(error) {
    if(selected.created) throw new Error(`The destination tab could not become ready. Check that Cliq is signed in and online. ${error instanceof Error?error.message:String(error)}`);
    // Cliq can leave a tab's URL pointing at a chat that is no longer selected in its SPA.
    // Before any send, try one new destination tab without disturbing that existing tab.
    const fresh=await chooseTab(group,false,custom,true);
    try {await ready(fresh.id,group,profile,custom);return fresh.id;}
    catch(nextError) {throw new Error(`The destination did not load in the background. Sign in to Cliq or open the destination and retry. ${nextError instanceof Error?nextError.message:String(nextError)}`);}
  }
}
export async function inspect(group: Group, profile: Profile, check = false, custom?: Destination | null) {
  const tabId = check ? await prepareDestination(group,profile,custom) : await findTab(group,false,custom);
  if(!check) await connect(tabId);
  return chrome.tabs.sendMessage(tabId, {type:check ? 'BB_CHECK' : 'BB_INSPECT', group, profile, destination:custom});
}
export async function sendMessage(operation: Operation, profile: Profile): Promise<Receipt> {
  let started = false;
  try {
    const tabId = await prepareDestination(operation.group,profile,operation.destination);
    started = true;
    const result = await chrome.tabs.sendMessage(tabId, {type:'BB_SEND', operation, profile});
    if (!result || result.id !== operation.id || !['confirmed','failed','uncertain'].includes(result.outcome)) throw new Error('Invalid submission response.');
    if(profile.acknowledged==='@fresh-chat' && result.outcome==='uncertain' && result.messageId) {
      // A different newly loaded UI view rules out merely observing the sender's optimistic DOM.
      // No internal API requests or sender-tab reloads are used.
      const verifier=await chrome.tabs.create({url:groupUrl(operation.group,operation.destination),active:false});
      await loaded(verifier.id);await ready(verifier.id,operation.group,profile,operation.destination);
      const proof=await chrome.tabs.sendMessage(verifier.id,{type:'BB_VERIFY',operation,profile,messageId:result.messageId});
      if(!proof?.ok || proof.messageId!==result.messageId) return {...result,detail:'Message appeared locally, but a fresh Cliq view did not confirm it. Check the chat before retrying.'};
      const receipt:Receipt={...result,outcome:'confirmed',detail:'The same own message ID and exact text were found in a fresh Cliq view.',at:Date.now()};
      await chrome.storage.local.set({[`receipt:${operation.id}`]:receipt});
      // Keep the read-only verification tab available for inspection; never close a tab the user might start using.
      return receipt;
    }
    return result;
  } catch (error) {
    return {id:operation.id, outcome:started ? 'uncertain' : 'failed', detail: error instanceof Error ? error.message : String(error), at:Date.now()};
  }
}
