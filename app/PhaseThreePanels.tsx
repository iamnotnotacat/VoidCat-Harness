"use client";

import { useState } from "react";

export type Profile = { id: string; name: string; systemPrompt: string; temperature: number; maxTokens: number; updatedAt: string };
export type ConversationSummary = { id: string; title: string; profileId: string; modelKey?: string; webMode?: "off" | "ask" | "auto"; messageCount: number; preview: string; updatedAt: string };
export type MemoryRecord = { id: string; content: string; category: string; importance: number; enabled: boolean; updatedAt: string };

export function ArchivePanel({ conversations, onOpen, onDelete, onNew }: {
  conversations: ConversationSummary[]; onOpen: (id: string) => void; onDelete: (id: string) => void; onNew: () => void;
}) {
  return <section className="phase-panel">
    <div className="phase-heading"><div><p className="kicker">PERSISTENT RECORD {"//"} LOCAL SQLITE</p><h2>ARCHIVE</h2></div><button className="primary-action" onClick={onNew}>NEW TRANSMISSION</button></div>
    <div className="archive-grid">
      {conversations.map((conversation, index) => <article className="archive-card" key={conversation.id} style={{ "--row-index": index } as React.CSSProperties}>
        <button className="archive-open" onClick={() => onOpen(conversation.id)}>
          <span className="archive-index">LOG {String(index + 1).padStart(3, "0")}</span>
          <strong>{conversation.title}</strong>
          <p>{conversation.preview || "Empty transmission"}</p>
          <small>{conversation.messageCount} MESSAGES {"//"} {new Date(conversation.updatedAt).toLocaleString()}</small>
        </button>
        <button className="delete-control" aria-label={`Delete ${conversation.title}`} onClick={() => onDelete(conversation.id)}>×</button>
      </article>)}
      {conversations.length === 0 && <div className="panel-empty"><span>NO RECORDS FOUND</span><strong>THE ARCHIVE IS EMPTY</strong><p>Begin a new transmission to create the first persistent conversation.</p></div>}
    </div>
  </section>;
}

export function MemoryPanel({ memories, suggestionsEnabled, onSave, onDelete, onSuggestionsChange }: {
  memories: MemoryRecord[]; suggestionsEnabled: boolean; onSave: (memory: Partial<MemoryRecord> & { content: string }) => Promise<void>; onDelete: (id: string) => void; onSuggestionsChange: (enabled: boolean) => Promise<void>;
}) {
  const [editing, setEditing] = useState<MemoryRecord | null>(null);
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("general");
  const [importance, setImportance] = useState(3);
  function editMemory(memory: MemoryRecord) { setEditing(memory); setContent(memory.content); setCategory(memory.category); setImportance(memory.importance); }
  async function submit() {
    if (!content.trim()) return;
    await onSave({ id: editing?.id, content, category, importance, enabled: editing?.enabled ?? true });
    setEditing(null); setContent(""); setCategory("general"); setImportance(3);
  }
  return <section className="phase-panel">
    <div className="phase-heading"><div><p className="kicker">LONG-TERM CONTEXT {"//"} OPERATOR CONTROLLED</p><h2>MEMORY CORE</h2></div><span className="phase-counter">{memories.filter((memory) => memory.enabled).length} ACTIVE</span></div>
    <div className="memory-layout">
      <div className="memory-form"><span>{editing ? "EDIT MEMORY" : "NEW MEMORY"}</span><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="A preference, fact, project detail, or standing instruction..." /><div><label>CATEGORY<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="general">GENERAL</option><option value="preference">PREFERENCE</option><option value="project">PROJECT</option><option value="person">PERSON</option><option value="instruction">INSTRUCTION</option></select></label><label>PRIORITY<select value={importance} onChange={(event) => setImportance(Number(event.target.value))}>{[1,2,3,4,5].map((value) => <option value={value} key={value}>{value}</option>)}</select></label></div><button className="primary-action" onClick={() => void submit()} disabled={!content.trim()}>{editing ? "UPDATE MEMORY" : "COMMIT MEMORY"}</button>{editing && <button className="cancel-action" onClick={() => setEditing(null)}>CANCEL EDIT</button>}<div className="memory-suggestion-control"><div><strong>AUTO SUGGESTIONS</strong><small>Never saved without approval</small></div><button className={suggestionsEnabled ? "enabled" : ""} onClick={() => void onSuggestionsChange(!suggestionsEnabled)}>{suggestionsEnabled ? "ENABLED" : "DISABLED"}</button></div><p className="memory-command-help">CHAT COMMANDS<br /><b>remember this: ...</b><br /><b>forget this: ...</b></p></div>
      <div className="memory-list">{memories.map((memory, index) => <article className={`memory-card ${memory.enabled ? "" : "disabled"}`} key={memory.id} style={{ "--row-index": index } as React.CSSProperties}><header><span>{memory.category.toUpperCase()} {"//"} PRIORITY {memory.importance}</span><button onClick={() => void onSave({ ...memory, content: memory.content, enabled: !memory.enabled })}>{memory.enabled ? "ACTIVE" : "MUTED"}</button></header><p>{memory.content}</p><footer><button onClick={() => editMemory(memory)}>EDIT</button><button className="danger-text" onClick={() => onDelete(memory.id)}>DELETE</button></footer></article>)}{memories.length === 0 && <div className="panel-empty"><span>MEMORY CORE CLEAR</span><strong>NO STORED CONTEXT</strong><p>Memories are always visible, editable, and optional.</p></div>}</div>
    </div>
  </section>;
}

