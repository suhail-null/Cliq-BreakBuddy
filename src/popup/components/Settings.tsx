import {useEffect,useState} from 'react';
import {CLIQ_PROFILE} from '../../config';
import type {Command,Destination,Group,Profile,State} from '../../types';
import {Icon} from './Icon';
const fields:Record<keyof Profile,string>={root:'Active chat container',chatIdAttribute:'Container chat ID attribute',header:'Chat title',editor:'Message editor',send:'Send control or shortcut mode',row:'Message row',rowIdAttribute:'Message ID attribute',body:'Message text',own:'Your own message selector',acknowledged:'Confirmation mode or selector'};
export function Settings({state,busy,execute}:{state:State;busy:boolean;execute:(command:Command)=>Promise<any>}) {
  const [group,setGroup]=useState<Group>(state.group);const [profile,setProfile]=useState({...state.profile});
  const [url,setUrl]=useState(state.customDestination?.url ?? '');const [name,setName]=useState(state.customDestination?.name ?? '');
  const [phrase,setPhrase]=useState('');const [notice,setNotice]=useState('');const [report,setReport]=useState('');
  const [destinations,setDestinations]=useState<Destination[]>([]);const [selected,setSelected]=useState(state.group==='custom'?state.customDestination?.url??'custom':'production');
  useEffect(()=>{let live=true;void (async()=>{try{const result=await chrome.runtime.sendMessage({type:'GET_CUSTOM'});if(!result?.ok)throw new Error(result?.error??'Could not load saved destinations.');if(live)setDestinations(result.data.destinations);}catch(error){if(live)setNotice((error as Error).message);}})();return()=>{live=false;};},[]);
  async function save(event:React.FormEvent) {
    event.preventDefault();setNotice('');
    const data=await execute({type:'SAVE_CONFIG',group,profile,phrase,customUrl:url,customName:name});
    if(data?.version===1) {setNotice('Settings saved. Custom destinations are saved in your list.');const saved=await execute({type:'GET_CUSTOM'});if(saved?.destinations)setDestinations(saved.destinations);if(group==='custom')setSelected(url.trim().replace(/\/$/,''));}
  }
  async function inspect(type:'INSPECT'|'CHECK_SETUP') {
    const data=await execute({type});if(data) setReport(JSON.stringify(data,null,2));
  }
  const locked=state.status!=='AVAILABLE';
  return <section className="settings-view"><div className="section-heading"><div><span className="eyebrow">MAKE IT YOURS</span><h2 tabIndex={-1}>Your preferences</h2></div><Icon name="settings" size={25}/></div>
    <form id="preferences-form" onSubmit={save}>
      <fieldset disabled={busy} className="form-card"><legend>Where we check in</legend>
        <label htmlFor="destination">Break / Back destination</label><select id="destination" name="destination" value={selected} disabled={locked} onChange={e=>{const value=e.target.value;setSelected(value);setPhrase('');setGroup(value==='production'?'production':'custom');if(value==='custom'){setUrl('');setName('');}else{const saved=destinations.find(d=>d.url===value);if(saved){setUrl(saved.url);setName(saved.name);}}}}><option value="production">MarTech</option><option value="custom">+ Add custom chat or channel</option>{destinations.map(d=><option key={d.url} value={d.url}>{d.name} · Custom</option>)}</select>
        {locked && <p className="field-hint">Finish this break before changing destinations.</p>}
        {group==='custom' && <><label htmlFor="chat-url">Chat or channel URL</label><input id="chat-url" type="url" required disabled={locked} value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://cliq.zoho.com/company/717321507/chats/…"/><label htmlFor="chat-name">Exact chat title</label><input id="chat-name" required disabled={locked} value={name} onChange={e=>setName(e.target.value)} placeholder="As shown in the chat header"/></>}
        {group==='custom' && destinations.some(d=>d.url===selected) && <button className="button quiet" type="button" disabled={locked} onClick={async()=>{const data=await execute({type:'REMOVE_DESTINATION',url:selected});if(data?.destinations){setDestinations(data.destinations);setSelected('custom');setNotice('Removed from the saved list. Your active destination is unchanged.');}}}>Remove from saved list</button>}
        {group!=='test' && <div className="confirmation-field"><label htmlFor="destination-confirmation">Confirm automatic Break messages</label><p id="confirmation-hint">Type <strong>{group==='production'?'ENABLE MARTECH':'ENABLE CUSTOM'}</strong> when enabling or changing this destination.</p><input id="destination-confirmation" aria-describedby="confirmation-hint" autoComplete="off" spellCheck={false} value={phrase} onChange={e=>setPhrase(e.target.value)} placeholder={group==='production'?'ENABLE MARTECH':'ENABLE CUSTOM'}/></div>}
      </fieldset>
      <button className="button primary" type="submit" disabled={busy}><span>{busy?'Saving…':'Save preferences'}</span><Icon name="check"/></button>
      <p role="status" className="save-notice">{notice}</p>
    </form>
      <div className="companion-note"><span className="note-icon"><Icon name="window"/></span><div><strong>A companion, not a disappearing popup.</strong><p>Keep this panel open beside your tabs. If the browser closes it after restarting, click the BreakBuddy icon to bring it back. Your pending return is always saved.</p></div></div>
    <details className="advanced"><summary>Advanced setup & diagnostics</summary>
      <fieldset className="form-card" disabled={busy}><legend>Sending preference</legend><label htmlFor="send-shortcut">Match your Cliq shortcut</label><select id="send-shortcut" name="sendShortcut" form="preferences-form" value={profile.send.startsWith('@cliq-')?profile.send:'custom'} onChange={e=>{if(e.target.value!=='custom')setProfile({...profile,send:e.target.value});}}><option value="@cliq-enter">Enter · Cliq default</option><option value="@cliq-shift-enter">Shift + Enter · Send button enabled</option>{!profile.send.startsWith('@cliq-') && <option value="custom">Custom Send control</option>}</select><p className="field-hint">Choose Shift + Enter only if you enabled the Send button in Cliq.</p></fieldset>
      <p className="muted">The built-in Cliq adapter is already configured. Only change these fields to troubleshoot a different page layout.</p><button className="button secondary" disabled={busy} onClick={()=>{setProfile({...CLIQ_PROFILE});setNotice('Built-in profile restored. Save preferences to apply it.');}}>Use built-in Cliq profile</button>
      {Object.entries(fields).map(([key,label])=><div key={key}><label htmlFor={`adapter-${key}`}>{label}</label><input id={`adapter-${key}`} spellCheck={false} autoComplete="off" disabled={busy} value={profile[key as keyof Profile]} onChange={e=>setProfile({...profile,[key]:e.target.value})}/></div>)}
      <div className="button-row"><button className="button secondary" disabled={busy} onClick={()=>inspect('CHECK_SETUP')}>Check saved setup</button><button className="button secondary" disabled={busy} onClick={()=>inspect('INSPECT')}>Inspect Cliq</button></div>
      {report && <><pre className="report">{report}</pre><button className="button secondary" onClick={()=>{const url=URL.createObjectURL(new Blob([report],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='breakbuddy-cliq-diagnostics.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>Download diagnostics</button></>}
    </details>
    <div className="privacy-line"><Icon name="shield" size={15}/><span>Stored on your device. No tracking. No passwords.</span></div>
  </section>;
}
