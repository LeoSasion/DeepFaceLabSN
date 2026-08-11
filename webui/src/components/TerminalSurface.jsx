import { useEffect, useRef } from "react";
import { useI18n } from "../i18n.jsx";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export default function TerminalSurface({ events, interactive, onInput, onResize }) {
  const { t } = useI18n();
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const lastSequenceRef = useRef(0);
  const inputRef = useRef(onInput);
  const resizeRef = useRef(onResize);

  inputRef.current = onInput;
  resizeRef.current = onResize;

  useEffect(() => {
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      disableStdin: !interactive,
      drawBoldTextInBrightColors: false,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 12,
      letterSpacing: 0,
      lineHeight: 1.28,
      scrollback: 6000,
      theme: {
        background: "#030806",
        foreground: "#b8c6bd",
        cursor: "#2ce39f",
        cursorAccent: "#04100b",
        selectionBackground: "#185b4199",
        black: "#07100d",
        red: "#ff6a57",
        green: "#2ce39f",
        yellow: "#f3b83f",
        blue: "#62b7ff",
        magenta: "#bf6cff",
        cyan: "#4bdccc",
        white: "#dfeae4",
        brightBlack: "#65736b",
        brightRed: "#ff8d7f",
        brightGreen: "#66efb9",
        brightYellow: "#ffd36d",
        brightBlue: "#8fceff",
        brightMagenta: "#d49bff",
        brightCyan: "#88f0e4",
        brightWhite: "#f4fff8",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    terminal.focus();
    terminalRef.current = terminal;
    fitRef.current = fit;

    const inputDisposable = terminal.onData((value) => inputRef.current?.(value));
    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        if (!containerRef.current || !fitRef.current) return;
        fitRef.current.fit();
        resizeRef.current?.(terminal.cols, terminal.rows);
      });
    });
    resizeObserver.observe(containerRef.current);
    resizeRef.current?.(terminal.cols, terminal.rows);

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.disableStdin = !interactive;
  }, [interactive]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    for (const event of events) {
      if (event.sequence <= lastSequenceRef.current) continue;
      lastSequenceRef.current = event.sequence;
      if (event.type === "terminal.output") terminal.write(event.payload.data);
      if (event.type === "job.control") {
        terminal.writeln(`\r\n\u001b[38;2;44;227;159m[WEB]\u001b[0m ${t("已请求 {operation}", { operation: event.payload.operation })}`);
      }
      if (event.type === "job.finished") {
        const color = event.payload.state === "succeeded" ? "44;227;159" : "255;90;70";
        terminal.writeln(
          `\r\n\u001b[38;2;${color}m[WEB]\u001b[0m ${t("任务结束 · {state} · exit {code}", {
            state: event.payload.state,
            code: event.payload.exitCode,
          })}`,
        );
      }
      if (event.type === "protocol.error") {
        terminal.writeln(`\r\n\u001b[38;2;255;90;70m[${t("协议错误")}]\u001b[0m ${event.payload.message}`);
      }
    }
  }, [events, t]);

  return <div className="xterm-surface" ref={containerRef} aria-label={t("任务终端输出")} />;
}
