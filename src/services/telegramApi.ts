export class TelegramError extends Error {
  constructor(message:string,readonly retryable=false,readonly retryAfter=60_000){super(message);}
}
type Method='sendMessage'|'getUpdates'|'answerCallbackQuery'|'editMessageReplyMarkup';
export async function telegramRequest(botToken:string,method:Method,body:Record<string,unknown>) {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),method==='getUpdates'&&Number(body.timeout)>0?25_000:8000);
  try {
    const response=await fetch(`https://api.telegram.org/bot${botToken}/${method}`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
      signal:controller.signal,credentials:'omit',redirect:'error',
    });
    let data:any;
    try {data=await response.json();}catch {throw new TelegramError('Telegram returned an unreadable response.',true);}
    if(!response.ok||data?.ok!==true) {
      const code=data?.error_code??response.status;
      if(code===429)throw new TelegramError('Telegram rate limit reached.',true,Math.min(86400,Math.max(60,Number(data?.parameters?.retry_after)||60))*1000);
      if(code===401||code===404)throw new TelegramError('Telegram rejected the bot token. Check the token from BotFather.');
      if(code===403)throw new TelegramError('Telegram blocked this request. Start the bot or give it permission to post in the target chat.');
      if(code===409)throw new TelegramError('This bot uses a webhook or another update reader. Use a dedicated bot for Telegram buttons.');
      if(code===400)throw new TelegramError('Telegram could not complete this request. Check the chat ID, start the bot, and check its posting permissions.');
      throw new TelegramError('Telegram could not accept the request.',code>=500);
    }
    return data.result;
  } catch(error) {
    if(error instanceof TelegramError)throw error;
    // Fetch errors may contain the request URL and bot token.
    throw new TelegramError('Telegram is unreachable or timed out. Check your connection.',true);
  } finally {clearTimeout(timeout);}
}
