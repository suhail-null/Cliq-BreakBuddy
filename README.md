# Cliq BreakBuddy

A Manifest V3 Chrome extension that schedules `Break` in Zoho Cliq, keeps a persistent **side panel**, **BACK** badge and reminders, and sends `Back` only after your confirmation. React, TypeScript, Vite; no backend, internal Cliq endpoints, or runtime browser automation framework. Optional Telegram delivery reports use your own bot token, stored locally in the extension.

**The extension is built in `extension/` (also available in `dist/`). The built-in Cliq profile now fills the adapter automatically; previous blank settings migrate on upgrade.** The recording shows the chat UI and native scheduling dialog but does not expose DOM selectors. No selectors are represented as verified against your account. No real Cliq messages were sent during development.

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked**, then select this project's **extension** folder.
4. Pin **Cliq BreakBuddy** from Chrome's Extensions menu.
5. Sign in to Cliq in the same Chrome profile. You may then close its tabs. Open BreakBuddy Settings and configure a destination you are authorized to message.

MarTech is the built-in destination and starts disabled until you type **ENABLE MARTECH** in Settings. Custom destinations require **ENABLE CUSTOM** when enabling or changing them. Personal test groups are not included. The destination cannot change during a schedule, unresolved send, or pending Back cycle.

## Persistent side companion ? version 1.1

The toolbar icon now opens a **global side panel**, available beside every tab in that browser window. There is no dismiss-on-blur toolbar popup. Pin BreakBuddy, click its icon, and keep it open while browsing. The available shortcut is **Alt+Shift+B**; manage conflicts in `chrome://extensions/shortcuts`.

The Today, Custom Message, Activity, and Settings views share the same persistent state as reminders. Back pending gets a large orange card and an explicit **I'm Back ? Send Back** action. A notification or badge dismissal cannot clear it. Sending Back or snoozing leaves the side panel open. When the panel is visible in the focused window, an extra reminder popup is suppressed; notifications and the badge still work. With the panel closed or in another window, the reminder-window fallback remains.

