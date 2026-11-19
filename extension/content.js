(function() {
  "use strict";
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
  function visible(el) {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
  }
  function unique(scope, selector) {
    if (!selector.trim()) throw new Error("Selector setup is incomplete. Open Settings.");
    const all = [...scope.querySelectorAll(selector)].filter(visible);
    if (all.length !== 1) throw new Error(`Expected one visible element for ${selector}; found ${all.length}. No send attempted.`);
    return all[0];
  }
  function validate(profile, group, url = location.href, custom) {
    if (!isGroupUrl(url, group, custom)) throw new Error("Destination URL does not match the configured group.");
    const destination = destinationFor(group, custom);
    const missing = Object.entries(profile).filter(([, value]) => !value.trim()).map(([key]) => key);
    if (missing.length) throw new Error(`Setup incomplete: ${missing.join(", ")}. Click Inspect Cliq to detect available controls; download the diagnostics if fields are still missing.`);
    const root = unique(document, profile.root);
    if (root.getAttribute(profile.chatIdAttribute) !== destination.id) throw new Error("Active chat identity does not match the destination.");
    const header = unique(root, profile.header);
    if (header.textContent?.trim().replace(/^#\s*/, "") !== destination.name) throw new Error("Active chat title does not match the destination.");
    const editor = unique(root, profile.editor);
    if (!(editor.isContentEditable || editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement && editor.type === "text")) throw new Error("Configured editor is not editable.");
    if (editor.closest('[role="dialog"]')) throw new Error("A dialog editor cannot be used.");
    if (editor.getAttribute("aria-disabled") === "true" || editor.matches(":disabled")) throw new Error("The message editor is disabled.");
    root.querySelectorAll(profile.row);
    root.querySelectorAll(profile.body);
    root.querySelectorAll(profile.own);
    if (profile.acknowledged !== "@fresh-chat") root.querySelectorAll(profile.acknowledged);
    return { root, editor };
  }
  function draft(editor) {
    return editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement ? editor.value : plainText(editor);
  }
  function plainText(element) {
    const read = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (node instanceof Element && node.tagName === "BR") return "\n";
      const children = [...node.childNodes];
      if (node instanceof Element && node.matches("p,div") && children.length === 1 && children[0] instanceof Element && children[0].tagName === "BR") return "";
      return children.map((child, index) => read(child) + (child instanceof Element && child.matches("p,div") && index < children.length - 1 ? "\n" : "")).join("");
    };
    return read(element).replace(/\r\n?/g, "\n");
  }
  function hasDraft(editor) {
    return draft(editor).replace(/\u200b/g, "").trim().length > 0 || !!editor.querySelector("img,video,audio,[data-attachment]");
  }
  function messageIds(root, p) {
    return new Set([...root.querySelectorAll(p.row)].map((row) => row.getAttribute(p.rowIdAttribute)).filter(Boolean));
  }
  function confirmedRow(root, p, text, before) {
    const matches = [...root.querySelectorAll(p.row)].filter((row) => {
      const id = row.getAttribute(p.rowIdAttribute);
      const body = [...row.querySelectorAll(p.body)];
      const evidence = p.acknowledged === "@fresh-chat" ? /^\d{10,16}_\d+$/.test(row.id) && row.getAttribute("chid") === root.getAttribute(p.chatIdAttribute) && !row.matches('.dltinfomsg,.pending,.sending,.failed,.unsent,[aria-busy="true"],[data-status="pending"],[data-status="sending"],[data-status="failed"]') : row.matches(p.acknowledged) || !!row.querySelector(p.acknowledged);
      return id && !before.has(id) && row.matches(p.own) && body.length === 1 && plainText(body[0]).trim() === text && evidence;
    });
    return matches.length === 1 ? matches[0].getAttribute(p.rowIdAttribute) : null;
  }
  function waitFor(read, timeoutMs = 15e3) {
    return new Promise((resolve, reject) => {
      let observer;
      let timer;
      const cleanup = () => {
        observer?.disconnect();
        clearTimeout(timer);
      };
      const check = () => {
        try {
          const result = read();
          if (result) {
            cleanup();
            resolve(result);
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Cliq did not provide a confirmed sent message within 15 seconds."));
      }, timeoutMs);
      check();
    });
  }
  async function waitForDestination(profile, group, custom, timeoutMs = 2e4) {
    let lastError = "The selected chat has not rendered yet.";
    try {
      return await waitFor(() => {
        try {
          return validate(profile, group, location.href, custom);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          return null;
        }
      }, timeoutMs);
    } catch {
      throw new Error(`Cliq chat is not ready: ${lastError}`);
    }
  }
  function inspectCliq(group, custom) {
    const destination = destinationFor(group, custom);
    if (!isGroupUrl(location.href, group, custom)) throw new Error("Open the selected destination before inspecting it.");
    function selector(el) {
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
      const parts = [];
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
          parts.unshift(`#${CSS.escape(node.id)}`);
          break;
        }
        const siblings = node.parentElement ? [...node.parentElement.children].filter((s) => s.tagName === node.tagName) : [node];
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
      }
      return parts.length ? parts.join(" > ") : "body";
    }
    function metadata(el) {
      const controlValues = {};
      for (const name of ["data-action", "data-operation", "data-qa", "data-status", "ack", "mode", "mtype", "aria-disabled", "aria-busy", "type"]) {
        const value = el.getAttribute(name);
        if (value !== null && /^[A-Za-z0-9_.:-]{0,80}$/.test(value)) controlValues[name] = value;
      }
      return {
        tag: el.tagName,
        id: el.id,
        classes: typeof el.className === "string" ? el.className : "",
        role: el.getAttribute("role"),
        label: el.getAttribute("aria-label"),
        contenteditable: el.getAttribute("contenteditable"),
        selector: selector(el),
        attributeNames: [...el.attributes].map((a) => a.name),
        controlValues,
        chatIdentityAttributes: [...el.attributes].filter((a) => a.value === destination.id).map((a) => a.name),
        flags: {
          pending: el.matches('[aria-busy="true"],[data-status="pending"],[data-status="sending"]'),
          sent: el.matches('[data-status="sent"],[data-status="delivered"]')
        }
      };
    }
    const editors = [...document.querySelectorAll('[contenteditable="true"],textarea')].filter(visible);
    const suggestions = {};
    const ancestors = [];
    let root;
    if (editors.length === 1) {
      const editor = editors[0];
      suggestions.editor = editor.matches('.ProseMirror[contenteditable="true"]') && document.querySelectorAll('.ProseMirror[contenteditable="true"]').length === 1 ? '.ProseMirror[contenteditable="true"]' : selector(editor);
      for (let node = editor.parentElement; node && node !== document.body && ancestors.length < 12; node = node.parentElement) {
        const info = metadata(node);
        ancestors.push(info);
        if (!root && info.chatIdentityAttributes.length === 1) {
          root = node;
          suggestions.root = node.matches(".currentchat.selcht") && document.querySelectorAll(".currentchat.selcht").length === 1 ? ".currentchat.selcht" : info.selector;
          suggestions.chatIdAttribute = info.chatIdentityAttributes[0];
        }
      }
      if (root) {
        const titles = [...root.querySelectorAll("*")].filter((el) => visible(el) && el.childElementCount === 0 && el.textContent?.trim().replace(/^#\s*/, "") === destination.name);
        if (titles.length === 1) suggestions.header = titles[0].matches(".zctle[chid]") && root.querySelectorAll(".zctle[chid]").length === 1 ? ".zctle[chid]" : selector(titles[0]);
      }
    }
    const region = root ?? (editors[0]?.parentElement?.parentElement?.parentElement?.parentElement?.parentElement ?? editors[0]?.parentElement);
    const controls = region ? [...region.querySelectorAll('button,[role="button"],[onclick],[title],[aria-label],[data-action],svg,[class*="send"],[class*="Send"]')].filter(visible).slice(0, 60).map(metadata) : [];
    const outline = [];
    function walk(el, depth) {
      if (outline.length >= 180 || depth > 5 || ["SCRIPT", "STYLE", "IFRAME", "INPUT", "TEXTAREA"].includes(el.tagName)) return;
      outline.push({ depth, ...metadata(el) });
      for (const child of el.children) walk(child, depth + 1);
    }
    if (region) walk(region, 0);
    function focusedTree(base, limit, maxDepth = 16) {
      const nodes = [];
      const queue = base ? [{ node: base, depth: 0 }] : [];
      while (queue.length && nodes.length < limit) {
        const { node, depth } = queue.shift();
        const tag = node.tagName.toUpperCase();
        if (depth > maxDepth || ["SCRIPT", "STYLE", "IFRAME", "DEFS", "SYMBOL", "PATH", "CIRCLE", "G", "USE"].includes(tag)) continue;
        nodes.push({ depth, ...metadata(node) });
        if (tag !== "SVG") for (const child of node.children) queue.push({ node: child, depth: depth + 1 });
      }
      return nodes;
    }
    const rows = root ? [...root.querySelectorAll(".msgtxt[msguid][id]")] : [];
    if (rows.length) {
      suggestions.row = ".msgtxt[msguid][id]";
      suggestions.rowIdAttribute = "msguid";
      if (rows.some((row) => row.matches(".me[mymsg]"))) suggestions.own = ".msgtxt.me[mymsg]";
      if (rows.every((row) => row.querySelectorAll(":scope > pre.zcmsgcnt").length === 1)) suggestions.body = ":scope > pre.zcmsgcnt";
    }
    const composer = editors[0]?.closest("[composer-component]") ?? editors[0]?.parentElement;
    const samples = [.../* @__PURE__ */ new Set([...rows.filter((row) => !row.matches(".dltinfomsg")).slice(-3), ...rows.filter((row) => row.matches(".me[mymsg]:not(.dltinfomsg)")).slice(-2)])];
    const sendSection = composer?.querySelector(".bottommenubar-sendsection");
    const focused = {
      // Captured separately before any general traversal, including hidden children when the composer is empty.
      sendSection: focusedTree(sendSection, 80, 10),
      composer: focusedTree(composer, 220),
      messageSamples: samples.map((row) => ({ row: metadata(row), nodes: focusedTree(row, 100, 10) })),
      rowCount: rows.length
    };
    const identityNodes = [...document.querySelectorAll("[id],[data-chatid],[data-chat-id],[chatid],[chid],[data-id]")].filter((el) => [...el.attributes].some((a) => a.value === destination.id)).slice(0, 12).map(metadata);
    const missing = ["root", "chatIdAttribute", "header", "editor", "send", "row", "rowIdAttribute", "body", "own", "acknowledged"].filter((key) => !suggestions[key]);
    return {
      diagnosticsVersion: 3,
      url: location.origin + location.pathname,
      suggestions,
      missing,
      nextStep: missing.length ? "Only observed fields were detected. Share this report to finish the remaining selectors. Nothing was sent." : "Save setup and run Check saved setup.",
      editors: editors.map(metadata),
      ancestors,
      identityNodes,
      controls,
      focused,
      outline
    };
  }
  const global = globalThis;
  if (!global.__breakBuddyInstalled) {
    global.__breakBuddyInstalled = true;
    let busy = false;
    async function submit(op, profile) {
      const key = `receipt:${op.id}`;
      const previous = (await chrome.storage.local.get(key))[key];
      if (previous) return previous;
      if (busy) return { id: op.id, outcome: "failed", detail: "Another submission is still in progress.", at: Date.now() };
      busy = true;
      let touched = false;
      const persist = async (r) => {
        await chrome.storage.local.set({ [key]: r });
        return r;
      };
      try {
        if (typeof op.text !== "string" || !op.text.trim() || op.text.length > 2e4 || !["test", "production", "custom"].includes(op.group)) throw new Error("Unsupported message or group.");
        if (op.kind === "custom") {
          const { customJobs } = await chrome.storage.local.get("customJobs");
          const job = customJobs?.find((j) => j.status === "sending" && j.operation?.id === op.id);
          if (!job || JSON.stringify(job.operation) !== JSON.stringify(op) || JSON.stringify(job.profile) !== JSON.stringify(profile) || job.text !== op.text || JSON.stringify(job.destination) !== JSON.stringify(op.destination)) throw new Error("This custom message is no longer authorized.");
        } else {
          if (!["Break", "Back"].includes(op.text)) throw new Error("Unsupported break message.");
          const { state } = await chrome.storage.local.get("state");
          if (state?.operation?.id !== op.id || state.operation.text !== op.text || state.group !== op.group || op.group !== "test" && !state.productionEnabled) throw new Error("This send is no longer authorized by the extension.");
          if (op.group === "custom" && JSON.stringify(destinationFor("custom", state.customDestination)) !== JSON.stringify(destinationFor("custom", op.destination))) throw new Error("Custom destination changed since this operation was authorized.");
        }
        let view;
        await waitFor(() => {
          try {
            view = validate(profile, op.group, location.href, op.destination);
            return true;
          } catch {
            return null;
          }
        }, 1e4).catch(() => {
          validate(profile, op.group, location.href, op.destination);
        });
        view = validate(profile, op.group, location.href, op.destination);
        const { root, editor } = view;
        if (hasDraft(editor)) throw new Error("The target editor already contains a draft. It was preserved. Clear or send it yourself before retrying.");
        const before = messageIds(root, profile);
        await persist({ id: op.id, outcome: "uncertain", detail: "Submission started; confirmation has not been received.", at: Date.now() });
        const again = validate(profile, op.group, location.href, op.destination);
        if (again.root !== root || again.editor !== editor || hasDraft(editor)) throw new Error("The chat or draft changed before insertion.");
        touched = true;
        if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
          const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value").set.call(editor, op.text);
        } else {
          if (op.text.includes("\n")) {
            const paragraphs = op.text.split("\n").map((line) => {
              const p = document.createElement("p");
              p.append(line ? document.createTextNode(line) : document.createElement("br"));
              return p;
            });
            editor.replaceChildren(...paragraphs);
          } else editor.replaceChildren(document.createTextNode(op.text));
        }
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: op.text }));
        await chrome.storage.local.get(key);
        const keyboard = profile.send === "@cliq-enter" || profile.send === "@cliq-shift-enter";
        const button = keyboard ? null : await waitFor(() => {
          validate(profile, op.group, location.href, op.destination);
          try {
            const b = unique(root, profile.send);
            return b.matches(":disabled") || b.getAttribute("aria-disabled") === "true" ? null : b;
          } catch {
            return null;
          }
        }, 3e3);
        const finalView = validate(profile, op.group, location.href, op.destination);
        if (finalView.editor !== editor || finalView.root !== root || draft(editor).trim() !== op.text || button && (!button.isConnected || !root.contains(button))) throw new Error("Chat or draft changed before Send. Check Cliq.");
        if (keyboard) {
          const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, shiftKey: profile.send === "@cliq-shift-enter", bubbles: true, cancelable: true };
          editor.dispatchEvent(new KeyboardEvent("keydown", init));
          editor.dispatchEvent(new KeyboardEvent("keyup", init));
        } else button.click();
        const messageId = await waitFor(() => {
          if (!isGroupUrl(location.href, op.group, op.destination)) throw new Error("Conversation changed while confirming submission.");
          const current = validate(profile, op.group, location.href, op.destination);
          if (current.root !== root) throw new Error("Chat view changed while confirming submission.");
          if (hasDraft(editor)) return null;
          return confirmedRow(root, profile, op.text, before);
        });
        const fresh = profile.acknowledged === "@fresh-chat";
        return await persist({ id: op.id, outcome: fresh ? "uncertain" : "confirmed", detail: fresh ? "New own message observed; a fresh Cliq view must verify persistence." : "New own message with sent acknowledgement found in the target chat.", messageId, at: Date.now() });
      } catch (error) {
        return await persist({ id: op.id, outcome: touched ? "uncertain" : "failed", detail: error instanceof Error ? error.message : String(error), at: Date.now() });
      } finally {
        busy = false;
      }
    }
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (sender.id !== chrome.runtime.id) return false;
      if (msg.type === "BB_PING") {
        respond({ ok: true });
        return false;
      }
      if (msg.type === "BB_READY") {
        void waitForDestination(msg.profile, msg.group, msg.destination).then(({ editor }) => respond({ ok: true, emptyEditor: !hasDraft(editor) }), (error) => respond({ ok: false, error: error.message }));
        return true;
      }
      if (msg.type === "BB_SEND") {
        void submit(msg.operation, msg.profile).then(respond, (error) => respond({ id: msg.operation.id, outcome: "uncertain", detail: String(error), at: Date.now() }));
        return true;
      }
      if (msg.type === "BB_VERIFY") {
        void waitFor(() => {
          let view;
          try {
            view = validate(msg.profile, msg.operation.group, location.href, msg.operation.destination);
          } catch {
            return null;
          }
          const before = messageIds(view.root, msg.profile);
          before.delete(msg.messageId);
          const id = confirmedRow(view.root, msg.profile, msg.operation.text, before);
          return id === msg.messageId ? { ok: true, messageId: id, emptyEditor: !hasDraft(view.editor) } : null;
        }).then(respond, (error) => respond({ ok: false, error: error.message }));
        return true;
      }
      if (msg.type === "BB_CHECK") {
        void waitForDestination(msg.profile, msg.group, msg.destination).then(({ root, editor }) => {
          if (hasDraft(editor)) {
            respond({ ok: false, error: "The editor has an existing draft. It was preserved." });
            return;
          }
          respond({ ok: true, detail: "Destination and empty editor verified. No message was sent. The built-in profile verifies actual sends in a fresh Cliq tab.", rows: root.querySelectorAll(msg.profile.row).length });
        }, (error) => respond({ ok: false, error: error.message }));
        return true;
      }
      if (msg.type === "BB_INSPECT") {
        try {
          respond(inspectCliq(msg.group, msg.destination));
        } catch (error) {
          respond({ ok: false, error: error.message });
        }
        return false;
      }
      return false;
    });
  }
})();
//# sourceMappingURL=content.js.map