export function ProfilesPanel({ profiles, onSave, onDelete }: {
  profiles: Profile[]; onSave: (profile: Partial<Profile>) => Promise<void>; onDelete: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string>(profiles[0]?.id ?? "default");
  const current = profiles.find((profile) => profile.id === editingId);
  const [name, setName] = useState(profiles[0]?.name ?? ""); const [systemPrompt, setSystemPrompt] = useState(profiles[0]?.systemPrompt ?? "");
  const [temperature, setTemperature] = useState(profiles[0]?.temperature ?? 0.7); const [maxTokens, setMaxTokens] = useState(profiles[0]?.maxTokens ?? 2048);
  function editProfile(profile: Profile) { setEditingId(profile.id); setName(profile.name); setSystemPrompt(profile.systemPrompt); setTemperature(profile.temperature); setMaxTokens(profile.maxTokens); }
  return <section className="phase-panel">
    <div className="phase-heading"><div><p className="kicker">BEHAVIOR MATRIX {"//"} ASSISTANT CONFIGURATION</p><h2>PROFILES</h2></div><button className="primary-action" onClick={() => { setEditingId("new"); setName("New Assistant"); setSystemPrompt("You are a helpful local AI assistant."); setTemperature(0.7); setMaxTokens(2048); }}>NEW PROFILE</button></div>
    <div className="profiles-layout"><nav>{profiles.map((profile, index) => <button key={profile.id} className={editingId === profile.id ? "active" : ""} onClick={() => editProfile(profile)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{profile.name}</strong><small>{profile.id === "default" ? "PRIMARY" : "CUSTOM"}</small></button>)}</nav><div className="profile-editor"><label>PROFILE DESIGNATION<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>SYSTEM DIRECTIVE<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} /></label><div className="profile-settings"><label>TEMPERATURE<input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} /></label><label>MAX RESPONSE TOKENS<input type="number" min="128" max="16384" step="128" value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} /></label></div><div className="profile-actions"><button className="primary-action" onClick={() => void onSave({ id: editingId === "new" ? undefined : editingId, name, systemPrompt, temperature, maxTokens })}>SAVE PROFILE</button>{current && current.id !== "default" && <button className="danger-action" onClick={() => onDelete(current.id)}>DELETE PROFILE</button>}</div></div></div>
  </section>;
}
