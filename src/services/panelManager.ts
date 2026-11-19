// open() must run directly from the action event, before storage reads or other awaits.
export async function openCompanion(tab: {windowId?: number}) {
  if(typeof chrome.sidePanel?.open==='function' && typeof tab.windowId==='number') {
    try {await chrome.sidePanel.open({windowId:tab.windowId});return;}
    catch(error) {console.warn('BreakBuddy side panel unavailable:',error);}
  }
  // Some Chromium browsers do not expose Side Panel. An extension tab also stays open.
  await chrome.tabs.create({url:chrome.runtime.getURL('popup.html'),active:true});
}
export function registerPanelAction() {
  chrome.action.onClicked.addListener((tab:{windowId?:number})=>{
    void openCompanion(tab).catch(error=>console.error('BreakBuddy could not open:',error));
  });
}
export async function recordPanelVisibility(documentId:string,windowId:number,visible:boolean) {
  if(Number.isInteger(windowId) && windowId>=0 && typeof visible==='boolean') {
    await chrome.storage.session.set({[`panel:${documentId}`]:{windowId,visible}});
  }
}
export async function panelVisibleInFocusedWindow():Promise<boolean> {
  if(!chrome.runtime.getContexts || !chrome.windows.getLastFocused) return false;
  try {
    const [contexts,window]=await Promise.all([
      chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}),
      chrome.windows.getLastFocused({windowTypes:['normal']}),
    ]);
    if(!window.focused) return false;
    for(const context of contexts as {windowId:number;documentId:string}[]) {
      if(context.windowId===window.id) return true;
      // Chromium can report windowId=-1 for a side-panel context. Match its live document
      // to a window registered by the panel itself; never trust stale session entries alone.
      if(context.windowId===-1 && chrome.storage.session) {
        const key=`panel:${context.documentId}`;
        const registered=(await chrome.storage.session.get(key))[key];
        if(registered?.visible && registered.windowId===window.id) return true;
      }
    }
    return false;
  } catch {return false;}
}
