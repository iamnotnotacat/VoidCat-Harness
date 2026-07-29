"use client";

import { useEffect, useState } from "react";
import { useNotifications } from "./NotificationCenter";

export type ProjectRecord = {
  id: string; name: string; slug: string; status: string;
  chatMemoryLimitBytes: number; osintMemoryLimitBytes: number;
  createdAt: string; updatedAt: string;
  usage: { chatBytes: number; memoryBytes: number; chatMemoryBytes: number };
};

const mib = (bytes: number) => Math.round(bytes / 1024 ** 2);
const percent = (used: number, limit: number) => Math.min(100, Math.round(used / Math.max(1, limit) * 100));

export function ProjectsPanel({ projects, activeProject, onRefresh, onSelect }: {
  projects: ProjectRecord[]; activeProject: ProjectRecord;
  onRefresh: () => Promise<void>; onSelect: (id: string) => Promise<void>;
}) {
  const { notify } = useNotifications();
  const [name, setName] = useState(""); const [chatMiB, setChatMiB] = useState(512); const [osintMiB, setOsintMiB] = useState(1024); const [busy, setBusy] = useState(false);
  const [osintUsage, setOsintUsage] = useState<{ bytes: number; investigations: number; unitMemories: number } | null>(null);
  useEffect(() => { void fetch("/api/osint/project-usage").then((response) => response.json()).then(setOsintUsage); }, [activeProject.id]);
  async function create() {
    if (!name.trim() || busy) return; setBusy(true);
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, chatMemoryLimitBytes: chatMiB * 1024 ** 2, osintMemoryLimitBytes: osintMiB * 1024 ** 2 }) });
      const data = await response.json() as { id?: string; error?: string }; if (!response.ok || !data.id) throw new Error(data.error ?? "Project could not be created.");
      setName(""); await onRefresh(); await onSelect(data.id); notify({ tone: "success", title: "Project created", message: "Its chats, approved memories, and OSINT allotment now persist independently." });
    } catch (error) { notify({ tone: "error", title: "Project creation failed", message: error instanceof Error ? error.message : "Project could not be created." }); }
    finally { setBusy(false); }
  }
  async function saveBudget(project: ProjectRecord, kind: "chat" | "osint", valueMiB: number) {
    const response = await fetch(`/api/projects/${project.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(kind === "chat" ? { chatMemoryLimitBytes: valueMiB * 1024 ** 2 } : { osintMemoryLimitBytes: valueMiB * 1024 ** 2 }) });
    const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error ?? "Allotment could not be changed."); await onRefresh();
  }
  return <section className="phase-panel projects-panel">
    <div className="phase-heading"><div><p className="kicker">PERSISTENT WORKSPACES {"//"} LOCAL ONLY</p><h2>PROJECTS</h2></div><span className="phase-counter">{projects.length} ACTIVE</span></div>
    <div className="project-layout">
      <div className="project-create"><span>NEW PROJECT</span><label>PROJECT NAME<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Investigation designation" /></label><div><label>CHAT + MEMORY<input type="number" min={16} max={102400} value={chatMiB} onChange={(event) => setChatMiB(Number(event.target.value))} /><small>MiB</small></label><label>OSINT MEMORY<input type="number" min={16} max={102400} value={osintMiB} onChange={(event) => setOsintMiB(Number(event.target.value))} /><small>MiB</small></label></div><button className="primary-action" disabled={!name.trim() || busy} onClick={() => void create()}>{busy ? "CREATING..." : "CREATE + OPEN PROJECT"}</button><p>Project folders are retained under <b>.voidcat/projects</b>. Switching projects never clears another project’s records.</p></div>
      <div className="project-list">{projects.map((project) => {
        const active = project.id === activeProject.id; const chatPct = percent(project.usage.chatMemoryBytes, project.chatMemoryLimitBytes);
        return <article key={project.id} className={active ? "active" : ""}><header><div><span>{active ? "ACTIVE PROJECT" : "PERSISTENT PROJECT"}</span><strong>{project.name}</strong><small>{project.slug}</small></div>{!active && <button onClick={() => void onSelect(project.id)}>OPEN</button>}</header><div className="project-meter"><div><span>CHAT + APPROVED MEMORY</span><b>{mib(project.usage.chatMemoryBytes)} / {mib(project.chatMemoryLimitBytes)} MiB</b></div><i><b style={{ width: `${chatPct}%` }} /></i></div>{active && osintUsage && <div className="project-meter"><div><span>PERSISTENT OSINT MEMORY</span><b>{mib(osintUsage.bytes)} / {mib(project.osintMemoryLimitBytes)} MiB</b></div><i><b style={{ width: `${percent(osintUsage.bytes, project.osintMemoryLimitBytes)}%` }} /></i></div>}<div className="project-budget-edit"><label>CHAT ALLOTMENT <input type="number" min={Math.max(16, Math.ceil(project.usage.chatMemoryBytes / 1024 ** 2))} defaultValue={mib(project.chatMemoryLimitBytes)} onBlur={(event) => void saveBudget(project, "chat", Number(event.target.value))} /> MiB</label><label>OSINT ALLOTMENT <input type="number" min={16} defaultValue={mib(project.osintMemoryLimitBytes)} onBlur={(event) => void saveBudget(project, "osint", Number(event.target.value))} /> MiB</label></div><footer><span>CHATS {mib(project.usage.chatBytes)} MiB</span><span>MEMORIES {mib(project.usage.memoryBytes)} MiB</span>{active && osintUsage && <span>OSINT {osintUsage.investigations} INVESTIGATIONS // {osintUsage.unitMemories} UNIT MEMORIES</span>}<span>UPDATED {new Date(project.updatedAt).toLocaleString()}</span></footer></article>;
      })}</div>
    </div>
  </section>;
}
