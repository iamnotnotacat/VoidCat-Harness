/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { requestVoidCatSfx, type VoidCatSfxCue } from "./voidcat-sfx";

export type NotificationTone = "info" | "success" | "warning" | "error";

export type NotificationInput = {
  title: string;
  message?: string;
  tone?: NotificationTone;
  durationMs?: number;
  sound?: VoidCatSfxCue | false;
};

type NotificationRecord = Required<Pick<NotificationInput, "title" | "tone" | "durationMs">> & {
  id: string;
  message?: string;
};

type NotificationContextValue = {
  notify: (input: NotificationInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
};

const MAX_VISIBLE_NOTIFICATIONS = 4;
const NotificationContext = createContext<NotificationContextValue | null>(null);

function notificationDuration(input: NotificationInput) {
  if (input.durationMs === 0) return 0;
  const fallback = input.tone === "error" ? 8_000 : 5_200;
  return Math.max(2_000, Math.min(20_000, input.durationMs ?? fallback));
}

function toneLabel(tone: NotificationTone) {
  if (tone === "success") return "NOMINAL";
  if (tone === "warning") return "CAUTION";
  if (tone === "error") return "FAULT";
  return "SYSTEM";
}

function NotificationViewport({ notifications, onDismiss }: {
  notifications: NotificationRecord[];
  onDismiss: (id: string) => void;
}) {
  return <section className="notification-viewport" aria-label="System notifications" aria-live="polite" aria-relevant="additions removals">
    {notifications.map((notification) => <article
      className={`notification-card tone-${notification.tone}`}
      key={notification.id}
      role={notification.tone === "error" ? "alert" : "status"}
      style={{ "--vc-notification-duration": `${notification.durationMs}ms` } as CSSProperties}
    >
      <header><span>{toneLabel(notification.tone)}</span><button type="button" aria-label={`Dismiss ${notification.title}`} onClick={() => onDismiss(notification.id)}>×</button></header>
      <strong>{notification.title}</strong>
      {notification.message && <p>{notification.message}</p>}
      {notification.durationMs > 0 && <i aria-hidden="true" />}
    </article>)}
  </section>;
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setNotifications((current) => current.filter((notification) => notification.id !== id));
  }, []);

  const clear = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
    setNotifications([]);
  }, []);

  const notify = useCallback((input: NotificationInput) => {
    const id = crypto.randomUUID();
    const durationMs = notificationDuration(input);
    const record: NotificationRecord = {
      id,
      title: input.title.trim().slice(0, 100) || "VoidCat notification",
      message: input.message?.trim().slice(0, 500),
      tone: input.tone ?? "info",
      durationMs,
    };
    setNotifications((current) => [...current, record].slice(-MAX_VISIBLE_NOTIFICATIONS));
    if (input.sound !== false) requestVoidCatSfx(input.sound ?? (record.tone === "error" ? "error" : record.tone === "warning" ? "warning" : record.tone === "success" ? "confirm" : "navigate"));
    if (durationMs > 0) {
      const timer = window.setTimeout(() => {
        timers.current.delete(id);
        setNotifications((current) => current.filter((notification) => notification.id !== id));
      }, durationMs);
      timers.current.set(id, timer);
    }
    return id;
  }, []);

  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
  }, []);

  const value = useMemo(() => ({ notify, dismiss, clear }), [notify, dismiss, clear]);
  return <NotificationContext.Provider value={value}>
    {children}
    <NotificationViewport notifications={notifications} onDismiss={dismiss} />
  </NotificationContext.Provider>;
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) throw new Error("useNotifications must be used inside NotificationProvider.");
  return context;
}
