import {destinationFor, isGroupUrl} from '../config';
import type {Destination, Group, Profile} from '../types';
import {visible} from './adapter';

// Read-only DOM discovery. No editor values, chat text, HTML, credentials, or arbitrary attribute values.
export function inspectCliq(group: Group, custom?: Destination) {
  const destination=destinationFor(group,custom);
  if(!isGroupUrl(location.href,group,custom)) throw new Error('Open the selected destination before inspecting it.');
  function selector(el: Element): string {
    if(el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length===1) return `#${CSS.escape(el.id)}`;
    const parts:string[]=[];
    for(let node:Element|null=el;node && node!==document.body;node=node.parentElement) {
      if(node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length===1) {parts.unshift(`#${CSS.escape(node.id)}`);break;}
      const siblings=node.parentElement?[...node.parentElement.children].filter(s=>s.tagName===node!.tagName):[node];
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node)+1})`);
    }
    return parts.length ? parts.join(' > ') : 'body';
  }
  function metadata(el:Element) {
    const controlValues:Record<string,string>={};
    // Only short UI action/state tokens, never sender IDs, names, URLs, draft text, or arbitrary attributes.
    for(const name of ['data-action','data-operation','data-qa','data-status','ack','mode','mtype','aria-disabled','aria-busy','type']) {
      const value=el.getAttribute(name);
      if(value!==null && /^[A-Za-z0-9_.:-]{0,80}$/.test(value)) controlValues[name]=value;
    }
    return {tag:el.tagName,id:el.id,classes:typeof el.className==='string'?el.className:'',
      role:el.getAttribute('role'),label:el.getAttribute('aria-label'),contenteditable:el.getAttribute('contenteditable'),
      selector:selector(el),attributeNames:[...el.attributes].map(a=>a.name),controlValues,
      chatIdentityAttributes:[...el.attributes].filter(a=>a.value===destination.id).map(a=>a.name),
      flags:{pending:el.matches('[aria-busy="true"],[data-status="pending"],[data-status="sending"]'),
        sent:el.matches('[data-status="sent"],[data-status="delivered"]')}};
  }
  const editors=[...document.querySelectorAll<HTMLElement>('[contenteditable="true"],textarea')].filter(visible);
  const suggestions:Partial<Profile>={};
  const ancestors:ReturnType<typeof metadata>[]=[];
  let root:Element|undefined;
  if(editors.length===1) {
    const editor=editors[0];
    // Derived from the DOM reported by the user, not the session-specific composer ID.
    suggestions.editor=editor.matches('.ProseMirror[contenteditable="true"]') && document.querySelectorAll('.ProseMirror[contenteditable="true"]').length===1?'.ProseMirror[contenteditable="true"]':selector(editor);
    for(let node:Element|null=editor.parentElement;node && node!==document.body && ancestors.length<12;node=node.parentElement) {
      const info=metadata(node);ancestors.push(info);
      if(!root && info.chatIdentityAttributes.length===1) {
        root=node;
        suggestions.root=node.matches('.currentchat.selcht') && document.querySelectorAll('.currentchat.selcht').length===1?'.currentchat.selcht':info.selector;
        suggestions.chatIdAttribute=info.chatIdentityAttributes[0];
      }
    }
    if(root) {
      const titles=[...root.querySelectorAll('*')].filter(el=>visible(el) && el.childElementCount===0 && el.textContent?.trim().replace(/^#\s*/,'')===destination.name);
      if(titles.length===1) suggestions.header=titles[0].matches('.zctle[chid]') && root.querySelectorAll('.zctle[chid]').length===1?'.zctle[chid]':selector(titles[0]);
    }
  }
  const region=root ?? (editors[0]?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement ?? editors[0]?.parentElement);
  const controls=region?[...region.querySelectorAll('button,[role="button"],[onclick],[title],[aria-label],[data-action],svg,[class*="send"],[class*="Send"]')].filter(visible).slice(0,60).map(metadata):[];
  // Bounded structure near the editor exposes non-button div send controls and sibling message rows.
  const outline:({depth:number}&ReturnType<typeof metadata>)[]=[];
  function walk(el:Element,depth:number) {if(outline.length>=180 || depth>5 || ['SCRIPT','STYLE','IFRAME','INPUT','TEXTAREA'].includes(el.tagName)) return;outline.push({depth,...metadata(el)});for(const child of el.children) walk(child,depth+1);}
  if(region) walk(region,0);
  type NodeInfo={depth:number}&ReturnType<typeof metadata>;
  function focusedTree(base:Element|null|undefined,limit:number,maxDepth=16) {
    const nodes:NodeInfo[]=[];
    const queue:{node:Element;depth:number}[]=base?[{node:base,depth:0}]:[];
    while(queue.length && nodes.length<limit) {
      const {node,depth}=queue.shift()!;
      const tag=node.tagName.toUpperCase();
      if(depth>maxDepth || ['SCRIPT','STYLE','IFRAME','DEFS','SYMBOL','PATH','CIRCLE','G','USE'].includes(tag)) continue;
      nodes.push({depth,...metadata(node)});
      if(tag!=='SVG') for(const child of node.children) queue.push({node:child,depth:depth+1});
    }
    return nodes;
  }
  // The supplied report shows .msgtxt[msguid][id] rows and .me[mymsg] ownership.
  // These are DOM observations, not claims about delivery/ack semantics.
  const rows=root?[...root.querySelectorAll('.msgtxt[msguid][id]')]:[];
  if(rows.length) {
    suggestions.row='.msgtxt[msguid][id]';suggestions.rowIdAttribute='msguid';
    if(rows.some(row=>row.matches('.me[mymsg]'))) suggestions.own='.msgtxt.me[mymsg]';
    if(rows.every(row=>row.querySelectorAll(':scope > pre.zcmsgcnt').length===1)) suggestions.body=':scope > pre.zcmsgcnt';
  }
  const composer=editors[0]?.closest('[composer-component]') ?? editors[0]?.parentElement;
  const samples=[...new Set([...rows.filter(row=>!row.matches('.dltinfomsg')).slice(-3),...rows.filter(row=>row.matches('.me[mymsg]:not(.dltinfomsg)')).slice(-2)])];
  const sendSection=composer?.querySelector('.bottommenubar-sendsection');
  const focused={
    // Captured separately before any general traversal, including hidden children when the composer is empty.
    sendSection:focusedTree(sendSection,80,10),
    composer:focusedTree(composer,220),
    messageSamples:samples.map(row=>({row:metadata(row),nodes:focusedTree(row,100,10)})),
    rowCount:rows.length,
  };
  const identityNodes=[...document.querySelectorAll('[id],[data-chatid],[data-chat-id],[chatid],[chid],[data-id]')].filter(el=>[...el.attributes].some(a=>a.value===destination.id)).slice(0,12).map(metadata);
  const missing=(['root','chatIdAttribute','header','editor','send','row','rowIdAttribute','body','own','acknowledged'] as (keyof Profile)[]).filter(key=>!suggestions[key]);
  return {diagnosticsVersion:3,url:location.origin+location.pathname,suggestions,missing,
    nextStep:missing.length?'Only observed fields were detected. Share this report to finish the remaining selectors. Nothing was sent.':'Save setup and run Check saved setup.',
    editors:editors.map(metadata),ancestors,identityNodes,controls,focused,outline};
}
