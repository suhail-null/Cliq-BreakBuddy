import {useEffect,useRef,useState} from 'react';
import {destinationFor} from '../config';
import {validMinutes} from '../services/breakScheduler';
import type {Command,State} from '../types';
import {Icon,type IconName} from './components/Icon';
import {StatusCard,statusLabels,time} from './components/StatusCard';
import {Settings} from './components/Settings';
import {Activity} from './components/Activity';
import {CustomMessages} from './components/CustomMessages';
type View='today'|'activity'|'settings'|'custom';
async function request(command:Command) {
  const result=await chrome.runtime.sendMessage(command);
  if(!result?.ok) throw new Error(result?.error ?? 'BreakBuddy is reconnecting. Reload the extension if this continues.');
  return result.data;
}
export function App() {
  const [state,setState]=useState<State|null>(null);const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);const busyRef=useRef(false);
  const [minutes,setMinutes]=useState<number|''>(20);const [now,setNow]=useState(Date.now());
  const [view,setView]=useState<View>('today');const [checked,setChecked]=useState(false);
  const heading=useRef<HTMLDivElement>(null);const previousView=useRef<View>('today');
  useEffect(()=>{
    let disposed=false;
    let panelWindowId:number|null=null;
    async function panelVisibility(visible:boolean) {
      if(!location.pathname.endsWith('sidepanel.html')) return;
      try {
        if(panelWindowId===null) panelWindowId=(await chrome.windows.getCurrent()).id;
        if(panelWindowId!==null) await request({type:'PANEL_VISIBILITY',windowId:panelWindowId,visible});
      } catch {/* Live runtime contexts remain the fallback if the panel is closing. */}
    }
    async function load(){try {const value=await request({type:'GET'});if(!disposed)setState(value);}catch(e){if(!disposed)setError((e as Error).message);}}
    const listener=(changes:any,area:string)=>{if(area==='local' && changes.state && !disposed) setState(changes.state.newValue);};
    chrome.storage.onChanged.addListener(listener);void load();void panelVisibility(document.visibilityState==='visible');
    const interval=setInterval(()=>setNow(Date.now()),1000); // Display only; Chrome alarms own scheduling.
    const onVisibility=()=>{void panelVisibility(document.visibilityState==='visible');if(document.visibilityState==='visible'){setNow(Date.now());void load();}};
    document.addEventListener('visibilitychange',onVisibility);
    return()=>{disposed=true;void panelVisibility(false);clearInterval(interval);chrome.storage.onChanged.removeListener(listener);document.removeEventListener('visibilitychange',onVisibility);};
  },[]);
  useEffect(()=>{if(previousView.current!==view){heading.current?.querySelector<HTMLHeadingElement>('h2')?.focus();previousView.current=view;}},[view]);
  useEffect(()=>{document.title=`${state?.backPending?'Back pending':view==='settings'?'Preferences':view==='activity'?'Activity':view==='custom'?'Custom Message':'Your side companion'} · BreakBuddy`;},[view,state?.backPending]);
  async function execute(command:Command) {
    if(busyRef.current) return null;
    busyRef.current=true;setBusy(true);setError('');
    try {const data=await request(command);if(data?.version===1)setState(data);return data;}
    catch(e){setError((e as Error).message);return null;}
    finally{busyRef.current=false;setBusy(false);}
  }
  async function openWindow(){try {await chrome.windows.create({url:chrome.runtime.getURL('popup.html'),type:'popup',width:440,height:850,focused:true});}catch(e){setError((e as Error).message);}}
  const sending=state?.status==='SENDING_BREAK' || state?.status==='SENDING_BACK';
  const disabled=busy || sending;const pending=state?.backPending;
  const destination=state?destinationFor(state.group,state.customDestination):null;
  const uiError=error || state?.error;
  const nav: {id:View;label:string;icon:IconName}[]=[{id:'today',label:'Today',icon:'grid'},{id:'activity',label:'Activity',icon:'activity'},{id:'settings',label:'Settings',icon:'settings'},{id:'custom',label:'Custom Message',icon:'message'}];
  return <div className={`app view-${view} ${pending?'back-pending':''}`}>
    <header className="app-header"><div className="brand"><span className="brand-mark"><Icon name="coffee" size={23}/></span><div><h1>breakbuddy<span className="brand-period">.</span></h1><p>A LITTLE SPACE TO RESET</p></div></div><div className="header-actions"><button className="icon-button" aria-label="Open in a separate window" onClick={openWindow}><Icon name="external" size={18}/></button><button className="icon-button" aria-label={view==='settings'?'Back to today':'Open settings'} onClick={()=>setView(view==='settings'?'today':'settings')}><Icon name={view==='settings'?'close':'settings'} size={19}/></button></div></header>
    <main>
      <p className="visually-hidden" role="status">{state?statusLabels[state.status]:''}</p>
      {uiError && <div className="error-notice" role="alert"><Icon name="alert" size={19}/><div><strong>A little attention needed</strong><p>{uiError}</p></div></div>}
      {!state?<div className="empty-state"><span className="empty-icon"><Icon name="coffee" size={30}/></span><h2>Getting your desk ready.</h2><p>Connecting to your saved BreakBuddy status.</p>{error && <button className="button secondary" onClick={()=>execute({type:'GET'})}>Reconnect</button>}</div>:<>
        {pending && view!=='today' && <button className="return-banner" onClick={()=>setView('today')}><Icon name="sun"/><span>Back pending · Ready to return?</span><Icon name="arrow" size={17}/></button>}
        <div ref={heading} className="workspace" key={view}>
          {view==='settings'?<Settings state={state} busy={Boolean(disabled)} execute={execute}/>:view==='activity'?<Activity state={state}/>:view==='custom'?<CustomMessages busy={Boolean(disabled)} execute={execute}/>:<>
            <button className="destination-card" onClick={()=>setView('settings')} aria-label={`Change destination. Current destination: ${destination!.name}`}><span className="destination-symbol">#</span><span className="destination-text"><small>CHECKING IN WITH</small><strong>{destination!.name}</strong></span><span className={`mode-tag ${state.group!=='test'?'is-live':''}`}>{state.group==='test'?'TEST MODE':state.group==='custom'?'CUSTOM':'LIVE'}</span><Icon name="back" size={16} style={{transform:'rotate(180deg)'}}/></button>
            <StatusCard state={state} now={now}/>
            <div className="action-area">
              {state.status==='AVAILABLE' && <form onSubmit={event=>{event.preventDefault();void execute({type:'SCHEDULE',minutes:Number(minutes)});}}>
                <fieldset className="duration-fieldset" disabled={Boolean(disabled)}><legend>Your next break <span>starts in</span></legend><div className="presets">{[5,10,15,20,25,30].map(value=><button type="button" key={value} aria-pressed={minutes===value} className={minutes===value?'selected':''} onClick={()=>setMinutes(value)}><span>{value}</span><small>min</small>{minutes===value && <span className="preset-check"><Icon name="check" size={11}/></span>}</button>)}</div>
                  <div className="custom-duration"><label htmlFor="break-minutes">Custom timer</label><p id="duration-hint">Any positive whole number of minutes.</p><div className="custom-stepper"><button type="button" aria-label="Decrease minutes" disabled={minutes==='' || minutes<=1} onClick={()=>setMinutes(Math.max(1,Number(minutes)-1))}><Icon name="minus"/></button><div className="custom-value"><input id="break-minutes" name="minutes" type="number" inputMode="numeric" min={1} step={1} required aria-describedby="duration-hint" value={minutes} onChange={e=>setMinutes(e.target.value===''?'':Number(e.target.value))}/><span aria-hidden="true">min</span></div><button type="button" aria-label="Increase minutes" onClick={()=>setMinutes(Number(minutes)+1)}><Icon name="plus"/></button></div></div>
                </fieldset>
                <button className="button primary" type="submit" disabled={Boolean(disabled)}><span>{busy?'Preparing your break…':'Schedule my break'}</span><Icon name="arrow"/></button>
                <p className="button-caption">{busy?'Opening your destination in the background.':validMinutes(Number(minutes))?`Break will be posted at ${time(now+Number(minutes)*60_000)}.`:'Choose how many minutes from now.'}</p>
              </form>}
              {state.status==='BREAK_SCHEDULED' && <><div className="success-note"><Icon name="check"/><div><strong>You’re all set.</strong><p>Keep browsing. We’ll take it from here.</p></div></div><button className="button secondary" disabled={Boolean(disabled)} onClick={()=>execute({type:'CANCEL'})}>Cancel scheduled break</button></>}
              {state.status==='BACK_PENDING' || state.status==='SENDING_BACK'?<><div className="return-intro"><span className="eyebrow">ONE CLICK WHEN YOU’RE READY</span><h3>Let your team know you’re back.</h3></div><button className="button primary return-button" disabled={Boolean(disabled)} onClick={()=>execute({type:'BACK'})}><span>{sending?'Sending Back…':"I’m Back — Send Back"}</span><Icon name="arrow"/></button><button className="button quiet" disabled={Boolean(disabled)} onClick={()=>execute({type:'SNOOZE'})}><Icon name="clock" size={17}/>Remind me in 5 minutes</button><p className="button-caption">{state.snoozeUntil && state.snoozeUntil>now?`Reminder snoozed until ${time(state.snoozeUntil)}.`:'Only you decide when to send Back.'}</p></>:null}
              {state.status==='SENDING_BREAK' && <div className="success-note"><Icon name="shield"/><div><strong>Checking the conversation.</strong><p>We’ll mark your break only after confirmation.</p></div></div>}
              {state.status==='OVERDUE' && <><p className="action-description">Your scheduled time passed while Chrome or your device was unavailable. Send your Break now?</p><button className="button primary" disabled={Boolean(disabled)} onClick={()=>execute({type:'SEND_NOW'})}>Send Break now<Icon name="arrow"/></button><button className="button quiet" disabled={Boolean(disabled)} onClick={()=>execute({type:'CANCEL'})}>Cancel missed break</button></>}
              {state.status==='ERROR' && <><button className="button primary" disabled={Boolean(disabled)} onClick={()=>execute({type:'RETRY'})}>Retry {state.operation?.text ?? 'message'}<Icon name="arrow"/></button>{!state.backPending && <button className="button quiet" disabled={Boolean(disabled)} onClick={()=>execute({type:'CANCEL'})}>Cancel break</button>}</>}
              {state.status==='UNCERTAIN' && <div className="resolution"><p>Check whether your <strong>{state.operation?.text}</strong> message appears as sent in the destination. Your pending status is preserved.</p><button className="button secondary" disabled={Boolean(disabled)} onClick={()=>execute({type:'OPEN_CLIQ'})}>Open the conversation<Icon name="external" size={17}/></button><div className="check-field"><input id="message-checked" type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/><label htmlFor="message-checked">I checked this exact attempt in Cliq.</label></div><button className="button primary" disabled={Boolean(disabled)||!checked} onClick={()=>execute({type:'RESOLVE',delivered:true,checked})}>It was sent — confirm<Icon name="check"/></button><button className="button quiet" disabled={Boolean(disabled)||!checked} onClick={()=>execute({type:'RESOLVE',delivered:false,checked})}>It wasn’t sent — allow retry</button></div>}
              {['ERROR','OVERDUE'].includes(state.status) && <button className="button quiet" disabled={Boolean(disabled)} onClick={()=>execute({type:'OPEN_CLIQ'})}>Open destination in Cliq<Icon name="external" size={16}/></button>}
            </div>
            <div className="desk-note"><span className="note-icon"><Icon name={pending?'bell':'shield'} size={18}/></span><div><strong>{pending?'Your return won’t get forgotten.':'A small break. A fresh perspective.'}</strong><p>{pending?'This reminder stays here until Back is confirmed.':'Keep this companion open while you work.'}</p></div></div>
          </>}
        </div>
      </>}
    </main>
    <nav className="bottom-nav" aria-label="BreakBuddy sections">{nav.map(item=><button key={item.id} aria-current={view===item.id?'page':undefined} onClick={()=>setView(item.id)}><span className="nav-icon"><Icon name={item.icon} size={19}/>{item.id==='today' && pending && <span className="nav-badge"/>}</span><span>{item.label}</span></button>)}</nav>
  </div>;
}
