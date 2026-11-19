import { destinationFor, isGroupUrl } from '../config';
import type { Destination, Group, Profile } from '../types';
export function visible(el: Element): boolean {
  const style = getComputedStyle(el);
  return style.display!=='none' && style.visibility!=='hidden' && el.getClientRects().length>0;
}
export function unique(scope: ParentNode, selector: string): HTMLElement {
  if(!selector.trim()) throw new Error('Selector setup is incomplete. Open Settings.');
  const all = [...scope.querySelectorAll<HTMLElement>(selector)].filter(visible);
  if(all.length!==1) throw new Error(`Expected one visible element for ${selector}; found ${all.length}. No send attempted.`);
  return all[0];
}
export function validate(profile: Profile, group: Group, url = location.href, custom?: Destination) {
  if(!isGroupUrl(url,group,custom)) throw new Error('Destination URL does not match the configured group.');
  const destination = destinationFor(group,custom);
  const missing=Object.entries(profile).filter(([,value])=>!value.trim()).map(([key])=>key);
  if(missing.length) throw new Error(`Setup incomplete: ${missing.join(', ')}. Click Inspect Cliq to detect available controls; download the diagnostics if fields are still missing.`);
  const root = unique(document,profile.root);
  if(root.getAttribute(profile.chatIdAttribute)!==destination.id) throw new Error('Active chat identity does not match the destination.');
  const header = unique(root,profile.header);
  if(header.textContent?.trim().replace(/^#\s*/, '')!==destination.name) throw new Error('Active chat title does not match the destination.');
  const editor = unique(root,profile.editor);
  if(!(editor.isContentEditable || editor instanceof HTMLTextAreaElement || (editor instanceof HTMLInputElement && editor.type==='text'))) throw new Error('Configured editor is not editable.');
  if(editor.closest('[role="dialog"]')) throw new Error('A dialog editor cannot be used.');
  if(editor.getAttribute('aria-disabled')==='true' || editor.matches(':disabled')) throw new Error('The message editor is disabled.');
  // Check all profile selectors before touching the editor.
  root.querySelectorAll(profile.row); root.querySelectorAll(profile.body);
  root.querySelectorAll(profile.own);
  if(profile.acknowledged!=='@fresh-chat') root.querySelectorAll(profile.acknowledged);
  return {root,editor};
}
export function draft(editor: HTMLElement) {
  return editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement ? editor.value : plainText(editor);
}
// Cliq may represent line breaks as text, <br>, or ProseMirror paragraphs.
export function plainText(element:Element):string {
  const read=(node:Node):string=>{
    if(node.nodeType===Node.TEXT_NODE)return node.textContent??'';
    if(node instanceof Element && node.tagName==='BR')return '\n';
    const children=[...node.childNodes];
    if(node instanceof Element && node.matches('p,div') && children.length===1 && children[0] instanceof Element && children[0].tagName==='BR')return '';
    return children.map((child,index)=>read(child)+(child instanceof Element && child.matches('p,div') && index<children.length-1?'\n':'')).join('');
  };
  return read(element).replace(/\r\n?/g,'\n');
}
export function hasDraft(editor: HTMLElement) {
  return draft(editor).replace(/\u200b/g,'').trim().length>0 || !!editor.querySelector('img,video,audio,[data-attachment]');
}
export function messageIds(root: HTMLElement, p: Profile) {
  return new Set([...root.querySelectorAll(p.row)].map(row=>row.getAttribute(p.rowIdAttribute)).filter(Boolean));
}
export function confirmedRow(root: HTMLElement, p: Profile, text: string, before: Set<string|null>): string | null {
  const matches = [...root.querySelectorAll(p.row)].filter(row=> {
    const id = row.getAttribute(p.rowIdAttribute);
    const body = [...row.querySelectorAll(p.body)];
    const evidence=p.acknowledged==='@fresh-chat'
      ? /^\d{10,16}_\d+$/.test(row.id) && row.getAttribute('chid')===root.getAttribute(p.chatIdAttribute) &&
        !row.matches('.dltinfomsg,.pending,.sending,.failed,.unsent,[aria-busy="true"],[data-status="pending"],[data-status="sending"],[data-status="failed"]')
      : row.matches(p.acknowledged) || !!row.querySelector(p.acknowledged);
    return id && !before.has(id) && row.matches(p.own) && body.length===1 && plainText(body[0]).trim()===text && evidence;
  });
  return matches.length===1 ? matches[0].getAttribute(p.rowIdAttribute) : null;
}
export function waitFor<T>(read:()=>T | null, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve,reject)=> {
    let observer: MutationObserver | undefined; let timer: ReturnType<typeof setTimeout>;
    const cleanup=()=>{observer?.disconnect(); clearTimeout(timer);};
    const check=()=>{try {const result=read(); if(result) {cleanup(); resolve(result);}} catch(error) {cleanup(); reject(error);}};
    observer = new MutationObserver(check);
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
    timer=setTimeout(()=>{cleanup();reject(new Error('Cliq did not provide a confirmed sent message within 15 seconds.'));},timeoutMs);
    check();
  });
}
// document.readyState/tab.status do not mean Cliq has finished rendering its SPA chat.
// Wait for the exact destination, title, and editor; never infer readiness from URL alone.
export async function waitForDestination(profile:Profile,group:Group,custom?:Destination,timeoutMs=20_000) {
  let lastError='The selected chat has not rendered yet.';
  try {
    return await waitFor(()=>{
      try {return validate(profile,group,location.href,custom);}
      catch(error) {lastError=error instanceof Error?error.message:String(error);return null;}
    },timeoutMs);
  } catch {throw new Error(`Cliq chat is not ready: ${lastError}`);}
}
