/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";

type MarqueeMetrics = { overflowing: boolean; containerWidth: number; durationSeconds: number };

export function OverflowMarquee({ text }: { text: string }) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const trackRef = useRef<HTMLSpanElement | null>(null);
  const [metrics, setMetrics] = useState<MarqueeMetrics>({ overflowing: false, containerWidth: 0, durationSeconds: 8 });

  useEffect(() => {
    const container = containerRef.current;
    const track = trackRef.current;
    if (!container || !track) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const containerWidth = Math.ceil(container.clientWidth);
      const contentWidth = Math.ceil(track.scrollWidth);
      const overflowing = contentWidth > containerWidth + 2;
      const durationSeconds = Math.min(40, Math.max(8, ((contentWidth + containerWidth) * 2) / 34));
      setMetrics((current) => current.overflowing === overflowing && current.containerWidth === containerWidth && current.durationSeconds === durationSeconds
        ? current
        : { overflowing, containerWidth, durationSeconds });
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    observer.observe(track);
    void document.fonts?.ready.then(schedule);
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [text]);

  const style = {
    "--vc-marquee-space": `${metrics.containerWidth + 14}px`,
    "--vc-marquee-duration": `${metrics.durationSeconds}s`,
  } as CSSProperties;

  return <span className={`vc-safe-marquee ${metrics.overflowing ? "is-overflowing" : ""}`} ref={containerRef} style={style} title={text}>
    <span className="vc-safe-marquee-track" ref={trackRef}>{text}</span>
  </span>;
}
