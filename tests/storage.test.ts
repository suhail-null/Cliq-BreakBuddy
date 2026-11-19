import {expect,it,vi} from 'vitest';
import {defaultState,CLIQ_PROFILE} from '../src/config';
import {readState} from '../src/services/storageManager';
it('migrates previous blank setup fields to the built-in profile',async()=>{
  const previous=defaultState();previous.profile=Object.fromEntries(Object.keys(previous.profile).map(key=>[key,''])) as any;
  vi.stubGlobal('chrome',{storage:{local:{get:async()=>({state:previous})}}});
  expect((await readState()).profile).toEqual(CLIQ_PROFILE);
});
it('preserves explicit custom profile overrides during migration',async()=>{
  const previous=defaultState();previous.profile.send='.custom-send';
  vi.stubGlobal('chrome',{storage:{local:{get:async()=>({state:previous})}}});
  expect((await readState()).profile.send).toBe('.custom-send');
});
it('retires an old test schedule without enabling MarTech',async()=>{
  const previous={...defaultState(),group:'test',status:'BREAK_SCHEDULED',scheduledAt:Date.now()+60_000};
  vi.stubGlobal('chrome',{storage:{local:{get:async()=>({state:previous})}}});
  expect(await readState()).toMatchObject({group:'production',productionEnabled:false,status:'AVAILABLE',scheduledAt:null});
});
it('keeps an existing pending return tied to its previous destination during migration',async()=>{
  const destination={name:'Previous team',id:'CT_previous',url:'https://cliq.zoho.com/company/717321507/chats/CT_previous'};
  const previous={...defaultState(),group:'test',status:'BACK_PENDING',backPending:true,history:[{id:'old',text:'Break',group:'test',destination,at:Date.now(),proof:'ui'}]};
  vi.stubGlobal('chrome',{storage:{local:{get:async()=>({state:previous})}}});
  expect(await readState()).toMatchObject({group:'custom',productionEnabled:true,status:'BACK_PENDING',backPending:true,customDestination:destination});
});
