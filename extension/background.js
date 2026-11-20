const CLIQ_PROFILE = {
  root: ".currentchat.selcht",
  chatIdAttribute: "id",
  header: ".zctle[chid]",
  editor: '.ProseMirror[contenteditable="true"]',
  send: "@cliq-enter",
  row: ".msgtxt[msguid][id]",
  rowIdAttribute: "msguid",
  body: ":scope > pre.zcmsgcnt",
  own: ".msgtxt.me[mymsg]",
  acknowledged: "@fresh-chat"
};
const BASE = "https://cliq.zoho.com/company/717321507";
const GROUPS = {
  // Legacy internal alias; the personal testing destination is no longer shipped.
  test: { name: "Retired destination", id: "CT_retired_destination" },
  production: { name: "MarTech", id: "CT_1424876136100496778_717321507" }
};
function parseCustomDestination(url, name) {
  const u = new URL(url.trim());
  const match = u.pathname.match(/^\/company\/717321507\/(?:chats|channels)\/([A-Za-z0-9_-]+)\/?$/);
  if (u.origin !== "https://cliq.zoho.com" || u.username || u.password || u.search || u.hash || !match) throw new Error("Paste a direct chat/channel URL from your company on https://cliq.zoho.com, without query parameters or a fragment.");
  const title = name.trim().replace(/^#\s*/, "");
  if (!title || title.length > 100) throw new Error("Enter the exact chat/channel title (up to 100 characters).");
  return { name: title, id: match[1], url: `${u.origin}${u.pathname.replace(/\/$/, "")}` };
}
function destinationFor(group, custom) {
  if (group === "custom") {
    if (!custom) throw new Error("Configure a custom destination first.");
    return parseCustomDestination(custom.url, custom.name);
  }
  return { ...GROUPS[group], url: `${BASE}/chats/${GROUPS[group].id}` };
}
const groupUrl = (g, custom) => destinationFor(g, custom).url;
function isGroupUrl(url, group, custom) {
  try {
    const u = new URL(url);
    return u.origin === "https://cliq.zoho.com" && u.pathname.replace(/\/$/, "") === new URL(groupUrl(group, custom)).pathname;
  } catch {
    return false;
  }
}
const BREAK_ALARM = "breakbuddy-break";
const REMINDER_ALARM = "breakbuddy-reminder";
const WATCHDOG = "breakbuddy-recovery";
const LATE_GRACE_MS = 6e4;
const defaultState = () => ({
  version: 1,
  group: "production",
  productionEnabled: false,
  customDestination: null,
  profile: { ...CLIQ_PROFILE },
  status: "AVAILABLE",
  scheduledAt: null,
  breakSentAt: null,
  backPending: false,
  lastBackAt: null,
  snoozeUntil: null,
  lastReminderAt: null,
  operation: null,
  submission: "none",
  error: null,
  history: []
});
async function readState() {
  const { state } = await chrome.storage.local.get("state");
  const defaults = defaultState();
  const profile = { ...defaults.profile, ...state?.profile };
  for (const key of Object.keys(defaults.profile)) if (!profile[key]?.trim()) profile[key] = defaults.profile[key];
  const result = { ...defaults, ...state, profile };
  if (result.group === "test") {
    const previousDestination = result.operation?.destination ?? result.history.find((item) => item.text === "Break" && item.destination)?.destination;
    if (previousDestination && (result.backPending || result.status === "UNCERTAIN")) {
      result.group = "custom";
      result.customDestination = previousDestination;
      result.productionEnabled = true;
      if (result.operation) result.operation = { ...result.operation, group: "custom" };
    } else if (result.status === "AVAILABLE" || result.status === "BREAK_SCHEDULED" || result.status === "OVERDUE") {
      result.group = "production";
      result.productionEnabled = false;
      result.status = "AVAILABLE";
      result.scheduledAt = null;
      result.operation = null;
    }
  }
  return result;
}
async function writeState(state) {
  await chrome.storage.local.set({ state });
}
function dueDecision(state, now) {
  if (state.status !== "BREAK_SCHEDULED" || state.scheduledAt === null) return "none";
  if (now < state.scheduledAt) return "wait";
  return now - state.scheduledAt > LATE_GRACE_MS ? "overdue" : "send";
}
function validMinutes(minutes) {
  const deadline = Date.now() + minutes * 6e4;
  return Number.isSafeInteger(minutes) && minutes >= 1 && Number.isSafeInteger(deadline) && deadline <= 864e13;
}
async function restoreAlarms(state) {
  if (!await chrome.alarms.get(WATCHDOG)) await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  if (state.status === "BREAK_SCHEDULED" && state.scheduledAt && state.scheduledAt > Date.now()) {
    await chrome.alarms.create(BREAK_ALARM, { when: state.scheduledAt });
  } else await chrome.alarms.clear(BREAK_ALARM);
  if (state.backPending) {
    const when = Math.max(Date.now() + 3e4, state.snoozeUntil ?? (state.lastReminderAt ?? Date.now()) + 5 * 6e4);
    const existing = await chrome.alarms.get(REMINDER_ALARM);
    if (!existing || state.snoozeUntil && Math.abs(existing.scheduledTime - when) > 1e3) await chrome.alarms.create(REMINDER_ALARM, { when });
  } else await chrome.alarms.clear(REMINDER_ALARM);
}
async function loaded(tabId) {
  const initial = await chrome.tabs.get(tabId);
  if (initial.discarded) await chrome.tabs.reload(tabId);
  else if (initial.status === "complete") return;
  await new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        done();
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      done();
      reject(new Error("Cliq did not finish loading. Sign in and retry."));
    }, 2e4);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") {
        done();
        resolve();
      }
    }).catch(() => {
      done();
      reject(new Error("Cliq tab was closed."));
    });
  });
}
async function chooseTab(group, open = false, custom, forceNew = false) {
  const tabs = await chrome.tabs.query({ url: "https://cliq.zoho.com/*" });
  const exact = !forceNew && tabs.find((t) => isGroupUrl(t.url ?? "", group, custom));
  if (exact?.id !== void 0) {
    if (open) {
      await chrome.tabs.update(exact.id, { active: true });
      await chrome.windows.update(exact.windowId, { focused: true });
    }
    await loaded(exact.id);
    return { id: exact.id, created: false };
  }
  const tab = await chrome.tabs.create({ url: groupUrl(group, custom), active: open });
  await loaded(tab.id);
  return { id: tab.id, created: true };
}
async function findTab(group, open = false, custom) {
  return (await chooseTab(group, open, custom)).id;
}
async function connect(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "BB_PING" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }
}
async function ready(tabId, group, profile, custom) {
  await connect(tabId);
  const response = await chrome.tabs.sendMessage(tabId, { type: "BB_READY", group, profile, destination: custom });
  if (!response?.ok) throw new Error(response?.error ?? "Cliq did not initialize the selected conversation.");
}
async function prepareDestination(group, profile, custom) {
  const selected = await chooseTab(group, false, custom);
  try {
    await ready(selected.id, group, profile, custom);
    return selected.id;
  } catch (error) {
    if (selected.created) throw new Error(`The destination tab could not become ready. Check that Cliq is signed in and online. ${error instanceof Error ? error.message : String(error)}`);
    const fresh = await chooseTab(group, false, custom, true);
    try {
      await ready(fresh.id, group, profile, custom);
      return fresh.id;
    } catch (nextError) {
      throw new Error(`The destination did not load in the background. Sign in to Cliq or open the destination and retry. ${nextError instanceof Error ? nextError.message : String(nextError)}`);
    }
  }
}
async function inspect(group, profile, check = false, custom) {
  const tabId = check ? await prepareDestination(group, profile, custom) : await findTab(group, false, custom);
  if (!check) await connect(tabId);
  return chrome.tabs.sendMessage(tabId, { type: check ? "BB_CHECK" : "BB_INSPECT", group, profile, destination: custom });
}
async function sendMessage(operation, profile) {
  let started = false;
  try {
    const tabId = await prepareDestination(operation.group, profile, operation.destination);
    started = true;
    const result = await chrome.tabs.sendMessage(tabId, { type: "BB_SEND", operation, profile });
    if (!result || result.id !== operation.id || !["confirmed", "failed", "uncertain"].includes(result.outcome)) throw new Error("Invalid submission response.");
    if (profile.acknowledged === "@fresh-chat" && result.outcome === "uncertain" && result.messageId) {
      const verifier = await chrome.tabs.create({ url: groupUrl(operation.group, operation.destination), active: false });
      await loaded(verifier.id);
      await ready(verifier.id, operation.group, profile, operation.destination);
      const proof = await chrome.tabs.sendMessage(verifier.id, { type: "BB_VERIFY", operation, profile, messageId: result.messageId });
      if (!proof?.ok || proof.messageId !== result.messageId) return { ...result, detail: "Message appeared locally, but a fresh Cliq view did not confirm it. Check the chat before retrying." };
      const receipt = { ...result, outcome: "confirmed", detail: "The same own message ID and exact text were found in a fresh Cliq view.", at: Date.now() };
      await chrome.storage.local.set({ [`receipt:${operation.id}`]: receipt });
      return receipt;
    }
    return result;
  } catch (error) {
    return { id: operation.id, outcome: started ? "uncertain" : "failed", detail: error instanceof Error ? error.message : String(error), at: Date.now() };
  }
}
async function openCompanion(tab) {
  if (typeof chrome.sidePanel?.open === "function" && typeof tab.windowId === "number") {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    } catch (error) {
      console.warn("BreakBuddy side panel unavailable:", error);
    }
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html"), active: true });
}
function registerPanelAction() {
  chrome.action.onClicked.addListener((tab) => {
    void openCompanion(tab).catch((error) => console.error("BreakBuddy could not open:", error));
  });
}
async function recordPanelVisibility(documentId, windowId, visible) {
  if (Number.isInteger(windowId) && windowId >= 0 && typeof visible === "boolean") {
    await chrome.storage.session.set({ [`panel:${documentId}`]: { windowId, visible } });
  }
}
async function panelVisibleInFocusedWindow() {
  if (!chrome.runtime.getContexts || !chrome.windows.getLastFocused) return false;
  try {
    const [contexts, window] = await Promise.all([
      chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }),
      chrome.windows.getLastFocused({ windowTypes: ["normal"] })
    ]);
    if (!window.focused) return false;
    for (const context of contexts) {
      if (context.windowId === window.id) return true;
      if (context.windowId === -1 && chrome.storage.session) {
        const key = `panel:${context.documentId}`;
        const registered = (await chrome.storage.session.get(key))[key];
        if (registered?.visible && registered.windowId === window.id) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
async function updateBadge(state) {
  const badge = state.backPending ? "BACK" : state.status === "BREAK_SCHEDULED" ? "WAIT" : state.status === "AVAILABLE" ? "" : "!";
  await chrome.action.setBadgeText({ text: badge });
  await chrome.action.setBadgeBackgroundColor({ color: state.backPending ? "#d97706" : "#215e54" });
  await chrome.action.setTitle({ title: `Cliq BreakBuddy · ${state.status.replaceAll("_", " ")}` });
}
async function notify(id, title, message2, buttons = []) {
  await chrome.notifications.create(id, { type: "basic", iconUrl: "icons/icon128.png", title, message: message2, priority: 2, requireInteraction: true, buttons: buttons.map((title2) => ({ title: title2 })) });
}
async function reminderWindow() {
  if (await panelVisibleInFocusedWindow()) return;
  const url = chrome.runtime.getURL("reminder.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.url === url);
  if (existing) return;
  await chrome.windows.create({ url, type: "popup", width: 440, height: 620, focused: false });
}
async function closeReminder() {
  const url = chrome.runtime.getURL("reminder.html");
  for (const tab of await chrome.tabs.query({})) if (tab.url === url) await chrome.tabs.remove(tab.id).catch(() => {
  });
  await chrome.notifications.clear("bb-back");
}
function complete(state, op, receipt, manual = false) {
  if (receipt.outcome === "confirmed") {
    return {
      ...state,
      status: op.text === "Break" ? "BACK_PENDING" : "AVAILABLE",
      scheduledAt: null,
      backPending: op.text === "Break",
      breakSentAt: op.text === "Break" ? receipt.at : state.breakSentAt,
      lastBackAt: op.text === "Back" ? receipt.at : state.lastBackAt,
      submission: "confirmed",
      operation: null,
      snoozeUntil: null,
      lastReminderAt: null,
      error: null,
      history: [{ id: op.id, text: op.text, group: op.group, destination: op.destination, at: receipt.at, proof: manual ? "manual" : "ui" }, ...state.history].slice(0, 40)
    };
  }
  return {
    ...state,
    status: receipt.outcome === "uncertain" ? "UNCERTAIN" : "ERROR",
    submission: receipt.outcome,
    error: receipt.detail,
    operation: op
  };
}
class TelegramError extends Error {
  constructor(message2, retryable = false, retryAfter = 6e4) {
    super(message2);
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
  retryable;
  retryAfter;
}
async function telegramRequest(botToken, method, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), method === "getUpdates" && Number(body.timeout) > 0 ? 25e3 : 8e3);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: "omit",
      redirect: "error"
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new TelegramError("Telegram returned an unreadable response.", true);
    }
    if (!response.ok || data?.ok !== true) {
      const code = data?.error_code ?? response.status;
      if (code === 429) throw new TelegramError("Telegram rate limit reached.", true, Math.min(86400, Math.max(60, Number(data?.parameters?.retry_after) || 60)) * 1e3);
      if (code === 401 || code === 404) throw new TelegramError("Telegram rejected the bot token. Check the token from BotFather.");
      if (code === 403) throw new TelegramError("Telegram blocked this request. Start the bot or give it permission to post in the target chat.");
      if (code === 409) throw new TelegramError("This bot uses a webhook or another update reader. Use a dedicated bot for Telegram buttons.");
      if (code === 400) throw new TelegramError("Telegram could not complete this request. Check the chat ID, start the bot, and check its posting permissions.");
      throw new TelegramError("Telegram could not accept the request.", code >= 500);
    }
    return data.result;
  } catch (error) {
    if (error instanceof TelegramError) throw error;
    throw new TelegramError("Telegram is unreachable or timed out. Check your connection.", true);
  } finally {
    clearTimeout(timeout);
  }
}
const emptyConfig = () => ({ enabled: false, botToken: "", chatId: "", enabledAt: 0, controllerId: "" });
const MAX_ATTEMPTS = 5;
async function readTelegramData() {
  const data = await chrome.storage.local.get(["telegramConfig", "telegramReports", "telegramLastReport", "telegramLastAction", "telegramActionsError"]);
  return {
    config: { ...emptyConfig(), ...data.telegramConfig },
    reports: data.telegramReports ?? [],
    lastReport: data.telegramLastReport ?? null,
    lastAction: data.telegramLastAction ?? null,
    actionsError: data.telegramActionsError ?? null
  };
}
const read = readTelegramData;
const controllerFor = (config) => config.controllerId || (/^[1-9]\d*$/.test(config.chatId) ? config.chatId : "");
const breakCycleReference = (state) => state.history.find((h) => h.text === "Break")?.id ?? String(state.breakSentAt ?? "");
async function getTelegramSettings() {
  const { config, reports, lastReport, lastAction, actionsError } = await read();
  return { enabled: config.enabled, chatId: config.chatId, hasToken: Boolean(config.botToken), controllerId: config.controllerId, actionsAvailable: config.enabled && Boolean(controllerFor(config)), actionsError, lastAction, lastReport, pending: reports.filter((r) => r.status === "pending").length };
}
async function saveTelegramSettings(enabled, botToken, chatId, controllerId) {
  if (typeof enabled !== "boolean" || typeof botToken !== "string" || typeof chatId !== "string") throw new Error("Invalid Telegram settings.");
  const { config } = await read();
  const token = botToken.trim() || config.botToken;
  const chat = chatId.trim();
  if (controllerId !== void 0 && typeof controllerId !== "string") throw new Error("Enter a numeric Telegram user ID for buttons.");
  const controller = controllerId === void 0 ? config.controllerId : controllerId.trim();
  if (controller && !/^[1-9]\d{0,19}$/.test(controller)) throw new Error("Enter a numeric Telegram user ID for buttons.");
  if (token && !/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error("Paste the bot token from BotFather.");
  if (chat && !/^(?:-?[1-9]\d{0,19}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(chat)) throw new Error("Enter a numeric Telegram chat ID or an @channel username.");
  if (enabled && (!token || !chat)) throw new Error("Enter a bot token and chat ID before enabling Telegram reports.");
  const changed = config.botToken !== token || config.chatId !== chat || config.enabled !== enabled || config.controllerId !== controller;
  await chrome.storage.local.set({
    telegramConfig: { enabled, botToken: token, chatId: chat, controllerId: controller, enabledAt: changed ? Date.now() : config.enabledAt },
    ...changed ? { telegramReports: [], telegramLastReport: null, telegramLastAction: null, telegramActionsError: null, telegramActionPoll: {}, telegramBreakSchedule: null, telegramCustomSchedules: {} } : {}
  });
  return getTelegramSettings();
}
async function disconnectTelegram() {
  await chrome.storage.local.set({ telegramConfig: emptyConfig(), telegramReports: [], telegramLastReport: null, telegramLastAction: null, telegramActionsError: null, telegramActionPoll: {}, telegramBreakSchedule: null, telegramCustomSchedules: {} });
  return getTelegramSettings();
}
const send = (config, text, buttons) => telegramRequest(config.botToken, "sendMessage", {
  chat_id: config.chatId,
  text,
  link_preview_options: { is_disabled: true },
  ...buttons?.length ? { reply_markup: { inline_keyboard: buttons.map((button) => [{ text: button.label, callback_data: `bb:${button.token}` }]) } } : {}
});
async function findTelegramChats(botToken) {
  if (typeof botToken !== "string") throw new Error("Invalid bot token.");
  const { config } = await read();
  const token = botToken.trim() || config.botToken;
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error("Paste the bot token from BotFather first.");
  const updates = await telegramRequest(token, "getUpdates", { timeout: 0, limit: 100, allowed_updates: ["message", "channel_post", "my_chat_member", "callback_query"] });
  const chats = /* @__PURE__ */ new Map();
  if (Array.isArray(updates)) for (const update of updates) {
    const chat = update.message?.chat ?? update.channel_post?.chat ?? update.my_chat_member?.chat;
    if (chat && Number.isSafeInteger(chat.id)) chats.set(String(chat.id), { id: String(chat.id), name: String(chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.id) });
  }
  if (!chats.size) throw new Error("No chats found. Open your bot in Telegram, send /start (or a command addressed to it in your group), then find chats again.");
  return [...chats.values()];
}
async function recordResult(ok, detail) {
  await chrome.storage.local.set({ telegramLastReport: { ok, detail, at: Date.now() } });
}
async function testTelegram() {
  const { config } = await read();
  if (!config.botToken || !config.chatId) throw new Error("Save your Telegram bot token and chat ID first.");
  try {
    await send(config, "BreakBuddy test: Telegram reports are connected. You will receive Cliq delivery results here when reports are enabled.");
  } catch (error) {
    await recordResult(false, error.message);
    throw error;
  }
  await recordResult(true, "Telegram test sent successfully.");
  return getTelegramSettings();
}
const localTime = (at) => new Date(at).toLocaleString(void 0, { dateStyle: "medium", timeStyle: "long" });
function message(outcome, text, destination, detail, at, manual = false, subject = "Break") {
  const title = { scheduled: `${subject} scheduled`, rescheduled: `${subject} rescheduled`, cancelled: `${subject} schedule cancelled`, "back-pending": "Back is still pending", snoozed: "Back reminder snoozed", confirmed: "Message successfully sent", failed: "Message was not sent", uncertain: "Delivery uncertain — check Cliq", overdue: "Scheduled message was missed — not sent" }[outcome];
  const time = ["scheduled", "rescheduled"].includes(outcome) ? `Scheduled for: ${localTime(at)}` : `Time: ${new Date(at).toISOString()}`;
  return [
    `BreakBuddy: ${title}`,
    `Chat: ${destination?.name ?? "Saved Cliq destination"}`,
    `Message: ${text.length > 200 ? text.slice(0, 200) + "…" : text}`,
    time,
    manual ? "Confirmed by your manual review." : outcome === "confirmed" ? "Confirmed by Cliq UI verification." : detail.slice(0, 400),
    ...outcome === "uncertain" ? ["Check this exact attempt in Cliq before retrying."] : []
  ].join("\n");
}
async function enqueue(id, outcome, text, destination, detail, at, manual = false, buttons = [], subject = "Break") {
  const { config, reports } = await read();
  if (!config.enabled || at < config.enabledAt || reports.some((r) => r.id === id)) return;
  const report = {
    id,
    text: message(outcome, text, destination, detail, at, manual, subject),
    status: "pending",
    attempts: 0,
    nextAt: 0,
    ...controllerFor(config) && buttons.length ? { buttons: buttons.map((button) => ({ ...button, token: crypto.randomUUID().replaceAll("-", "") })) } : {}
  };
  await chrome.storage.local.set({ telegramReports: [...reports, report].slice(-300) });
}
async function queueTelegramState(state) {
  try {
    if (!(await read()).config.enabled) return;
    const data = await chrome.storage.local.get(["telegramBreakSchedule"]);
    const previous = data.telegramBreakSchedule;
    if (["BREAK_SCHEDULED", "OVERDUE"].includes(state.status) && state.scheduledAt) {
      const destination = destinationFor(state.group, state.customDestination);
      const buttons = [{ label: "Cancel schedule", action: { kind: "cancel-break", reference: String(state.scheduledAt) } }];
      if (previous?.active && previous.scheduledAt !== state.scheduledAt) await enqueue(`break:${previous.scheduledAt}:${state.scheduledAt}:rescheduled`, "rescheduled", "Break", destination, `Previous time: ${localTime(previous.scheduledAt)}`, state.scheduledAt, false, buttons);
      else if (state.status === "BREAK_SCHEDULED" && !previous?.active) await enqueue(`break:${state.scheduledAt}:scheduled`, "scheduled", "Break", destination, "You will receive a separate report when the send is attempted.", state.scheduledAt, false, buttons);
      await chrome.storage.local.set({ telegramBreakSchedule: { scheduledAt: state.scheduledAt, destination, active: true } });
    } else if (previous?.active) {
      if (state.status === "AVAILABLE") await enqueue(`break:${previous.scheduledAt}:cancelled`, "cancelled", "Break", previous.destination, "No further send will be attempted for this schedule.", Date.now());
      await chrome.storage.local.set({ telegramBreakSchedule: { ...previous, active: false } });
    }
    const cycle = breakCycleReference(state);
    const backButtons = state.backPending && ["BACK_PENDING", "ERROR"].includes(state.status) ? [
      { label: "I'm Back — Send Back", action: { kind: "back", reference: cycle } },
      { label: "Remind in 5 minutes", action: { kind: "snooze", reference: cycle } }
    ] : [];
    for (const entry of [...state.history].reverse()) await enqueue(`${entry.id}:confirmed`, "confirmed", entry.text, entry.destination, "", entry.at, entry.proof === "manual", entry.id === cycle ? backButtons : []);
    const op = state.operation;
    if (op && (state.status === "ERROR" || state.status === "UNCERTAIN")) {
      const outcome = state.status === "ERROR" ? "failed" : "uncertain";
      await enqueue(`${op.id}:${outcome}`, outcome, op.text, op.destination, state.error ?? "", op.startedAt);
    }
    if (state.status === "OVERDUE" && state.scheduledAt) await enqueue(`break:${state.scheduledAt}:overdue`, "overdue", "Break", destinationFor(state.group, state.customDestination), state.error ?? "", state.scheduledAt);
    if (state.backPending && state.lastReminderAt && state.lastReminderAt - (state.breakSentAt ?? state.lastReminderAt) >= 6e4) await enqueue(`${cycle}:${state.lastReminderAt}:back-pending`, "back-pending", "Back", destinationFor(state.group, state.customDestination), state.status === "UNCERTAIN" ? "Check the uncertain attempt in BreakBuddy before sending again." : "Confirm your return when you are ready. Back is never sent automatically.", state.lastReminderAt, false, backButtons);
    if (state.backPending && state.snoozeUntil && state.snoozeUntil > Date.now()) await enqueue(`${cycle}:${state.snoozeUntil}:snoozed`, "snoozed", "Back", destinationFor(state.group, state.customDestination), `Next reminder: ${localTime(state.snoozeUntil)}`, state.snoozeUntil - 5 * 6e4, false, backButtons);
  } catch {
    console.warn("BreakBuddy: Could not queue a Telegram report.");
  }
}
async function queueTelegramJobs(jobs) {
  try {
    if (!(await read()).config.enabled) return;
    const { telegramCustomSchedules: previous = {} } = await chrome.storage.local.get(["telegramCustomSchedules"]);
    const schedules = {};
    for (const job of jobs) {
      if (job.status === "scheduled") {
        schedules[job.id] = job.scheduledAt;
        const changed = previous[job.id] && previous[job.id] !== job.scheduledAt;
        if (!previous[job.id] || changed) await enqueue(
          `custom:${job.id}:${job.scheduledAt}:${changed ? "rescheduled" : "scheduled"}`,
          changed ? "rescheduled" : "scheduled",
          job.text,
          job.destination,
          changed ? `Previous time: ${localTime(previous[job.id])}` : "You will receive a separate report when the send is attempted.",
          job.scheduledAt,
          false,
          [{ label: "Cancel schedule", action: { kind: "cancel-custom", jobId: job.id, reference: String(job.scheduledAt) } }],
          "Custom message"
        );
        continue;
      }
      if (job.status === "cancelled") {
        if (job.at) await enqueue(`custom:${job.id}:cancelled`, "cancelled", job.text, job.destination, "No further send will be attempted for this schedule.", job.at, false, [], "Custom message");
        continue;
      }
      if (!["sent", "failed", "uncertain", "overdue"].includes(job.status)) continue;
      const outcome = job.status === "sent" ? "confirmed" : job.status;
      await enqueue(
        `${job.operation?.id ?? job.id}:${outcome}`,
        outcome,
        job.text,
        job.destination,
        job.detail,
        job.at ?? job.operation?.startedAt ?? job.scheduledAt,
        job.status === "sent" && job.detail === "Delivery confirmed after review."
      );
    }
    await chrome.storage.local.set({ telegramCustomSchedules: schedules });
  } catch {
    console.warn("BreakBuddy: Could not queue a Telegram report.");
  }
}
async function flushTelegramReports() {
  try {
    const { config, reports } = await read();
    if (!config.enabled) return;
    if (reports.some((r) => r.status !== "sent" && r.nextAt > Date.now())) return;
    for (const report of reports.filter((r) => r.status === "pending" && r.nextAt <= Date.now()).slice(0, 3)) {
      report.attempts++;
      report.nextAt = Date.now() + 6e4;
      await chrome.storage.local.set({ telegramReports: reports });
      try {
        const result = await send(config, report.text, report.buttons);
        if (Number.isSafeInteger(result?.message_id)) report.messageIds = [...report.messageIds ?? [], result.message_id].slice(-MAX_ATTEMPTS);
        report.status = "sent";
        await recordResult(true, "Telegram report sent.");
      } catch (error) {
        const failure = error;
        report.status = failure.retryable && report.attempts < MAX_ATTEMPTS ? "pending" : "failed";
        report.nextAt = Date.now() + Math.max(failure.retryAfter, 6e4 * report.attempts);
        await recordResult(false, `${failure.message}${report.status === "pending" ? " A retry is queued." : " Save corrected settings to reconnect."}`);
        await chrome.storage.local.set({ telegramReports: reports });
        break;
      }
      await chrome.storage.local.set({ telegramReports: reports });
    }
  } catch {
    console.warn("BreakBuddy: Telegram reporting is unavailable.");
  }
}
async function queueTelegramActionFeedback(id, detail) {
  const { config, reports } = await read();
  if (!config.enabled || reports.some((r) => r.id === id)) return;
  await chrome.storage.local.set({ telegramReports: [...reports, { id, text: `BreakBuddy: ${detail}`, status: "pending", attempts: 0, nextAt: 0 }].slice(-300) });
}
const CUSTOM_ALARM = "breakbuddy-custom";
const emptyDraft = () => ({ text: "", url: "", name: "", minutes: 30, timing: "delay", sendAt: "" });
async function readCustom() {
  const data = await chrome.storage.local.get(["customJobs", "customDraft", "destinations", "state"]);
  if (!data.destinations && data.state?.customDestination) {
    try {
      data.destinations = [parseCustomDestination(data.state.customDestination.url, data.state.customDestination.name)];
      await chrome.storage.local.set({ destinations: data.destinations });
    } catch {
    }
  }
  return { jobs: data.customJobs ?? [], draft: { ...emptyDraft(), ...data.customDraft }, destinations: data.destinations ?? [] };
}
async function saveDestination(url, name) {
  const destination = parseCustomDestination(url, name);
  const { destinations } = await readCustom();
  await chrome.storage.local.set({ destinations: [...destinations.filter((d) => d.url !== destination.url), destination] });
  return destination;
}
async function storeJobs(jobs) {
  const active = jobs.filter((j) => !["sent", "cancelled"].includes(j.status));
  const done = jobs.filter((j) => ["sent", "cancelled"].includes(j.status)).slice(0, 40);
  await chrome.storage.local.set({ customJobs: [...active, ...done] });
  await queueTelegramJobs([...active, ...done]);
  await restoreCustomAlarm([...active, ...done]);
}
async function restoreCustomAlarm(jobs) {
  const deadlines = jobs.filter((j) => j.status === "scheduled").map((j) => j.scheduledAt);
  if (deadlines.length) {
    const deadline = Math.min(...deadlines);
    const now = Date.now();
    const existing = await chrome.alarms.get(CUSTOM_ALARM);
    if (existing && (existing.scheduledTime === deadline || deadline <= now && existing.scheduledTime > now && existing.scheduledTime <= now + 1e3)) return;
    await chrome.alarms.create(CUSTOM_ALARM, { when: Math.max(now + 1e3, deadline) });
  } else await chrome.alarms.clear(CUSTOM_ALARM);
}
function applyReceipt(job, receipt) {
  return { ...job, status: receipt.outcome === "confirmed" ? "sent" : receipt.outcome === "failed" ? "failed" : "uncertain", detail: receipt.detail, at: receipt.at };
}
async function perform$1(jobs, id) {
  const index = jobs.findIndex((j) => j.id === id);
  const job = jobs[index];
  const operation = { id: crypto.randomUUID(), kind: "custom", text: job.text, group: "custom", destination: { ...job.destination }, startedAt: Date.now() };
  jobs[index] = { ...job, status: "sending", operation, detail: "Sending and checking delivery…" };
  await storeJobs(jobs);
  jobs[index] = applyReceipt(jobs[index], await sendMessage(operation, job.profile));
  await storeJobs(jobs);
  try {
    await notify(`bb-custom-${id}`, jobs[index].status === "sent" ? "Scheduled message sent" : "Check your scheduled message", `${job.destination.name}: ${jobs[index].status === "sent" ? "Delivery confirmed." : jobs[index].detail}`);
  } catch {
  }
}
async function recoverCustom(allowSend = false, startup = false) {
  const { jobs } = await readCustom();
  let changed = false;
  for (let i = 0; i < jobs.length; i++) {
    let job = jobs[i];
    if (job.status === "sending") {
      const key = `receipt:${job.operation?.id}`;
      const receipt = (await chrome.storage.local.get(key))[key];
      job = receipt ? applyReceipt(job, receipt) : { ...job, status: "uncertain", detail: "Browser interrupted the send. Check this exact message in Cliq before resolving." };
      jobs[i] = job;
      changed = true;
    }
    if (job.status === "scheduled" && job.scheduledAt <= Date.now()) {
      if (startup || Date.now() - job.scheduledAt > LATE_GRACE_MS) {
        jobs[i] = { ...job, status: "overdue", detail: "Scheduled time was missed. Choose Send now or Cancel." };
        changed = true;
        try {
          await notify(`bb-custom-${job.id}`, "Missed scheduled message", `Open Custom Message to send or cancel your message to ${job.destination.name}.`);
        } catch {
        }
      } else if (allowSend) await perform$1(jobs, job.id);
    }
  }
  if (changed) await storeJobs(jobs);
  else await restoreCustomAlarm(jobs);
  await queueTelegramJobs(jobs);
}
async function customCommand(command, profile) {
  const data = await readCustom();
  if (command.type === "GET_CUSTOM") return data;
  if (command.type === "SAVE_CUSTOM_DRAFT") {
    const d = command.draft;
    if (typeof d.text !== "string" || d.text.length > 2e4 || typeof d.url !== "string" || typeof d.name !== "string" || d.url.length > 2e3 || d.name.length > 100) throw new Error("Invalid message draft.");
    await chrome.storage.local.set({ customDraft: d });
    return { ...data, draft: d };
  }
  if (command.type === "SAVE_DESTINATION") {
    await saveDestination(command.url, command.name);
    return readCustom();
  }
  if (command.type === "REMOVE_DESTINATION") {
    await chrome.storage.local.set({ destinations: data.destinations.filter((d) => d.url !== command.url) });
    return readCustom();
  }
  if (command.type === "SCHEDULE_CUSTOM") {
    if (typeof command.text !== "string" || !command.text.trim() || command.text.length > 2e4) throw new Error("Enter a message of 1–20,000 characters.");
    if (!Number.isSafeInteger(command.scheduledAt) || command.scheduledAt <= Date.now() || command.scheduledAt > 864e13) throw new Error("Choose a future date and time.");
    if (data.jobs.filter((j) => !["sent", "cancelled"].includes(j.status)).length >= 20) throw new Error("Finish or cancel a pending message before adding more (20 maximum).");
    const destination = parseCustomDestination(command.url, command.name);
    const check = await inspect("custom", profile, true, destination);
    if (!check.ok) throw new Error(check.error ?? "Check the custom destination.");
    if (command.scheduledAt <= Date.now()) throw new Error("Your selected time passed while Cliq was loading. Choose a new future time and schedule again.");
    const job = { id: crypto.randomUUID(), text: command.text.replace(/\r\n?/g, "\n").trim(), destination, profile: { ...profile }, scheduledAt: command.scheduledAt, status: "scheduled", operation: null, detail: "Scheduled" };
    await saveDestination(command.url, command.name);
    await storeJobs([job, ...data.jobs]);
    return readCustom();
  }
  if (command.type === "CUSTOM_ACTION") {
    const index = data.jobs.findIndex((j) => j.id === command.id);
    if (index < 0) throw new Error("Scheduled message not found.");
    const job = data.jobs[index];
    if (command.action === "cancel") {
      if (!["scheduled", "overdue", "failed"].includes(job.status)) throw new Error("This message cannot be cancelled during an uncertain send.");
      data.jobs[index] = { ...job, status: "cancelled", at: Date.now(), detail: "Cancelled without sending." };
    } else if (command.action === "send" || command.action === "retry") {
      if (job.status !== (command.action === "send" ? "overdue" : "failed")) throw new Error("Check the message status before sending.");
      await perform$1(data.jobs, job.id);
      return readCustom();
    } else if (command.action === "resolve") {
      if (job.status !== "uncertain" || !job.operation || !command.checked) throw new Error("Check this exact attempt in Cliq and acknowledge the check.");
      const key = `receipt:${job.operation.id}`;
      const receipt = (await chrome.storage.local.get(key))[key];
      if (receipt?.outcome === "confirmed" || command.delivered) data.jobs[index] = { ...job, status: "sent", detail: "Delivery confirmed after review.", at: Date.now() };
      else {
        if (Date.now() - job.operation.startedAt < 9e4) throw new Error("Wait 90 seconds after the attempt, then check Cliq again before allowing a retry.");
        data.jobs[index] = { ...job, status: "failed", detail: "You confirmed the message is absent. Remove any leftover draft before retrying." };
      }
    }
    await storeJobs(data.jobs);
    return readCustom();
  }
  throw new Error("Unknown custom message command.");
}
const TELEGRAM_POLL_ALARM = "breakbuddy-telegram-actions";
const generation = (config) => `${config.enabledAt}:${config.botToken.split(":")[0]}:${config.chatId}:${config.controllerId}`;
const pollFor = (config, poll) => poll?.generation === generation(config) ? poll : {};
async function restoreTelegramPolling() {
  const { config } = await readTelegramData();
  if (!config.enabled || !controllerFor(config)) {
    await chrome.alarms.clear(TELEGRAM_POLL_ALARM);
    return;
  }
  if (!await chrome.alarms.get(TELEGRAM_POLL_ALARM)) await chrome.alarms.create(TELEGRAM_POLL_ALARM, { periodInMinutes: 0.5 });
}
async function fetchTelegramActions() {
  const { config } = await readTelegramData();
  if (!config.enabled || !controllerFor(config)) return null;
  const stored = await chrome.storage.local.get(["telegramActionPoll"]);
  const poll = pollFor(config, stored.telegramActionPoll);
  if (poll.nextAt > Date.now()) return null;
  await chrome.storage.local.set({ telegramActionPoll: { ...poll, generation: generation(config), nextAt: Date.now() + 3e4 } });
  try {
    const updates = await telegramRequest(config.botToken, "getUpdates", {
      timeout: 20,
      limit: 25,
      allowed_updates: ["message", "channel_post", "my_chat_member", "callback_query"],
      ...Number.isSafeInteger(poll.offset) ? { offset: poll.offset } : {}
    });
    if (!Array.isArray(updates)) throw new TelegramError("Telegram returned an unreadable update list.", true);
    return { config, updates };
  } catch (error) {
    const current = (await readTelegramData()).config;
    if (current.botToken === config.botToken && current.enabledAt === config.enabledAt) {
      const stored2 = await chrome.storage.local.get(["telegramActionPoll"]);
      const latest = pollFor(config, stored2.telegramActionPoll);
      await chrome.storage.local.set({
        telegramActionsError: error.message,
        telegramActionPoll: { ...latest, generation: generation(config), nextAt: Date.now() + Math.max(6e4, error.retryAfter ?? 0) }
      });
    }
    return null;
  }
}
function matchesChat(config, chat) {
  if (!chat) return false;
  return config.chatId.startsWith("@") ? typeof chat.username === "string" && `@${chat.username}`.toLowerCase() === config.chatId.toLowerCase() : String(chat.id) === config.chatId;
}
async function answer(token, queryId, text) {
  try {
    await telegramRequest(token, "answerCallbackQuery", { callback_query_id: queryId, text: text.slice(0, 190) });
  } catch {
  }
}
async function processTelegramActions(batch, execute) {
  let current = await readTelegramData();
  if (!current.config.enabled || current.config.botToken !== batch.config.botToken || current.config.enabledAt !== batch.config.enabledAt || current.config.controllerId !== batch.config.controllerId || current.config.chatId !== batch.config.chatId) return;
  await chrome.storage.local.set({ telegramActionsError: null });
  for (const update of batch.updates.filter((update2) => update2 && Number.isSafeInteger(update2.update_id)).sort((a, b) => a.update_id - b.update_id)) {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) continue;
    const stored = await chrome.storage.local.get(["telegramActionPoll"]);
    const poll = pollFor(batch.config, stored.telegramActionPoll);
    if (Number.isSafeInteger(poll.offset) && update.update_id < poll.offset) continue;
    await chrome.storage.local.set({ telegramActionPoll: { ...poll, generation: generation(batch.config), offset: update.update_id + 1 } });
    const query = update.callback_query;
    if (!query || typeof query.id !== "string") continue;
    current = await readTelegramData();
    const { config, reports } = current;
    if (!matchesChat(config, query.message?.chat) || String(query.from?.id) !== controllerFor(config) || query.from?.is_bot || query.message?.date === 0) {
      await answer(config.botToken, query.id, "This action is not available for this user or chat.");
      continue;
    }
    const token = typeof query.data === "string" && /^bb:[a-f0-9]{32}$/.test(query.data) ? query.data.slice(3) : "";
    const report = reports.find((r) => r.buttons?.some((b) => b.token === token));
    const button = report?.buttons?.find((b) => b.token === token);
    if (!report || !button || button.used || !report.messageIds?.includes(query.message.message_id)) {
      await answer(config.botToken, query.id, "This button was already used or is no longer available.");
      continue;
    }
    for (const entry of report.buttons ?? []) entry.used = true;
    await chrome.storage.local.set({ telegramReports: reports, telegramLastAction: { ok: true, detail: "Processing Telegram action…", at: Date.now() } });
    await answer(config.botToken, query.id, "Processing your request. Check the follow-up report.");
    let ok = true;
    let detail;
    try {
      detail = await execute(button.action);
    } catch (error) {
      ok = false;
      detail = `Action not applied: ${(error instanceof Error ? error.message : String(error)).replaceAll(config.botToken, "[hidden]").slice(0, 350)}`;
    }
    await chrome.storage.local.set({ telegramLastAction: { ok, detail, at: Date.now() } });
    if (!ok) await queueTelegramActionFeedback(`action:${token}:rejected`, detail);
    try {
      await telegramRequest(config.botToken, "editMessageReplyMarkup", { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
    } catch {
    }
  }
}
function commandForTelegramAction(action, state, jobs) {
  if (action.kind === "back" || action.kind === "snooze") {
    if (!state.backPending || action.reference !== breakCycleReference(state)) throw new Error("This Break/Back cycle has ended. Use the latest Telegram reminder.");
    if (!["BACK_PENDING", "ERROR"].includes(state.status)) throw new Error("Resolve the current message attempt in BreakBuddy before using this button.");
    return { type: action.kind === "back" ? "BACK" : "SNOOZE" };
  }
  if (action.kind === "cancel-break") {
    if (!["BREAK_SCHEDULED", "OVERDUE"].includes(state.status) || String(state.scheduledAt) !== action.reference) throw new Error("This Break schedule has changed or already started.");
    return { type: "CANCEL" };
  }
  if (action.kind === "cancel-custom") {
    const job = jobs.find((j) => j.id === action.jobId);
    if (!job || !["scheduled", "overdue"].includes(job.status) || String(job.scheduledAt) !== action.reference) throw new Error("This custom schedule has changed or already started.");
    return { type: "CUSTOM_ACTION", id: job.id, action: "cancel" };
  }
  throw new Error("Unknown Telegram action.");
}
let queue = Promise.resolve();
let telegramPoll = null;
let telegramPollRequest = null;
function serial(task) {
  const result = queue.then(async () => {
    try {
      return await task();
    } finally {
      await flushTelegramReports();
      await auxiliary(restoreTelegramPolling);
    }
  });
  queue = result.catch(() => {
  });
  return result;
}
async function save(s) {
  await writeState(s);
  await queueTelegramState(s);
  await updateBadge(s);
}
async function auxiliary(task) {
  try {
    await task();
  } catch (error) {
    console.warn("BreakBuddy reminder:", error);
  }
}
async function remind(s, force = false) {
  if (!s.backPending || s.status === "SENDING_BACK" || (s.snoozeUntil ?? 0) > Date.now()) return;
  if (!force && Date.now() - (s.lastReminderAt ?? 0) < 5 * 6e4) return;
  s.lastReminderAt = Date.now();
  await save(s);
  if (s.status === "UNCERTAIN") await auxiliary(() => notify("bb-error", "Check your Back message", "A submission is uncertain. Open BreakBuddy to check and resolve it.", ["Open BreakBuddy"]));
  else await auxiliary(() => notify("bb-back", "Have you returned?", "Your Break message was sent. Confirm your return to send Back.", ["I'm Back — Send Back", "Remind Me Later"]));
  if (await chrome.idle.queryState(60) === "active") await auxiliary(reminderWindow);
}
async function perform(s, text) {
  if (s.group !== "test" && !s.productionEnabled) throw new Error("Production mode requires explicit confirmation in Settings.");
  if (text === "Back" && !s.backPending) throw new Error("There is no Back message pending.");
  const op = { id: crypto.randomUUID(), text, group: s.group, destination: destinationFor(s.group, s.customDestination), startedAt: Date.now() };
  s = { ...s, operation: op, status: text === "Break" ? "SENDING_BREAK" : "SENDING_BACK", submission: "sending", error: null };
  await save(s);
  const result = await sendMessage(op, s.profile);
  s = complete(s, op, result);
  await save(s);
  await restoreAlarms(s);
  if (result.outcome === "confirmed") {
    if (text === "Break") await remind(s, true);
    else {
      await auxiliary(closeReminder);
      await auxiliary(() => notify("bb-sent", "You’re available", `Back confirmed in ${destinationFor(s.group, s.customDestination).name}.`));
    }
  } else await auxiliary(() => notify("bb-error", result.outcome === "uncertain" ? "Check your chat before retrying" : "Message was not sent", result.detail, ["Open BreakBuddy"]));
  return s;
}
async function recover(allowDueSend = true, startup = false) {
  let s = await readState();
  if (s.status === "SENDING_BREAK" || s.status === "SENDING_BACK") {
    const op = s.operation;
    const receipt = op ? (await chrome.storage.local.get(`receipt:${op.id}`))[`receipt:${op.id}`] : void 0;
    if (op && receipt) s = complete(s, op, receipt);
    else s = { ...s, status: "UNCERTAIN", submission: "uncertain", error: "Chrome interrupted a send. Check the destination chat before resolving this attempt." };
    await save(s);
  }
  const due = dueDecision(s, Date.now());
  if (due === "overdue" || startup && due === "send") {
    s = { ...s, status: "OVERDUE", error: "Your scheduled Break was missed. Choose Send now or Cancel." };
    await save(s);
    await auxiliary(() => notify("bb-overdue", "Missed scheduled Break", "Chrome or the device was unavailable. Send the Break now?", ["Send now", "Cancel"]));
  } else if (due === "send" && allowDueSend) s = await perform(s, "Break");
  await updateBadge(s);
  await restoreAlarms(s);
  await remind(s, startup);
  await recoverCustom(allowDueSend, startup);
  await queueTelegramState(s);
  return s;
}
async function handle(command) {
  let s = await recover(false);
  if (["GET_CUSTOM", "SAVE_CUSTOM_DRAFT", "SCHEDULE_CUSTOM", "CUSTOM_ACTION", "SAVE_DESTINATION", "REMOVE_DESTINATION"].includes(command.type)) return customCommand(command, s.profile);
  switch (command.type) {
    case "GET_TELEGRAM":
      return getTelegramSettings();
    case "SAVE_TELEGRAM":
      return saveTelegramSettings(command.enabled, command.botToken, command.chatId, command.controllerId);
    case "TEST_TELEGRAM":
      return testTelegram();
    case "DISCONNECT_TELEGRAM":
      return disconnectTelegram();
    case "FIND_TELEGRAM_CHATS":
      if (telegramPollRequest) await telegramPollRequest;
      return findTelegramChats(command.botToken);
    case "GET":
      return s;
    case "SCHEDULE":
      if (s.status !== "AVAILABLE") throw new Error("Finish or cancel the current break first.");
      if (s.group !== "test" && !s.productionEnabled) throw new Error("Enable your Break/Back destination in Settings first.");
      if (!validMinutes(command.minutes)) throw new Error("Enter a positive whole number of minutes that fits a valid future date.");
      if (Object.values(s.profile).some((v) => !v.trim())) throw new Error("Complete and check the Cliq selector setup in Settings first.");
      {
        const check = await inspect(s.group, s.profile, true, s.customDestination);
        if (!check.ok) throw new Error(check.error ?? "Setup check failed.");
      }
      s = { ...s, status: "BREAK_SCHEDULED", scheduledAt: Date.now() + command.minutes * 6e4, submission: "none", error: null, operation: null };
      await save(s);
      await restoreAlarms(s);
      return s;
    case "CANCEL":
      if (!["BREAK_SCHEDULED", "OVERDUE"].includes(s.status) && !(s.status === "ERROR" && !s.backPending)) throw new Error("This send cannot be cancelled.");
      s = { ...s, status: "AVAILABLE", scheduledAt: null, error: null, operation: null, submission: "none" };
      await save(s);
      await chrome.alarms.clear(BREAK_ALARM);
      await chrome.notifications.clear("bb-overdue");
      return s;
    case "SEND_NOW":
      if (s.status !== "OVERDUE") throw new Error("No missed Break is waiting.");
      await chrome.notifications.clear("bb-overdue");
      return perform(s, "Break");
    case "BACK":
      if (s.status !== "BACK_PENDING" && !(s.status === "ERROR" && s.backPending)) throw new Error("Resolve the current message attempt first.");
      return perform(s, "Back");
    case "RETRY":
      if (s.status !== "ERROR" || !s.operation) throw new Error("Only a definite failed send can be retried.");
      if (s.operation.text !== "Break" && s.operation.text !== "Back") throw new Error("Unsupported break operation.");
      return perform(s, s.operation.text);
    case "RESOLVE": {
      if (s.status !== "UNCERTAIN" || !s.operation || !command.checked) throw new Error("Check the exact message in Cliq and acknowledge that check first.");
      const key = `receipt:${s.operation.id}`;
      const receipt = (await chrome.storage.local.get(key))[key];
      if (receipt?.outcome === "confirmed" || command.delivered) s = complete(s, s.operation, receipt?.outcome === "confirmed" ? receipt : { id: s.operation.id, outcome: "confirmed", detail: "User checked the chat", at: Date.now() }, receipt?.outcome !== "confirmed");
      else {
        if (Date.now() - s.operation.startedAt < 9e4) throw new Error("Wait 90 seconds from the attempt so any in-flight submission can finish, then check the chat again.");
        s = { ...s, status: "ERROR", submission: "failed", error: "You confirmed the message is absent. Remove any BreakBuddy draft before retrying." };
      }
      await save(s);
      await restoreAlarms(s);
      if (s.backPending) await remind(s, true);
      else await auxiliary(closeReminder);
      return s;
    }
    case "SNOOZE":
      if (!s.backPending) return s;
      s = { ...s, snoozeUntil: Date.now() + 5 * 6e4 };
      await save(s);
      await restoreAlarms(s);
      await auxiliary(closeReminder);
      return s;
    case "OPEN_CLIQ":
      await findTab(s.group, true, s.customDestination);
      return s;
    case "INSPECT":
      return inspect(s.group, s.profile, false, s.customDestination);
    case "CHECK_SETUP":
      return inspect(s.group, s.profile, true, s.customDestination);
    case "SAVE_CONFIG": {
      if (!["AVAILABLE", "ERROR", "BACK_PENDING"].includes(s.status)) throw new Error("Settings cannot change during an active schedule or uncertain send.");
      if (command.group !== "test" && command.group !== "production" && command.group !== "custom") throw new Error("Unknown group.");
      if (s.status !== "AVAILABLE" && command.group !== s.group) throw new Error("Finish the current break before changing destination.");
      const custom = command.group === "custom" ? parseCustomDestination(command.customUrl ?? "", command.customName ?? "") : s.customDestination;
      const customChanged = command.group === "custom" && JSON.stringify(custom) !== JSON.stringify(s.customDestination);
      if (customChanged && s.status !== "AVAILABLE") throw new Error("Finish the current break before changing destination.");
      if (command.group === "custom" && (!s.productionEnabled || s.group !== "custom" || customChanged) && command.phrase !== "ENABLE CUSTOM") throw new Error("Type ENABLE CUSTOM to enable automatic messages to this destination.");
      if (command.group === "production" && (!s.productionEnabled || s.group !== "production") && command.phrase !== "ENABLE MARTECH") throw new Error("Type ENABLE MARTECH to enable production.");
      if (!command.profile || Object.keys(s.profile).some((k) => typeof command.profile[k] !== "string" || command.profile[k].length > 1e3)) throw new Error("Invalid selector profile.");
      if (command.group === "custom" && custom) await saveDestination(custom.url, custom.name);
      s = { ...s, group: command.group, productionEnabled: command.group !== "test", customDestination: custom, profile: command.profile };
      await save(s);
      return s;
    }
  }
}
const run = (task) => {
  void serial(task).catch((error) => console.error("BreakBuddy:", error));
};
registerPanelAction();
chrome.runtime.onMessage.addListener((command, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")) || !command?.type || command.type.startsWith("BB_")) return false;
  if (command.type === "PANEL_VISIBILITY") {
    if (!sender.documentId || !sender.url.startsWith(chrome.runtime.getURL("sidepanel.html"))) return false;
    void serial(async () => {
      await recordPanelVisibility(sender.documentId, command.windowId, command.visible);
      respond({ ok: true, data: null });
    }).catch((error) => respond({ ok: false, error: String(error) }));
    return true;
  }
  void serial(() => handle(command)).then((data) => respond({ ok: true, data }), (error) => respond({ ok: false, error: String(error.message ?? error) }));
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TELEGRAM_POLL_ALARM) {
    if (!telegramPoll) {
      telegramPollRequest = fetchTelegramActions();
      telegramPoll = telegramPollRequest.then((batch) => {
        if (batch) return serial(() => processTelegramActions(batch, async (action) => {
          const state = await recover(false);
          const command = commandForTelegramAction(action, state, (await readCustom()).jobs);
          await handle(command);
          return action.kind === "back" ? "Back requested. See its delivery report." : action.kind === "snooze" ? "Back reminder snoozed for 5 minutes." : "Schedule cancelled.";
        }));
      }).catch(() => console.warn("BreakBuddy: Telegram actions are unavailable.")).finally(() => {
        telegramPoll = null;
        telegramPollRequest = null;
      });
    }
    return telegramPoll;
  }
  run(() => recover());
});
chrome.runtime.onInstalled.addListener(() => run(() => recover(true, true)));
chrome.runtime.onStartup.addListener(() => run(() => recover(true, true)));
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => {
  if (state === "active") run(async () => {
    await recover();
    await remind(await readState(), true);
  });
});
chrome.windows.onFocusChanged.addListener((id) => {
  if (id !== chrome.windows.WINDOW_ID_NONE) run(() => recover());
});
chrome.notifications.onButtonClicked.addListener((id, index) => {
  const command = id === "bb-back" ? index === 0 ? { type: "BACK" } : { type: "SNOOZE" } : id === "bb-overdue" ? index === 0 ? { type: "SEND_NOW" } : { type: "CANCEL" } : null;
  if (command) run(() => handle(command));
  else run(() => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") }));
});
chrome.notifications.onClicked.addListener(() => run(() => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") })));
run(() => recover(false));
//# sourceMappingURL=background.js.map
