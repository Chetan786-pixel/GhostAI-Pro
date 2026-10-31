 "use client";

import { ChangeEvent, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowDown, ArrowUp, Check, ChevronDown, CircleHelp, Command, Copy,
  Github, Ghost, Menu, MessageSquarePlus, Moon, MoreHorizontal, PanelLeftClose,
  Plus, Search, Settings2, ShieldCheck, Sparkles, Square, Terminal, Trash2,
  WandSparkles, X, Zap,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
type Message = { id: string; role: "user" | "assistant"; content: string; createdAt: number };
type Conversation = { id: string; title: string; updatedAt: number; messages: Message[] };

const starters = [
  { icon: "✦", title: "Explain something", text: "Explain how large language models work in simple terms, with an example.", tone: "violet" },
  { icon: "⌘", title: "Debug my code", text: "Act as a careful debugging assistant. Inspect the exact code I provide, identify the specific error and its cause, then show the smallest correct fix. Do not invent errors or change unrelated code.", tone: "blue" },
  { icon: "◈", title: "Make something", text: "Give me three creative project ideas I can build with Python and open-source AI.", tone: "pink" },
  { icon: "☾", title: "Enter the unknown", text: "Write a short, atmospheric spooky story about a computer that starts answering questions nobody asked.", tone: "amber" },
];

function makeId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
function makeConversation(): Conversation { return { id: makeId(), title: "New conversation", updatedAt: Date.now(), messages: [] }; }

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [model, setModel] = useState("gemma3:1b");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [backendStatus, setBackendStatus] = useState<"checking" | "online" | "offline">("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("ghostai-conversations-v1");
      if (saved) {
        const parsed = JSON.parse(saved) as Conversation[];
        if (Array.isArray(parsed) && parsed.length) {
          setConversations(parsed);
          setActiveId(parsed[0].id);
          return;
        }
      }
    } catch { /* Ignore invalid local cache and start fresh. */ }
    const first = makeConversation();
    setConversations([first]);
    setActiveId(first.id);
  }, []);

  useEffect(() => {
    if (conversations.length) localStorage.setItem("ghostai-conversations-v1", JSON.stringify(conversations));
  }, [conversations]);

  const active = conversations.find((c) => c.id === activeId) || conversations[0];
  const messages = active?.messages || [];
  const filteredConversations = useMemo(() => conversations
    .filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt), [conversations, search]);

  const checkHealth = useCallback(async () => {
    setBackendStatus("checking");
    try {
      const res = await fetch(`${API_URL}/health`, { cache: "no-store" });
      const data = await res.json();
      setBackendStatus(data.status === "ok" && data.ollama === "connected" ? "online" : "offline");
      if (data.model) setModel(data.model);
    } catch { setBackendStatus("offline"); }
  }, []);

  useEffect(() => { void checkHealth(); const timer = window.setInterval(checkHealth, 30000); return () => window.clearInterval(timer); }, [checkHealth]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, busy]);
  useEffect(() => { if (!busy) textareaRef.current?.focus({ preventScroll: true }); }, [busy, activeId]);

  function updateActive(updater: (conversation: Conversation) => Conversation) {
    setConversations((old) => old.map((c) => c.id === activeId ? updater(c) : c));
  }

  function newChat() {
    const c = makeConversation();
    setConversations((old) => [c, ...old]);
    setActiveId(c.id);
    setInput("");
    setError("");
    setSidebarOpen(true);
  }

  function deleteConversation(id: string) {
    const remaining = conversations.filter((c) => c.id !== id);
    if (!remaining.length) {
      const fresh = makeConversation();
      setConversations([fresh]);
      setActiveId(fresh.id);
    } else {
      setConversations(remaining);
      if (activeId === id) setActiveId(remaining[0].id);
    }
  }

  async function sendMessage(value?: string) {
    const content = (value ?? input).trim();
    if (!content || busy || !active) return;
    if (backendStatus !== "online") {
      setError("GhostAI can't reach the local AI engine. Start Ollama and the FastAPI backend, then retry.");
      return;
    }
    setError("");
    setInput("");
    const userMessage: Message = { id: makeId(), role: "user", content, createdAt: Date.now() };
    const updatedMessages = [...active.messages, userMessage];
    updateActive((c) => ({ ...c, title: c.messages.length === 0 ? content.slice(0, 36) + (content.length > 36 ? "…" : "") : c.title, messages: updatedMessages, updatedAt: Date.now() }));
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`${API_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updatedMessages.map(({ role, content: text }) => ({ role, content: text })), model }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
      const assistantMessage: Message = { id: makeId(), role: "assistant", content: data.message || "The terminal returned an empty response.", createdAt: Date.now() };
      setConversations((old) => old.map((c) => c.id === activeId ? { ...c, messages: [...c.messages, assistantMessage], updatedAt: Date.now() } : c));
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setError("Generation stopped.");
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong. Please retry.");
      }
      // Keep the user's message so they can retry or copy it.
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function onInputChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const element = event.currentTarget;
    setInput(element.value);
    // Grow with pasted or typed text, then scroll internally after the cap.
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [input]);

  function onSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void sendMessage(); }
  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
  }
  function stopGeneration() { abortRef.current?.abort(); }

  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId(""), 1400);
    } catch { setError("Clipboard access is unavailable in this browser."); }
  }

  return (
    <main className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      {sidebarOpen && <aside className="sidebar">
        <div className="sidebar-top">
          <a className="brand" href="#" onClick={(e) => { e.preventDefault(); newChat(); }}>
            <span className="brand-mark"><Ghost size={22} strokeWidth={1.8} /></span>
            <span className="brand-copy"><strong>ghost<span>ai</span></strong><small>THE HAUNTED TERMINAL</small></span>
          </a>
          <button className="icon-button sidebar-collapse" aria-label="Collapse sidebar" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={17} /></button>
        </div>

        <button className="new-chat-button" onClick={newChat}><Plus size={17} /><span>New conversation</span><kbd>⌘ K</kbd></button>
        <button className={`side-action ${searchOpen ? "selected" : ""}`} onClick={() => { setSearchOpen(!searchOpen); setSearch(""); }}><Search size={16} /> Search chats</button>
        {searchOpen && <input className="search-input" placeholder="Find a conversation…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />}

        <div className="side-section-label"><span>RECENT</span><MoreHorizontal size={15} /></div>
        <div className="conversation-list">
          {filteredConversations.map((c) => (
            <div className={`conversation-row ${c.id === activeId ? "active" : ""}`} key={c.id}>
              <button className="conversation-select" onClick={() => { setActiveId(c.id); setError(""); }}>
                <MessageSquarePlus size={15} /><span>{c.title}</span>
              </button>
              <button className="conversation-delete" title="Delete conversation" aria-label={`Delete ${c.title}`} onClick={() => deleteConversation(c.id)}><Trash2 size={13} /></button>
            </div>
          ))}
          {!filteredConversations.length && <p className="empty-search">No matching chats</p>}
        </div>

        <div className="sidebar-bottom">
          <div className="engine-card">
            <div className="engine-card-head"><span className={`status-dot ${backendStatus}`} /><span>{backendStatus === "online" ? "Engine connected" : backendStatus === "checking" ? "Checking engine…" : "Engine offline"}</span><button aria-label="Refresh connection" className="refresh-status" onClick={checkHealth}><Activity size={14} /></button></div>
            <div className="engine-model"><span className="model-orb"><Sparkles size={14} /></span><span><b>{model}</b><small>Local inference · Ollama</small></span><button className="model-chevron" onClick={() => setModelMenuOpen(!modelMenuOpen)} aria-label="Choose model"><ChevronDown size={15} /></button></div>
            {modelMenuOpen && <div className="model-popover"><p>Current model</p><button onClick={() => { setModel("gemma3:1b"); setModelMenuOpen(false); }}>Gemma 3 · 1B <Check size={14} /></button><small>To use another model, update OLLAMA_MODEL in backend/.env.</small></div>}
          </div>
          <button className="side-action" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /> Settings</button>
          <button className="side-action" onClick={() => setAboutOpen(true)}><CircleHelp size={16} /> About GhostAI</button>
          <div className="privacy-note"><ShieldCheck size={14} /><span>Your chats stay in this browser. AI runs on your machine.</span></div>
        </div>
      </aside>}

      <section className="main-panel">
        <header className="topbar">
          <div className="topbar-left">
            {!sidebarOpen && <button className="icon-button" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}><Menu size={18} /></button>}
            <span className="breadcrumb">Workspace <span>/</span> <b>{messages.length ? "Conversation" : "New chat"}</b></span>
          </div>
          <div className="topbar-right">
            <span className="local-badge"><span className={`status-dot ${backendStatus}`} />{backendStatus === "online" ? "LOCAL MODEL ACTIVE" : backendStatus === "checking" ? "CONNECTING" : "ENGINE OFFLINE"}</span>
            <button className="icon-button topbar-help" aria-label="About GhostAI" onClick={() => setAboutOpen(true)}><CircleHelp size={17} /></button>
          </div>
        </header>

        <div className={`content ${messages.length ? "content-chat" : "content-home"}`}>
          {messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-orb"><span className="spectral-particle particle-one" /><span className="spectral-particle particle-two" /><span className="spectral-particle particle-three" /><div className="orb-ring ring-one" /><div className="orb-ring ring-two" /><div className="orb-core"><Ghost size={39} strokeWidth={1.35} /></div><span className="orb-spark spark-one">✦</span><span className="orb-spark spark-two">·</span></div>
              <div className="eyebrow"><span className="eyebrow-line" /> A DIFFERENT KIND OF INTELLIGENCE <span className="eyebrow-line" /></div>
              <h1>Intelligence beyond<br /><span>the ordinary.</span></h1>
              <p className="welcome-description">Something stirs inside your machine. Bring a question, a stubborn bug, or a strange idea. GhostAI is listening — locally, in the dark.</p>
              <div className="capability-row"><span><ShieldCheck size={14} /> Private by design</span><i /><span><Zap size={14} /> Runs locally</span><i /><span><Sparkles size={14} /> Open model</span></div>
              <div className="prompt-heading"><span>NOT SURE WHERE TO START?</span><span className="prompt-heading-right">PICK A PROMPT <ArrowDown size={12} /></span></div>
              <div className="prompt-grid">
                {starters.map((s) => <button className={`prompt-card ${s.tone}`} key={s.title} onClick={() => void sendMessage(s.text)}>
                  <span className="prompt-icon">{s.icon}</span><span className="prompt-card-title">{s.title}</span><span className="prompt-card-text">{s.text}</span><span className="prompt-arrow"><ArrowUp size={15} /></span>
                </button>)}
              </div>
              {backendStatus === "offline" && <div className="connection-callout"><span className="callout-icon"><Terminal size={17} /></span><span><b>Your local engine is not connected yet.</b><small>Start Ollama and the FastAPI backend, then click the refresh icon in the sidebar.</small></span><button onClick={checkHealth}>Retry</button></div>}
            </div>
          ) : (
            <div className="chat-thread">
              <div className="thread-heading"><div><div className="thread-eyebrow">GHOSTAI SESSION</div><h2>{active?.title || "Conversation"}</h2></div><span className="message-count">{messages.length} {messages.length === 1 ? "message" : "messages"}</span></div>
              {messages.map((m) => <article className={`message ${m.role}`} key={m.id}>
                <div className={`message-avatar ${m.role}`}>{m.role === "assistant" ? <Ghost size={17} /> : <span>Y</span>}</div>
                <div className="message-body"><div className="message-meta"><b>{m.role === "assistant" ? "GhostAI" : "You"}</b><span>{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
                  <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
                  {m.role === "assistant" && <div className="message-tools"><button onClick={() => void copyMessage(m)}>{copiedId === m.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === m.id ? "Copied" : "Copy"}</button></div>}
                </div>
              </article>)}
              {busy && <article className="message assistant"><div className="message-avatar assistant"><Ghost size={17} /></div><div className="message-body"><div className="message-meta"><b>GhostAI</b><span>THINKING</span></div><div className="thinking"><span /><span /><span /><small>Connecting the dots in the dark…</small></div></div></article>}
              <div ref={bottomRef} />
              {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button></div>}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {messages.length > 0 && <div className="composer-context"><span><span className={`status-dot ${backendStatus}`} /> {backendStatus === "online" ? "Gemma is ready" : "Local engine unavailable"}</span><span>Enter to send · Shift + Enter for new line</span></div>}
          {error && messages.length === 0 && <div className="error-banner composer-error"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button></div>}
          <form className="composer" onSubmit={onSubmit}>
            <textarea ref={textareaRef} value={input} onChange={onInputChange} onKeyDown={onTextareaKeyDown} placeholder="Ask GhostAI anything…" rows={1} aria-label="Message GhostAI" disabled={busy} />
            <div className="composer-bottom"><div className="composer-hints"><span className="hint-chip"><Command size={12} /> Local AI</span><span className="hint-separator">·</span><span>Be curious.</span></div>
              {busy ? <button type="button" className="send-button stop-button" onClick={stopGeneration} aria-label="Stop generation"><Square size={15} fill="currentColor" /></button> : <button type="submit" className="send-button" disabled={!input.trim()} aria-label="Send message"><ArrowUp size={18} /></button>}
            </div>
          </form>
          <div className="disclaimer">GhostAI can make mistakes. Check important information. <span>·</span> Powered by Ollama + {model}</div>
        </div>
      </section>

      {(settingsOpen || aboutOpen) && <div className="modal-backdrop" onClick={() => { setSettingsOpen(false); setAboutOpen(false); }}>
        <section className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <button className="modal-close icon-button" onClick={() => { setSettingsOpen(false); setAboutOpen(false); }} aria-label="Close dialog"><X size={17} /></button>
          <div className="modal-mark">{settingsOpen ? <Settings2 size={22} /> : <Ghost size={24} />}</div>
          <div className="modal-eyebrow">{settingsOpen ? "PREFERENCES" : "THE PROJECT"}</div>
          <h3>{settingsOpen ? "Settings" : "Meet GhostAI"}</h3>
          {settingsOpen ? <><p>GhostAI uses a local Ollama model. Change the selected model in <code>backend/.env</code>, then restart the backend.</p><div className="settings-line"><span>Active model</span><b>{model}</b></div><div className="settings-line"><span>Backend URL</span><b>{API_URL}</b></div><button className="modal-primary" onClick={checkHealth}>Check connection</button></> : <><p>GhostAI is a local-first AI assistant experiment built with Next.js, FastAPI, and Ollama. Conversations are saved in this browser only; inference is handled by your local model.</p><div className="about-stack"><span>Next.js</span><span>TypeScript</span><span>FastAPI</span><span>Ollama</span></div><div className="about-foot"><ShieldCheck size={15} /> Open models. Local control.</div></>}
        </section>
      </div>}
    </main>
  );
}