**Lock and restart behavior:** the global side panel survives normal tab switches and focus changes while its browser window remains open. A Windows lock/unlock cycle still needs checking on your device. Chrome controls whether the panel is restored after a full browser restart; extensions cannot force `sidePanel.open()` on startup/unlock without a user gesture. If it is not restored, click the toolbar icon once. Back pending, alarms, notifications, and resume reminders recover independently. See [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

The header also offers **Open in a separate window** for a persistent standalone companion. Browsers without the Side Panel API fall back to a normal extension tab. That window/tab remains open after Back is confirmed.

After updating, click **Reload** in `chrome://extensions`, enable the extension if the browser requests the updated permissions, then click its toolbar icon. The build remains in the same `extension` folder. Permissions include `sidePanel` for the browser panel and `tabs` for locating Cliq/reminder tabs across browser windows. Website access covers Cliq and `api.telegram.org` for optional Telegram reports. Telegram is contacted only when reports are enabled or you request chat lookup/a test. No tracking or remote scripts are used.

[Available view](docs/ui-preview/available.png) ? [Back pending](docs/ui-preview/back-pending.png) ? [Narrow panel](docs/ui-preview/narrow-panel.png)

## Change destination later

In Settings, choose **MarTech ? Production** and type **ENABLE MARTECH**, then Save setup. No code changes are needed. Finish the pending Break/Back cycle before switching.

For another conversation, choose **Custom chat / channel URL**, enter its direct URL and exact header title, type **ENABLE CUSTOM**, and Save setup. Supported links are on `https://cliq.zoho.com/company/717321507/chats/<id>` or `/channels/<id>`. The configured selectors must still verify the destination ID, title, editor, and sent acknowledgement. Other domains, companies, query strings, and fragments are rejected. All destinations accept positive whole-minute durations, starting at 1 minute. Both Break and the manually confirmed Back use the saved destination; a cycle cannot switch chats midway.

## Develop and build

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run build
```

Node 22.12+ or 24+ is recommended. PowerShell's execution policy may block `npm.ps1`; `npm.cmd` works without changing policy. Load `extension`, never the project root. Every build refreshes that folder. After source changes, rebuild and click **Reload** for the extension in Chrome. Reload any already-open Cliq pages if you changed the content script.

## Telegram delivery reports — version 1.3

Telegram reports cover Break, Back, and custom messages. They distinguish **successfully sent**, **not sent**, **delivery uncertain**, and **missed schedule**. A success uses the same Cliq UI verification as the extension; manual confirmation is labelled as your review. An uncertain result never claims failure or triggers another Cliq send.

1. Reload the built extension in `chrome://extensions` and accept the added access to `https://api.telegram.org/*` if Chrome asks.
2. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and follow its prompts to create a bot and get a token. See [Telegram's bot creation guide](https://core.telegram.org/bots/features#creating-a-new-bot).
3. Open your new bot and send `/start`. For a group, add the bot and send a command addressed to it, such as `/start@YourBotUsername`.
4. Open BreakBuddy **Settings → Telegram delivery reports**. Paste the bot token, click **Find chat ID**, and select the chat that should receive reports. You can also enter a numeric chat ID manually or use a public channel's `@username`. Channel bots need permission to post. Chat lookup uses [getUpdates](https://core.telegram.org/bots/api#getupdates) without consuming updates; a bot already using a webhook or another update reader may require a dedicated reporting bot or a manually entered chat ID.
5. Enable reports, click **Save Telegram settings**, then **Send Telegram test**. Check that the test arrives in the intended Telegram chat.

Each report includes the Cliq destination name, up to 200 characters of the message, the result time in UTC, and verification/failure details. The token is saved in this browser profile's extension storage, kept out of ordinary state/settings responses and error messages, and never built into the extension or sharing archive. Leave the token blank to preserve it when editing settings. **Disconnect** removes the saved token and reporting queue. Disabling reporting stops Telegram requests; changing the bot, recipient, or enabled setting starts a new reporting session and clears the old queue. Older delivery history is not forwarded on connection.

Reports are queued in local storage and deduplicated by attempt and outcome. The worker recovers queued reports after interruption. Temporary connection failures and rate limits retry up to five times through the existing recovery alarm; invalid tokens/chat permissions are shown in Settings. A Telegram failure never changes a Cliq delivery result or retries a Cliq message. A Telegram alert can repeat if Telegram accepted it just before the worker was interrupted, since the API offers no idempotency key. Chrome must remain running for reports to be delivered; missed schedules can only be reported when Chrome resumes.

Tests mock the Telegram API; live delivery requires completing the setup and sending the test in your own browser profile.

`npm.cmd run dev` serves the React UI, but extension APIs only work in installed extension pages. Click the pinned toolbar icon to open the installed side panel and test the complete flow.

## Built-in Cliq setup

No manual selectors or diagnostic downloads are required for the observed Cliq layout. The built-in profile uses the chat container, ID, title, ProseMirror editor, message rows, ownership marker, and body container identified in your local diagnostic reports. Existing blank selector fields migrate automatically. Existing explicit overrides are preserved; Settings ? **Use built-in Cliq profile** ? **Save setup** restores the standard profile if needed.

1. Reload BreakBuddy in `chrome://extensions` and refresh the Cliq tab after upgrading.
2. Stay signed in to Cliq in this Chrome profile. The destination tab does not need to be open; BreakBuddy opens it in the background.
3. Open BreakBuddy ? set the **Custom timer to 1 minute** ? **Schedule Break**, then leave the panel open or close it.
4. Verify one Break in the chat and then click **I'm Back ? Send Back**.

The observed send icon has `data-action="messageSendConfig"`: it opens send settings and must not be clicked to submit. The built-in profile dispatches Enter to the actual editor instead. If you enabled Cliq's Send button preference, choose **Shift + Enter** in BreakBuddy Settings and save. This preference is described in [Zoho's send-button guide](https://help.zoho.com/portal/en/kb/zoho-cliq/user-guides/user-panel/profile-settings/articles/how-do-i-enable-the-send-button-in-the-text-composer-in-cliq). The extension never automatically tries both shortcuts because that could duplicate a send.

A keyboard event alone is not success. First the sender view must show a new own-message row with a persistent-shaped message ID, matching chat ID, exact text, and empty editor. The extension then opens an inactive, fresh Cliq tab and independently looks for the **same message ID and exact text**. Only that fresh-view match confirms the send. No `ack` value or generic checkmark is guessed to mean delivered. No direct/internal HTTP messaging API is called. The read-only verification tab stays open for your inspection and to avoid closing a tab you may have started using.

If the shortcut is ignored, login expires, destination identity changes, or the fresh view cannot find the message, the attempt remains failed/uncertain, never an automatic retry. A fresh UI observation is the strongest practical confirmation implemented here, not a recipient/server receipt. Real authenticated sending, background execution, and Windows lock behavior still need testing on your device.

Advanced adapter fields and read-only diagnostics remain available for DOM changes; they are not required before the first normal test. The reserved `@cliq-enter`, `@cliq-shift-enter`, and `@fresh-chat` values are adapter modes, not CSS selectors.

## Daily use

Choose a preset (5, 10, 15, 20, 25, or 30 minutes) or enter custom minutes, then **Schedule my break**. Custom timers still accept 1 minute. The countdown is display-only; Chrome alarms execute the schedule even with the panel closed. Custom schedules accept any positive whole number of minutes that fits a valid future date; there is no separate production minimum or 480-minute cap.

After the UI confirms `Break`, the badge displays **BACK** and the state becomes **On break · Back pending**. A desktop notification and a single reminder window offer **I'm Back — Send Back** and **Remind me in 5 minutes**. Dismissing a reminder never clears the pending state. Unlocking or returning to Chrome triggers reminders, never an automatic `Back` message.

The extension reuses a ready destination tab, or opens the selected chat in a separate inactive tab?even when all Cliq tabs are closed. Your signed-in session is shared within the same Chrome profile. BreakBuddy waits for the actual chat container, matching ID, title, and editor; browser load completion alone is insufficient. If an existing tab has a stale matching URL but no usable destination view, it tries one new background tab before any send is issued. It preserves other conversations and drafts. If sign-in has expired, use **Open destination in Cliq**, sign in, and retry. User-initiated Open brings that destination to the foreground.

## Failure and recovery

- **Locked but awake:** an alarm attempts DOM messaging without focusing the browser. This still needs the manual Windows test below; session state, page suspension, editor behavior, or device policy can prevent sending.
- **Sleep/hibernate:** Chrome cannot wake the device. Alarms over 60 seconds late become **Missed schedule** and require **Send Break now** or **Cancel**. Smaller delays are treated as normal scheduling jitter.
- **Chrome restart:** stored schedules are restored. Already-due schedules detected by the startup handler require confirmation, including deadlines within the ordinary grace period.
- **Logged out, destination never finishes loading, wrong chat, or existing draft:** no confirmed success is reported. Clear the cause and use **Retry**.
- **Uncertain submission:** the extension preserves the operation and pending state. It never retries it automatically. Open the destination and check the exact attempt. Choose **It was sent — confirm**, or wait at least 90 seconds from the attempt, check that it is absent, remove any leftover BreakBuddy draft, then choose **It was not sent — allow retry**. The latter enables a separate Retry action and can duplicate a message if the manual check is wrong. A late confirmed receipt takes precedence.
- **Worker interruption:** durable content-script receipts recover completed operations. An interrupted operation without proof remains uncertain instead of being replayed.

Chrome's [alarm documentation](https://developer.chrome.com/docs/extensions/reference/api/alarms) explains sleep and restart behavior. The worker restores alarms from storage instead of depending on alarm persistence. The [idle API](https://developer.chrome.com/docs/extensions/reference/api/idle) supplies return signals; these are only reminders, never proof that you returned. See the [service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) for background suspension behavior.

## Debugging

- In `chrome://extensions`, find BreakBuddy and open the **service worker** inspector. Errors are logged as `BreakBuddy:`. Keeping this inspector open changes worker lifetime; close it for restart and lock testing.
- Popup **Settings → Check saved setup** checks the destination without sending. **Inspect Cliq** returns DOM metadata without chat text.
- In the extension service-worker console, inspect local state with `await chrome.storage.local.get('state')` and alarms with `await chrome.alarms.getAll()`. Do not manually edit state during an in-flight operation.
- A changed selector, two matching editors, a different URL/title/ID, non-empty composer, or ambiguous confirmation row blocks confirmed success. The error remains visible in the panel.
- Enable Chrome desktop notifications in Windows Settings. Focus Assist/Do Not Disturb may hide notifications; the badge and extension state still persist.
- Before reinstalling or clearing extension storage, finish any pending break and verify the chat. Uninstalling or clearing storage removes its recovery records.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/TESTING.md](docs/TESTING.md) for design and verification details.


## Test without opening the destination

Reload the updated extension and refresh any open Cliq tabs once. Keep the destination set to **your chosen custom test chat**, then switch to another chat or close all Cliq tabs without signing out. Schedule a 1-minute Break from an unrelated browser tab. The extension should open your chosen test chat in an inactive tab, wait for its UI, send once, and verify the message in another fresh view. After Break confirms, close the destination tabs again and click **I'm Back** to test automatic reopening for Back as well. Your active tab must stay unchanged. This scenario has automated coverage; the authenticated background initialization still needs this live-device check.


## Version 1.2: sharing, saved destinations, and custom reports

The Home layout is compact so the Schedule my break action fits above the navigation at normal side-panel heights. Presets remain 5, 10, 15, 20, 25 and 30 minutes, with the full custom stepper retained.

Settings offers MarTech and an Add custom option. Saving custom Break/Back preferences adds the chat to a reusable destination list. Select another saved entry and confirm ENABLE CUSTOM to switch; an active break still keeps its original destination. Existing custom destinations are imported into the saved list. Removing a saved entry does not alter previously queued messages or the current Break/Back destination.

Open **Custom Message** in the bottom navigation to paste a DSR or another plain-text message. Choose a saved destination or enter a direct Cliq URL and exact chat title. Schedule after a whole-minute timer or at a device-local date and time. The draft is saved locally. Up to 20 pending messages can run alongside Break/Back; each captures its own destination and adapter settings. Custom messages never create a Back reminder and never change the Break/Back cycle. Pending messages can be cancelled; the tab shows recent delivery results.

Custom schedules use native alarms and durable send intentions. Delivery is checked in a fresh Cliq view. Failed sends offer an explicit retry; uncertain sends require checking the exact attempt in Cliq, acknowledging the check and waiting at least 90 seconds before allowing an absent-message retry. Browser shutdown/sleep can miss a deadline; overdue messages wait for Send now or Cancel. The extension does not send while the browser is fully closed.

To share, send **Cliq-BreakBuddy-extension.zip**. Each colleague extracts it into a dedicated folder, opens chrome://extensions (or brave://extensions), enables Developer mode and uses Load unpacked on the extracted folder containing manifest.json. Each user signs in to Cliq in that browser profile and configures their own destinations. Personal settings, report drafts and history live in browser storage and are not included in the ZIP. Currently supported destinations belong to company 717321507 on cliq.zoho.com.

## Version 1.2.1 recheck and message-page refresh

Navigation is now Today, Activity, Settings, Custom Message. The message page uses the same forest/cream/lime styling as Home, with a writing card, destination picker, saved-chat details, native timer/date radio choices, a larger minute stepper, delivery summary and an outbox. MarTech can be chosen directly for a custom report without changing the Break/Back destination. Message drafts, URLs, scheduled jobs and existing settings are preserved by the update.

The recheck fixed three edge cases: changing tabs during another action no longer drops message/destination reads; Cliq preflight cannot accept a date that expired while it was loading; repeated reads and draft saves no longer move an already armed due alarm forward. Editing a saved URL retains focus, and background outbox updates preserve unscheduled draft edits.

Tests cover these regressions as well as multiple reports with captured destinations/adapter settings. Isolated-browser checks cover 300–390px layouts, manual and saved destinations, date scheduling controls, saved multiline drafts and outbox review states. Live authenticated DSR delivery still needs a manual check in an authorized test chat; development did not send any actual Cliq messages.
