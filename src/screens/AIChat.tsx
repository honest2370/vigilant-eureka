import { useCallback, useEffect, useRef, useState } from "react";
import { useNav } from "../lib/nav";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import {
  fetchAiConfig,
  generateReply,
  AI_SUGGESTIONS,
  type AiConfigResp,
  type AiContext,
  type AiMsg,
} from "../lib/ai";
import { fetchServices, fetchProducts } from "../lib/data";
import { IconButton, useToast, cn } from "../components/ui";
import {
  SendIcon, PlusIcon, ChevronLeftIcon, BotIcon,
  TrashIcon, MenuIcon, SparkIcon, CheckCircleIcon,
} from "../lib/icons";
import type { AiSession, AiMessage, Service, Product } from "../lib/types";

export default function AIChat() {
  const { route, go, back } = useNav();
  const { profile, refreshProfile } = useAuth();
  const toast = useToast();

  const sessionId = route.params?.session as string | undefined;
  const [sessions, setSessions] = useState<AiSession[]>([]);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<AiConfigResp | null>(null);
  const [source, setSource] = useState<"online" | "local" | null>(null);
  const [ctx, setCtx] = useState<AiContext>({ services: [], products: [] });
  const [sidebar, setSidebar] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingRef = useRef(false);

  // ——— data loaders ———
  const loadSessions = useCallback(async () => {
    if (!profile?.id) return;
    const { data } = await supabase
      .from("ai_sessions").select("*").eq("user_id", profile.id)
      .order("updated_at", { ascending: false });
    setSessions((data as AiSession[]) || []);
  }, [profile?.id]);

  const loadMessagesFromDB = useCallback(async (sid: string) => {
    const { data } = await supabase
      .from("ai_messages").select("*").eq("session_id", sid)
      .order("created_at", { ascending: true });
    setMessages((data as AiMessage[]) || []);
  }, []);

  // ——— init ———
  useEffect(() => {
    loadSessions();
    fetchAiConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
    Promise.all([fetchServices(), fetchProducts()])
      .then(([s, p]) => setCtx({ services: s as Service[], products: p as Product[] }))
      .catch(() => {});
  }, [loadSessions]);

  // ——— reload when switching sessions ———
  useEffect(() => {
    if (sessionId) { loadMessagesFromDB(sessionId); }
    else { setMessages([]); }
    setSource(null);
  }, [sessionId, loadMessagesFromDB]);

  // ——— auto-scroll ———
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // ——— start a brand-new chat ———
  const startChat = async (text: string) => {
    if (!profile || !text.trim()) return;
    setInput("");
    setBusy(true);
    // 1. create session
    const { data: s, error: sErr } = await supabase
      .from("ai_sessions")
      .insert({ user_id: profile.id, title: text.slice(0, 40) })
      .select().single();
    if (sErr || !s) {
      toast({ type: "error", msg: "Impossible de créer la conversation." });
      setBusy(false);
      return;
    }
    const sid = s.id;
    // 2. append user message locally + persist
    const userMsg: AiMessage = {
      id: crypto.randomUUID(), session_id: sid, role: "user",
      content: text, created_at: new Date().toISOString(),
    };
    setMessages([userMsg]);
    await supabase.from("ai_messages").insert({ session_id: sid, role: "user", content: text });

    // 3. generate reply
    const history: AiMsg[] = [{ role: "user", content: text }];
    const { text: reply, source: src } = await generateReply(history, config, ctx);
    setSource(src);
    const asstMsg: AiMessage = {
      id: crypto.randomUUID(), session_id: sid, role: "assistant",
      content: reply, created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, asstMsg]);
    await supabase.from("ai_messages").insert({ session_id: sid, role: "assistant", content: reply });
    setBusy(false);
    refreshProfile();
    loadSessions();
    go({ name: "ai", params: { session: sid } });
  };

  // ——— send inside an existing session ———
  const send = async () => {
    const sid = sessionId;
    if (!profile || !sid || !input.trim() || busy || pendingRef.current) return;
    const text = input.trim();
    setInput("");
    setBusy(true);
    pendingRef.current = true;

    // 1. append user message locally
    const userMsg: AiMessage = {
      id: crypto.randomUUID(), session_id: sid, role: "user",
      content: text, created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    await supabase.from("ai_messages").insert({ session_id: sid, role: "user", content: text });

    // 2. build history from current displayed messages + new user message
    const history: AiMsg[] = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: text },
    ];

    // 3. generate reply
    try {
      const { text: reply, source: src } = await generateReply(history, config, ctx);
      setSource(src);
      const asstMsg: AiMessage = {
        id: crypto.randomUUID(), session_id: sid, role: "assistant",
        content: reply, created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, asstMsg]);
      await supabase.from("ai_messages").insert({ session_id: sid, role: "assistant", content: reply });
    } catch {
      const fallback = "Désolé, une erreur est survenue. Réessayez.";
      const errMsg: AiMessage = {
        id: crypto.randomUUID(), session_id: sid, role: "assistant",
        content: fallback, created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errMsg]);
      await supabase.from("ai_messages").insert({ session_id: sid, role: "assistant", content: fallback });
    }
    setBusy(false);
    pendingRef.current = false;
    refreshProfile();
    loadSessions();
    inputRef.current?.focus();
  };

  // ——— delete session ———
  const del = async (id: string) => {
    await supabase.from("ai_messages").delete().eq("session_id", id);
    await supabase.from("ai_sessions").delete().eq("id", id);
    if (sessionId === id) go({ name: "ai" });
    loadSessions();
  };

  const limit = profile?.ai_message_limit || 50;
  const used = profile?.ai_message_count || 0;
  const isOnline = !!(config?.ai_enabled && config?.api_key);

  return (
    <div className="relative flex h-full flex-col bg-white">
      {/* ——— Sidebar ——— */}
      {sidebar && (
        <div className="absolute inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setSidebar(false)} />
          <div className="relative z-10 flex w-72 flex-col bg-white shadow-2xl border-r border-slate-100 animate-fade">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 safe-top">
              <span className="text-sm font-bold text-base">Conversations</span>
              <IconButton onClick={() => { setSidebar(false); go({ name: "ai" }); }}>
                <PlusIcon className="h-5 w-5" />
              </IconButton>
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-2">
              {sessions.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted">Aucune conversation.</p>
              ) : sessions.map((s) => (
                <div key={s.id} className={cn("group flex items-center gap-2 rounded-xl px-2.5 py-2.5 text-left transition", s.id === sessionId ? "bg-accent-50" : "hover:bg-slate-50")}>
                  <button className="min-w-0 flex-1 text-left" onClick={() => { setSidebar(false); go({ name: "ai", params: { session: s.id } }); }}>
                    <p className="truncate text-[13px] font-medium text-base-soft">{s.title}</p>
                    <p className="text-[10px] text-muted">{new Date(s.updated_at).toLocaleDateString("fr-FR")}</p>
                  </button>
                  <button onClick={() => del(s.id)} className="hidden group-hover:flex p-1.5 text-rose-400 hover:bg-rose-50 rounded-lg">
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ——— Header ——— */}
      <header className="safe-top z-30 flex items-center gap-2 border-b border-slate-100 bg-white/90 backdrop-blur px-3 py-2.5">
        <button onClick={back} className="flex h-9 w-9 items-center justify-center rounded-xl hover:bg-slate-100">
          <ChevronLeftIcon className="h-5 w-5 text-muted" />
        </button>
        <button onClick={() => setSidebar(true)} className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl gradient-brand text-white">
            <BotIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 text-left">
            <p className="truncate text-[15px] font-bold text-base">ADF IA</p>
            <p className="flex items-center gap-1 text-[10px] text-muted">
              {isOnline ? (
                <><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> En ligne — {config?.provider}</>
              ) : (
                <><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Mode local</>
              )}
            </p>
          </div>
        </button>
        <button onClick={() => go({ name: "ai" })} className="flex h-9 w-9 items-center justify-center rounded-xl hover:bg-slate-100">
          <PlusIcon className="h-5 w-5 text-muted" />
        </button>
        <button onClick={() => setSidebar(true)} className="flex h-9 w-9 items-center justify-center rounded-xl hover:bg-slate-100">
          <MenuIcon className="h-5 w-5 text-muted" />
        </button>
      </header>

      {/* ——— Chat area ——— */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar">
        {!sessionId ? (
          <div className="flex h-full flex-col items-center justify-center px-6 animate-fade">
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl gradient-brand shadow-xl shadow-accent-500/20">
              <BotIcon className="h-10 w-10 text-white" />
            </div>
            <h2 className="text-xl font-bold text-base">Bonjour, je suis ADF IA</h2>
            <p className="mt-1.5 max-w-xs text-center text-sm text-muted">
              Votre assistant pour découvrir nos services, commander et explorer la boutique.
            </p>
            <div className="mt-8 grid w-full max-w-sm gap-2">
              {AI_SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => startChat(s)}
                  className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-accent-200 hover:bg-accent-50/50">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent-50 text-accent-500"><SparkIcon className="h-4 w-4" /></span>
                  <span className="flex-1 text-[13px] text-base-soft">{s}</span>
                </button>
              ))}
            </div>
            {sessions.length > 0 && (
              <div className="mt-8 w-full max-w-sm">
                <p className="mb-2 text-xs font-semibold text-muted">Conversations récentes</p>
                {sessions.slice(0, 4).map((s) => (
                  <button key={s.id} onClick={() => go({ name: "ai", params: { session: s.id } })}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left hover:bg-slate-50">
                    <BotIcon className="h-4 w-4 shrink-0 text-accent-400" />
                    <span className="truncate text-[13px] text-base-soft">{s.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : messages.length === 0 && !busy ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted">Écrivez ci-dessous pour démarrer.</p>
          </div>
        ) : (
          <div className="space-y-6 px-4 py-6">
            {messages.map((m) => (
              <MsgBubble key={m.id} role={m.role} content={m.content} />
            ))}
            {busy && <Typing />}
          </div>
        )}
      </div>

      {/* ——— Limit bar ——— */}
      <div className="px-4 pb-1">
        <div className="flex items-center justify-between text-[10px] text-muted/60">
          <span>{used}/{limit} messages</span>
          {source && <span className="flex items-center gap-1"><CheckCircleIcon className="h-3 w-3" />{source === "online" ? "En ligne" : "Hors-ligne"}</span>}
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full gradient-brand transition-all" style={{ width: `${limit ? Math.min(100, (used / limit) * 100) : 0}%` }} />
        </div>
      </div>

      {/* ——— Composer ——— */}
      <div className="safe-bottom border-t border-slate-100 bg-white px-3 pb-2.5 pt-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!input.trim() || busy) return;
                if (sessionId) send();
                else startChat(input);
              }
            }}
            placeholder="Message ADF IA..."
            className="max-h-28 min-h-[44px] flex-1 resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-[15px] text-base placeholder:text-muted/50 outline-none transition focus:border-accent-300 focus:ring-2 focus:ring-accent-100 focus:bg-white"
          />
          <button
            onClick={() => {
              if (!input.trim() || busy) return;
              if (sessionId) send();
              else startChat(input);
            }}
            disabled={busy || !input.trim()}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl gradient-brand text-white active:scale-90 disabled:opacity-40 transition"
          >
            <SendIcon className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ——— Message bubble ——— */
function MsgBubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const mine = role === "user";
  return (
    <div className={cn("flex gap-3", mine ? "flex-row-reverse" : "flex-row")}>
      {!mine && (
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl gradient-brand text-white">
          <BotIcon className="h-4 w-4" />
        </span>
      )}
      <div className={cn("max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed",
        mine ? "gradient-brand text-white rounded-br-md" : "bg-slate-100 text-base-soft rounded-bl-md"
      )}>
        {content}
      </div>
    </div>
  );
}

/* ——— Typing indicator ——— */
function Typing() {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl gradient-brand text-white">
        <BotIcon className="h-4 w-4" />
      </span>
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3">
        <span className="dot h-1.5 w-1.5 rounded-full bg-muted" />
        <span className="dot mx-1 h-1.5 w-1.5 rounded-full bg-muted" />
        <span className="dot h-1.5 w-1.5 rounded-full bg-muted" />
      </div>
    </div>
  );
}
