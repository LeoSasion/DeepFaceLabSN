import { useEffect, useRef } from "react";

export function PlainLog({ lines, compact = false }) {
  const viewport = useRef(null);

  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [lines]);

  return (
    <div className={"plain-log" + (compact ? " plain-log--compact" : "")} ref={viewport}>
      {lines.map((entry, index) => {
        const row = typeof entry === "string" ? { text: entry } : entry;
        return (
          <div className={"plain-log__line is-" + (row.level || "info")} key={index + "-" + row.text}>
            {row.time && <span className="plain-log__time">[{row.time}]</span>}
            {row.tag && <span className="plain-log__tag">[{row.tag}]</span>}
            <span>{row.text}</span>
          </div>
        );
      })}
    </div>
  );
}
