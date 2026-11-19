import {beforeEach,describe,expect,it,vi} from 'vitest';
import {openCompanion,panelVisibleInFocusedWindow,registerPanelAction} from '../src/services/panelManager';
import {reminderWindow} from '../src/services/reminderManager';
let api:any;
beforeEach(()=>{
  api={sidePanel:{open:vi.fn(async()=>{})},action:{onClicked:{addListener:vi.fn()}},runtime:{getURL:(p:string)=>`chrome-extension://test/${p}`,getContexts:vi.fn(async()=>[{windowId:7}])},windows:{getLastFocused:vi.fn(async()=>({id:7,focused:true})),create:vi.fn()},tabs:{create:vi.fn(),query:vi.fn(async()=>[])}};
  vi.stubGlobal('chrome',api);
});
describe('persistent side companion',()=>{
  it('opens the global panel immediately in the clicked window without a preceding async lookup',async()=>{
    const promise=openCompanion({windowId:7});
    expect(api.sidePanel.open).toHaveBeenCalledWith({windowId:7});
    expect(api.windows.getLastFocused).not.toHaveBeenCalled();await promise;
    expect(api.tabs.create).not.toHaveBeenCalled();
  });
  it('registers an explicit toolbar action trigger',async()=>{
    registerPanelAction();api.action.onClicked.addListener.mock.calls[0][0]({windowId:7});
    expect(api.sidePanel.open).toHaveBeenCalledWith({windowId:7});
  });
  it('falls back to a persistent extension tab in browsers without the side panel API',async()=>{
    api.sidePanel=undefined;await openCompanion({windowId:7});
    expect(api.tabs.create).toHaveBeenCalledWith({url:'chrome-extension://test/popup.html',active:true});
  });
  it('falls back if the browser rejects opening the panel',async()=>{
    vi.spyOn(console,'warn').mockImplementation(()=>{});api.sidePanel.open.mockRejectedValue(new Error('Unsupported browser'));
    await openCompanion({windowId:7});expect(api.tabs.create).toHaveBeenCalledTimes(1);
  });
  it('does not duplicate a reminder window when the panel is visible in the focused window',async()=>{
    expect(await panelVisibleInFocusedWindow()).toBe(true);await reminderWindow();expect(api.windows.create).not.toHaveBeenCalled();
  });
  it('keeps the reminder-window fallback when the panel is in a different window',async()=>{
    api.runtime.getContexts.mockResolvedValue([{windowId:8}]);await reminderWindow();expect(api.windows.create).toHaveBeenCalledTimes(1);
  });
  it('does not treat a panel in an unfocused browser window as a visible reminder',async()=>{
    api.windows.getLastFocused.mockResolvedValue({id:7,focused:false});expect(await panelVisibleInFocusedWindow()).toBe(false);
  });
  it('matches live panel documents to registered windows when Chromium reports windowId -1',async()=>{
    api.runtime.getContexts.mockResolvedValue([{windowId:-1,documentId:'panel-document'}]);
    api.storage={session:{get:vi.fn(async()=>({'panel:panel-document':{windowId:7,visible:true}}))}};
    expect(await panelVisibleInFocusedWindow()).toBe(true);
    api.runtime.getContexts.mockResolvedValue([]);expect(await panelVisibleInFocusedWindow()).toBe(false);
  });
});
