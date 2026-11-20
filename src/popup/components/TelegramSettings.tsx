import {useEffect,useState} from 'react';
import type {Command,TelegramSettings as SettingsData} from '../../types';

export function TelegramSettings({busy,execute}:{busy:boolean;execute:(command:Command)=>Promise<any>}) {
  const [saved,setSaved]=useState<SettingsData|null>(null);
  const [enabled,setEnabled]=useState(false);const [token,setToken]=useState('');const [chatId,setChatId]=useState('');
  const [notice,setNotice]=useState('');const [error,setError]=useState('');
  const [chats,setChats]=useState<{id:string;name:string}[]>([]);
  useEffect(()=>{
    let live=true;
    async function load(initial=false) {
      try {
        const response=await chrome.runtime.sendMessage({type:'GET_TELEGRAM'});
        if(!response?.ok)throw new Error(response?.error??'Could not load Telegram settings.');
        if(live){setSaved(response.data);if(initial){setEnabled(response.data.enabled);setChatId(response.data.chatId);}}
      } catch(error){if(live)setError((error as Error).message);}
    }
    const changed=(changes:any,area:string)=>{if(area==='local'&&(changes.telegramLastReport||changes.telegramReports))void load();};
    void load(true);chrome.storage.onChanged.addListener(changed);
    return()=>{live=false;chrome.storage.onChanged.removeListener(changed);};
  },[]);
  async function save(event:React.FormEvent) {
    event.preventDefault();setNotice('');setError('');
    const data=await execute({type:'SAVE_TELEGRAM',enabled,botToken:token,chatId});
    if(data&&typeof data.hasToken==='boolean'){setSaved(data);setToken('');setChatId(data.chatId);setNotice(data.enabled?'Telegram reports enabled. Send a test to check the connection.':'Telegram reports disabled.');}
  }
  const unsaved=Boolean(saved&&(token.trim()||enabled!==saved.enabled||chatId.trim()!==saved.chatId));
  return <form className="telegram-settings" onSubmit={save}>
    <fieldset className="form-card" disabled={busy||!saved}>
      <legend>Telegram delivery reports</legend>
      <p className="field-hint">Get a Telegram confirmation when you schedule a Break, plus delivery reports when Break, Back, or a custom message succeeds, fails, needs checking, or misses its schedule.</p>
      <div className="check-field"><input id="telegram-enabled" type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/><label htmlFor="telegram-enabled">Enable Telegram reports</label></div>
      <label htmlFor="telegram-token">Bot token</label>
      <input id="telegram-token" type="password" autoComplete="new-password" spellCheck={false} maxLength={121} value={token} onChange={e=>setToken(e.target.value)} placeholder={saved?.hasToken?'Saved token — leave blank to keep':'Paste the token from BotFather'}/>
      <label htmlFor="telegram-chat">Telegram chat ID</label>
      <input id="telegram-chat" autoComplete="off" spellCheck={false} maxLength={33} value={chatId} onChange={e=>setChatId(e.target.value)} placeholder="123456789 or -1001234567890"/>
      <button className="button quiet" type="button" disabled={!token.trim()&&!saved?.hasToken} onClick={async()=>{setNotice('');setChats([]);const data=await execute({type:'FIND_TELEGRAM_CHATS',botToken:token});if(Array.isArray(data)){setChats(data);setNotice('Choose the Telegram chat that should receive your reports.');}}}>Find chat ID</button>
      {chats.length>0&&<><label htmlFor="telegram-found-chat">Choose a Telegram chat</label><select id="telegram-found-chat" value={chats.some(c=>c.id===chatId)?chatId:''} onChange={e=>{if(e.target.value)setChatId(e.target.value);}}><option value="">Select a chat</option>{chats.map(chat=><option key={chat.id} value={chat.id}>{chat.name} ({chat.id})</option>)}</select></>}
      <details className="telegram-help"><summary>Connect your Telegram bot</summary>
        <ol><li>Open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> in Telegram and send <code>/newbot</code>. Paste the token here.</li>
          <li>Open your new bot and send <code>/start</code>. For a group, add the bot and send a command addressed to it.</li>
          <li>Click <strong>Find chat ID</strong> above and choose your chat. You can also enter an ID manually or use a public channel’s <code>@username</code>; the bot needs permission to post.</li>
          <li>Enable reports, save, then send a test.</li></ol>
      </details>
      <p className="field-hint">The token stays in this browser profile. Reports go directly to Telegram and include the chat name and up to 200 characters of the message.</p>
      <button className="button secondary" type="submit">Save Telegram settings</button>
      <div className="button-row">
        <button className="button quiet" type="button" disabled={!saved?.hasToken||!saved.chatId||unsaved} onClick={async()=>{setNotice('');const data=await execute({type:'TEST_TELEGRAM'});if(data){setSaved(data);setNotice('Test sent. Check your Telegram chat.');}}}>Send Telegram test</button>
        {saved?.hasToken&&<button className="button quiet" type="button" onClick={async()=>{const data=await execute({type:'DISCONNECT_TELEGRAM'});if(data){setSaved(data);setToken('');setChatId('');setChats([]);setEnabled(false);setNotice('Telegram disconnected. Saved token removed.');}}}>Disconnect</button>}
      </div>
      {unsaved&&<p className="field-hint">Save your changes before sending a test.</p>}
      {saved?.lastReport&&<p className={`telegram-result ${saved.lastReport.ok?'':'telegram-failed'}`} role="status">{saved.lastReport.detail} <time dateTime={new Date(saved.lastReport.at).toISOString()}>{new Date(saved.lastReport.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></p>}
      {Boolean(saved?.pending)&&<p className="field-hint">{saved!.pending} Telegram report{saved!.pending===1?'':'s'} waiting to send. Chrome must remain open.</p>}
    </fieldset>
    {error&&<p role="alert" className="telegram-result telegram-failed">{error}</p>}
    <p role="status" className="save-notice">{notice}</p>
  </form>;
}
