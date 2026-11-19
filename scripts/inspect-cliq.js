/* Run in Cliq's DevTools Console. Local metadata only; does not send messages.
   Select an element with the Elements picker, then call breakBuddyInspect($0).
   Does not read text, editor values, message bodies, credentials, or cookies. */
globalThis.breakBuddyInspect = function (selected) {
  if (!(selected instanceof Element)) throw new Error('Select an element in the Elements panel first.');
  const knownIds = ['CT_1424366017179399537_717321507', 'CT_1424876136100496778_717321507'];
  function selector(el) {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts=[];
    for (let node=el;node && node!==document.body;node=node.parentElement) {
      if(node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length===1) {parts.unshift(`#${CSS.escape(node.id)}`);break;}
      const siblings=node.parentElement ? [...node.parentElement.children].filter(s=>s.tagName===node.tagName) : [node];
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node)+1})`);
    }
    return parts.join(' > ');
  }
  const describe=el=>({tag:el.tagName,id:el.id,classes:typeof el.className==='string'?el.className:'',
    role:el.getAttribute('role'),label:el.getAttribute('aria-label'),
    contenteditable:el.getAttribute('contenteditable'),
    chatIdentityAttributes:[...el.attributes].filter(a=>knownIds.includes(a.value)).map(a=>({name:a.name,value:a.value})),
    attributeNames:[...el.attributes].map(a=>a.name),
    suggestedSelector:selector(el)});
  const ancestors=[];for(let el=selected;el && ancestors.length<7;el=el.parentElement) ancestors.push(describe(el));
  const report={path:location.pathname,selected:describe(selected),ancestors};
  console.log(JSON.stringify(report,null,2));return report;
};
console.log('Inspector ready. Select an element in Elements, then run breakBuddyInspect($0).');
