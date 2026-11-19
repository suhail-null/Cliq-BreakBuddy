import {useEffect,useRef,useState} from 'react';
import {destinationFor} from '../../config';
import type {Command,CustomData,CustomDraft,CustomJob} from '../../types';
import {Icon} from './Icon';

const dateTime=(at:number)=>new Date(at).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const marTech=destinationFor('production');
export function CustomMessages({busy,execute}:{busy:boolean;execute:(command:Command)=>Promise<any>}) {
  const [data,setData]=useState<CustomData|null>(null);const [notice,setNotice]=useState('');const [loadError,setLoadError]=useState('');
  const [checked,setChecked]=useState<Record<string,boolean>>({});const [manualDestination,setManualDestination]=useState(true);
  const draftRef=useRef<CustomDraft|null>(null);const heading=useRef<HTMLHeadingElement>(null);const loaded=Boolean(data);
  const loader=useRef<()=>Promise<void>>(async()=>{});
  useEffect(()=>{if(loaded)heading.current?.focus();},[loaded]);
  useEffect(()=>{
    let live=true;
    async function load(){
      // Reads must not be dropped by the action lock when the user switches tabs.
      try {
        const response=await chrome.runtime.sendMessage({type:'GET_CUSTOM'});
        if(!response?.ok || !response.data?.jobs)throw new Error(response?.error??'Could not load your messages.');
        if(!live)return;
        const result:CustomData=response.data;const draft=draftRef.current??result.draft;
        if(!draftRef.current)setManualDestination(![marTech,...result.destinations].some(dest=>dest.url===draft.url&&dest.name===draft.name));
        draftRef.current=draft;setData({...result,draft});setLoadError('');
      }catch(error){if(live)setLoadError((error as Error).message);}
    }
    loader.current=load;void load();
    const changed=(changes:any,area:string)=>{if(area==='local' && (changes.customJobs||changes.destinations))void load();};
    chrome.storage.onChanged.addListener(changed);
    return()=>{live=false;chrome.storage.onChanged.removeListener(changed);};
  },[]);
  function edit(patch:Partial<CustomDraft>) {
    if(!data)return;const draft={...(draftRef.current??data.draft),...patch};draftRef.current=draft;
    setData({...data,draft});setNotice('');
    void (async()=>{try{const result=await chrome.runtime.sendMessage({type:'SAVE_CUSTOM_DRAFT',draft});if(!result?.ok)setNotice(result?.error??'Could not save the draft.');}catch{setNotice('Draft could not be saved. Keep this page open and try again.');}})();
  }
  function accept(result:CustomData){setData({...result,draft:draftRef.current??result.draft});}
  async function action(job:CustomJob,action:'cancel'|'send'|'retry'|'resolve',delivered?:boolean) {
    const result=await execute({type:'CUSTOM_ACTION',id:job.id,action,delivered,checked:checked[job.id]});
    if(result?.jobs){accept(result);setNotice('Message status updated.');}
  }
  if(!data)return <section className="message-loading"><span className="empty-icon"><Icon name="message" size={30}/></span><h2 tabIndex={-1}>Custom Message</h2><p role={loadError?'alert':'status'}>{loadError||'Getting your messages ready…'}</p>{loadError&&<button className="button secondary" onClick={()=>loader.current()}>Try again</button>}</section>;
  const d=data.draft;const destinations=[marTech,...data.destinations.filter(dest=>dest.url!==marTech.url)];
  const selected=destinations.find(dest=>dest.url===d.url&&dest.name===d.name);
  const pending=data.jobs.filter(job=>!['sent','cancelled'].includes(job.status));
  const sendAt=d.timing==='date'?new Date(d.sendAt??'').getTime():NaN;
  const scheduleDescription=d.timing==='date'?(Number.isFinite(sendAt)?dateTime(sendAt):'Choose a date & time'):`In ${d.minutes||'…'} minute${d.minutes===1?'':'s'}`;
  const destinationFields=<><label htmlFor="custom-url">Chat or channel URL <span className="required-mark">*</span></label><input id="custom-url" name="url" type="url" required value={d.url} spellCheck={false} autoCapitalize="none" placeholder="https://cliq.zoho.com/company/…" onChange={e=>edit({url:e.target.value})}/><label htmlFor="custom-name">Exact chat title <span className="required-mark">*</span></label><input id="custom-name" name="title" maxLength={100} required value={d.name} placeholder="As shown at the top of the chat" onChange={e=>edit({name:e.target.value})}/><button type="button" className="save-destination" disabled={busy} onClick={async()=>{const result=await execute({type:'SAVE_DESTINATION',url:d.url,name:d.name});if(result?.destinations){accept(result);setManualDestination(false);setNotice('Destination saved to your list.');}}}><Icon name="plus" size={15}/>Save to my destinations</button></>;
  return <section className="custom-message-view">
    <article className="message-hero">
      <span className="message-hero-art" aria-hidden="true"><Icon name="send" size={34}/><span/></span>
      <header><span className="eyebrow">YOUR WORDS. RIGHT ON TIME.</span><h2 ref={heading} id="custom-heading" tabIndex={-1}>Custom Message</h2></header>
      <p>A DSR, an update, a little less to remember.</p>
    </article>
    <div className="message-mode-note"><Icon name="shield" size={15}/><span>One message. No Back reminder.</span><span className="draft-tag">Local draft</span></div>
    {loadError&&<p className="field-hint" role="alert">{loadError}</p>}
    <form className="message-form" aria-labelledby="custom-heading" onSubmit={async e=>{
      e.preventDefault();setNotice('');
      const scheduledAt=d.timing==='date'?new Date(d.sendAt??'').getTime():Date.now()+Number(d.minutes)*60_000;
      const result=await execute({type:'SCHEDULE_CUSTOM',text:d.text,url:d.url,name:d.name,scheduledAt});
      if(result?.jobs){accept(result);setNotice('Message scheduled. Your Break / Back routine stays separate.');}
    }}>
      <fieldset className="message-section composer-section" disabled={busy}><legend><span>01</span>Your message</legend>
        <div className="message-editor"><div className="editor-toolbar"><label htmlFor="custom-text"><Icon name="message" size={14}/>MESSAGE <span aria-hidden="true">*</span></label><Icon name="spark" size={15}/></div><textarea id="custom-text" name="message" rows={6} maxLength={20_000} required value={d.text} aria-describedby="message-help" placeholder={'Today’s progress…\n\n• What you worked on\n• What’s next'} onChange={e=>edit({text:e.target.value})}/><div className="editor-meta"><span id="message-help">Plain text · line breaks kept</span><span>{d.text.length.toLocaleString()} / 20,000</span></div></div>
      </fieldset>
      <fieldset className="message-section delivery-section" disabled={busy}><legend><span>02</span>Destination</legend>
        <div className="destination-picker"><span className="destination-symbol">#</span><div><label htmlFor="custom-saved">SEND THIS MESSAGE TO</label><select id="custom-saved" name="savedDestination" value={!manualDestination&&selected?selected.url:''} onChange={e=>{const dest=destinations.find(dest=>dest.url===e.target.value);setManualDestination(!dest);edit(dest?{url:dest.url,name:dest.name}:{url:'',name:''});}}><option value="">+ New chat or channel</option>{destinations.map(dest=><option key={dest.url} value={dest.url}>{dest.name}</option>)}</select></div></div>
        {manualDestination?<div className="destination-fields">{destinationFields}</div>:<details className="destination-details"><summary>Chat URL & title<Icon name="settings" size={14}/></summary><div className="destination-fields">{destinationFields}</div></details>}
      </fieldset>
      <fieldset className="message-section timing-section" disabled={busy}><legend><span>03</span>Delivery time</legend>
        <div className="timing-options">{([{value:'delay',label:'Timer',icon:'clock'},{value:'date',label:'Date & time',icon:'calendar'}] as const).map(option=><label key={option.value} className="timing-choice"><input type="radio" name="timing" value={option.value} checked={(d.timing??'delay')===option.value} onChange={()=>edit({timing:option.value})}/><Icon name={option.icon} size={17}/><span>{option.label}</span></label>)}</div>
        {d.timing==='date'?<><label htmlFor="custom-date">Date & time on this device <span className="required-mark">*</span></label><input id="custom-date" name="sendAt" type="datetime-local" required value={d.sendAt??''} onChange={e=>edit({sendAt:e.target.value})}/></>:<div className="message-timer"><label htmlFor="custom-delay">Send after</label><div className="custom-stepper"><button type="button" aria-label="Decrease message minutes" disabled={d.minutes<=1} onClick={()=>edit({minutes:Math.max(1,d.minutes-1)})}><Icon name="minus"/></button><div className="custom-value"><input id="custom-delay" name="minutes" type="number" inputMode="numeric" min={1} step={1} required value={d.minutes||''} onChange={e=>edit({minutes:Number(e.target.value)})}/><span aria-hidden="true">min</span></div><button type="button" aria-label="Increase message minutes" onClick={()=>edit({minutes:Number(d.minutes)+1})}><Icon name="plus"/></button></div></div>}
      </fieldset>
      <div className="message-send-summary"><Icon name="send" size={19}/><div><strong>{d.name||'Choose a destination'}</strong><span>{scheduleDescription}</span></div><span className="one-time-tag">ONE TIME</span></div>
      <button className="button primary message-submit" disabled={busy} type="submit"><span>{busy?'Preparing message…':'Schedule message'}</span><Icon name="arrow"/></button>
      <p className="message-browser-hint">Keep your browser open and Cliq signed in.</p>
    </form>
    <p role="status" className="save-notice">{notice}</p>
    <div className="queue-heading"><h3>Your outbox</h3><span>{pending.length} pending</span></div>
    {!data.jobs.length&&<article className="outbox-empty"><Icon name="send" size={26}/><h4>A clear outbox.</h4><p>Your scheduled updates will land here.</p></article>}
    <div className="message-queue">{data.jobs.map(job=><article className={`message-job job-${job.status}`} key={job.id}>
      <header className="job-heading"><h4>{job.destination.name}</h4><span className="mode-tag">{job.status==='sent'?'Delivered':job.status==='uncertain'?'Check delivery':job.status}</span></header>
      <time dateTime={new Date(job.scheduledAt).toISOString()}><Icon name="clock" size={13}/>{dateTime(job.scheduledAt)}</time><p className="message-preview">{job.text}</p><p className="field-hint">{job.detail}</p>
      <footer>
        {['scheduled','overdue','failed'].includes(job.status)&&<button className="button quiet" disabled={busy} onClick={()=>action(job,'cancel')}>Cancel message</button>}
        {job.status==='overdue'&&<button className="button primary" disabled={busy} onClick={()=>action(job,'send')}>Send now<Icon name="arrow"/></button>}
        {job.status==='failed'&&<button className="button secondary" disabled={busy} onClick={()=>action(job,'retry')}>Retry message</button>}
        {job.status==='uncertain'&&<><a className="button secondary" href={job.destination.url} target="_blank" rel="noreferrer">Check message in Cliq<Icon name="external" size={17}/></a><div className="check-field"><input type="checkbox" id={`checked-${job.id}`} checked={!!checked[job.id]} onChange={e=>setChecked({...checked,[job.id]:e.target.checked})}/><label htmlFor={`checked-${job.id}`}>I checked this exact message attempt.</label></div><button className="button secondary" disabled={busy||!checked[job.id]} onClick={()=>action(job,'resolve',true)}>It was sent — confirm</button><button className="button quiet" disabled={busy||!checked[job.id]} onClick={()=>action(job,'resolve',false)}>It wasn’t sent — allow retry</button></>}
      </footer>
    </article>)}</div>
  </section>;
}
