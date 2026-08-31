import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Attachment, Bot, ModelRecord } from "../lib/types";

/**
 * A native <select> sizes itself to its widest option, which leaves the chip
 * padded out with dead space and pushes the controls apart. This keeps the
 * real select for behaviour and accessibility, but lets the visible width
 * follow the selected label.
 */
function Chip({
  label,
  overridden,
  title,
  value,
  onChange,
  children,
}: {
  label: string;
  overridden: boolean;
  title: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <span className="chip-select" data-override={overridden} title={title}>
      <span className="chip-select__label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={title}>
        {children}
      </select>
    </span>
  );
}

/**
 * Modelled on the Claude bar: `+` on the left, then model, thinking level and
 * microphone on the right.
 *
 * The model chip is a *one-off override* that snaps back next message — the
 * bot's real default lives in its details drawer, so you never get invisible
 * state and a surprise bill. Thinking levels come from the gateway per bot,
 * because which levels exist depends on the model behind it.
 */
export function Composer({
  bot,
  models,
  running,
  prefill,
  onSend,
  onStop,
}: {
  bot: Bot;
  models: ModelRecord[];
  running: boolean;
  prefill?: string;
  onSend: (text: string, opts: { model?: string; thinking?: string; attachments?: Attachment[] }) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [thinking, setThinking] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prefill) setText(prefill);
  }, [prefill]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 208)}px`;
  }, [text]);

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files).slice(0, 10)) {
        const buf = await file.arrayBuffer();
        let binary = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        const saved = await api.attach(bot.id, file.name, btoa(binary));
        setAttachments((prev) => [...prev, saved]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = () => {
    const value = text.trim();
    if ((!value && attachments.length === 0) || running) return;
    const opts: { model?: string; thinking?: string; attachments?: Attachment[] } = {};
    if (modelOverride) opts.model = modelOverride;
    if (thinking) opts.thinking = thinking;
    if (attachments.length > 0) opts.attachments = attachments;
    onSend(value, opts);
    setText("");
    setAttachments([]);
    // One-off means one-off.
    setModelOverride("");
    setThinking("");
  };

  // "Claude Opus 4.8 (Claude CLI)" -> "Claude Opus 4.8"; the backend is an
  // implementation detail and the chip has little room.
  const defaultModelLabel = (
    bot.effectiveModelLabel ??
    bot.effectiveModel?.split("/").pop() ??
    "Default model"
  ).replace(/\s*\([^)]*\)\s*$/, "");
  const thinkingOptions = bot.thinkingOptions ?? [];
  const thinkingDefault = bot.thinkingDefault ?? "off";
  const levelLabel = (level: string) => level.charAt(0).toUpperCase() + level.slice(1);

  // No dictation control here on purpose. Electron ships without Google's
  // speech keys, so the Web Speech API starts and then never returns a word,
  // and every speech-to-text backend OpenClaw supports needs a paid API key
  // that is not configured. A button that cannot work does not belong here.
  return (
    <div className="composer">
      <div className="composer__inner" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
        e.preventDefault();
        void addFiles(e.dataTransfer.files);
      }}>
        {attachments.length > 0 && (
          <div className="composer__files">
            {attachments.map((a) => (
              <span className="filechip" key={a.path}>
                {a.name}
                <button
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={`Message ${bot.name}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />

        <div className="composer__bar">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => void addFiles(e.target.files)}
          />
          <button
            className="iconbtn"
            title="Attach files"
            aria-label="Attach files"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>

          <span className="spacer" />

          <div className="composer__chips">
            <Chip
              label={
                modelOverride
                  ? (models.find((m) => `${m.provider}/${m.id}` === modelOverride)?.name ?? modelOverride)
                      .replace(/\s*\([^)]*\)\s*$/, "")
                  : defaultModelLabel
              }
              overridden={modelOverride !== ""}
              title={modelOverride ? "Just this message" : `Default: ${defaultModelLabel}`}
              value={modelOverride}
              onChange={setModelOverride}
            >
              <option value="">{defaultModelLabel}</option>
              {models.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.name}
                </option>
              ))}
            </Chip>

            {/* Only shown when the model behind this bot actually has levels. */}
            {thinkingOptions.length > 0 && (
              <Chip
                label={`Thinking: ${levelLabel(thinking || thinkingDefault)}`}
                overridden={thinking !== ""}
                title="Thinking level, just this message"
                value={thinking}
                onChange={setThinking}
              >
                <option value="">{levelLabel(thinkingDefault)}</option>
                {thinkingOptions
                  .filter((t) => t !== thinkingDefault)
                  .map((t) => (
                    <option key={t} value={t}>
                      {levelLabel(t)}
                    </option>
                  ))}
              </Chip>
            )}
          </div>

          {running ? (
            <button className="iconbtn iconbtn--stop" onClick={onStop} title="Stop" aria-label="Stop">
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="2" y="2" width="8" height="8" rx="1.6" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              className="iconbtn iconbtn--send"
              onClick={submit}
              disabled={!text.trim() && attachments.length === 0}
              title="Send"
              aria-label="Send"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 13V3.5M4 7l4-3.7L12 7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>
          )}
        </div>
        {error && <div className="composer__error">{error}</div>}
      </div>
    </div>
  );
}
