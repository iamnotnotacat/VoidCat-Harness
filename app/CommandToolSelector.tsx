/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
"use client";

import { useMemo, useState } from "react";
import { COMMAND_TOOLS, type CommandToolDefinition } from "./command-tool-definitions";

export { COMMAND_TOOLS } from "./command-tool-definitions";

export function CommandToolSelector({ enabledNames, disabled, onChange }: {
  enabledNames: string[];
  disabled: boolean;
  onChange: (enabledNames: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const enabled = useMemo(() => new Set(enabledNames), [enabledNames]);
  const groups = ["HUNTER-SEEKER", "OSINT INVESTIGATION", "VOIDCAT KNOWLEDGE"] as const;
  const externalCount = COMMAND_TOOLS.filter((tool) => enabled.has(tool.name) && tool.access === "EXTERNAL").length;
  function toggle(name: string) {
    const next = new Set(enabled);
    if (next.has(name)) next.delete(name); else next.add(name);
    onChange(COMMAND_TOOLS.filter((tool) => next.has(tool.name)).map((tool) => tool.name));
  }
  function toggleGroup(group: CommandToolDefinition["group"]) {
    const names = COMMAND_TOOLS.filter((tool) => tool.group === group).map((tool) => tool.name);
    const allEnabled = names.every((name) => enabled.has(name));
    const next = new Set(enabled);
    names.forEach((name) => allEnabled ? next.delete(name) : next.add(name));
    onChange(COMMAND_TOOLS.filter((tool) => next.has(tool.name)).map((tool) => tool.name));
  }
  return <div className="command-tool-selector">
    <button type="button" className={enabled.size ? "command-tool-trigger armed" : "command-tool-trigger"} disabled={disabled} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      FEATURES <b>{enabled.size}</b>{externalCount > 0 && <i>EXT {externalCount}</i>}
    </button>
    {open && <section className="command-tool-popover" aria-label="UNIT feature permissions">
      <header><div><span>UNIT CAPABILITY MATRIX</span><strong>PER-MESSAGE ENFORCED</strong></div><button type="button" onClick={() => setOpen(false)}>×</button></header>
      <p>The UNIT can only call enabled functions. External capabilities may contact configured providers; local capabilities only read data already held by VoidCat.</p>
      {groups.map((group) => {
        const tools = COMMAND_TOOLS.filter((tool) => tool.group === group);
        const groupEnabled = tools.filter((tool) => enabled.has(tool.name)).length;
        return <div className="command-tool-group" key={group}>
          <div><strong>{group}</strong><button type="button" onClick={() => toggleGroup(group)}>{groupEnabled === tools.length ? "DISABLE ALL" : "ENABLE ALL"}</button></div>
          {tools.map((tool) => <label key={tool.name} className={enabled.has(tool.name) ? "enabled" : ""}>
            <input type="checkbox" checked={enabled.has(tool.name)} onChange={() => toggle(tool.name)} />
            <span><b>{tool.label}</b><small>{tool.description}</small></span><em className={tool.access.toLowerCase()}>{tool.access}</em>
          </label>)}
        </div>;
      })}
      <footer><button type="button" onClick={() => onChange([])}>DISABLE EVERYTHING</button><span>{enabled.size} / {COMMAND_TOOLS.length} CAPABILITIES ARMED</span></footer>
    </section>}
  </div>;
}
