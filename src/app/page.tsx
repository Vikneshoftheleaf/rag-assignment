"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowDown,
  ArrowUp,
  BookOpenText,
  ChevronDown,
  FileSpreadsheet,
  FileText,
  LoaderCircle,
  Mic,
  MessageSquareText,
  PanelRightClose,
  RefreshCw,
  Sparkles,
  Square,
  TriangleAlert,
} from "lucide-react";
import type { ChatResponse, Citation, IndexedDocument } from "@/lib/types";

type ChatTurn = {
  id: string;
  question: string;
  answer: string;
  citations: Citation[];
  abstained: boolean;
  pending?: boolean;
  error?: string;
};

const suggestions = [
  "What decisions were recorded at the latest board meeting?",
  "Summarize the reported revenue and profit for the half year.",
  "What did the auditor report about the financial results?",
];

const faqQuestions = [
  {
    category: "Board meetings",
    question: "What key decisions and follow-up actions are recorded in the 22 October 2026 board minutes?",
  },
  {
    category: "Board meetings",
    question: "Who attended the 22 October 2026 board meeting, and what were their roles?",
  },
  {
    category: "Financial results",
    question: "What revenue, expenses, and profit were reported for Q2 and H1 FY2026-27?",
  },
  {
    category: "Audit review",
    question: "What did the auditor conclude about the Q2 and H1 FY2026-27 financial results?",
  },
  {
    category: "Board records",
    question: "What steps does the resolutions register recommend for preparing and issuing a Certified True Copy?",
  },
  {
    category: "Board records",
    question: "What checks should be completed before certifying or sending a Board resolution copy?",
  },
  {
    category: "Document status",
    question: "What approval status and cautions are stated in the illustrative board meeting minutes?",
  },
];

function FileGlyph({ type }: { type: Citation["documentType"] }) {
  if (type === "xlsx") return <FileSpreadsheet size={16} />;
  return <FileText size={16} />;
}

function formatLocation(location: Record<string, unknown>): string {
  const keys = ["page", "section", "heading", "table", "sheet", "row", "cell"];
  const parts = keys
    .filter((key) => location[key] !== undefined && location[key] !== null && `${location[key]}`.trim())
    .map((key) => `${key}: ${location[key]}`);
  return parts.join(" · ") || "Source excerpt";
}

function markdownWithCitationLinks(markdown: string): string {
  const segments = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);
  return segments.map((segment, index) => index % 2 === 0
    ? segment.replace(/\[(S\d+)\](?!\()/g, "[$1](#citation-$1)")
    : segment).join("");
}

function MarkdownAnswer({ turn, onOpenSources }: {
  turn: ChatTurn;
  onOpenSources: (sources: Citation[]) => void;
}) {
  const components: Components = {
    a: ({ href, children, ...props }) => {
      if (href?.startsWith("#citation-")) {
        const citationId = href.slice("#citation-".length);
        return (
          <button
            type="button"
            className="inline-citation"
            aria-label={`Open source ${citationId}`}
            onClick={() => onOpenSources(turn.citations)}
          >
            {children}
          </button>
        );
      }
      return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
    },
  };

  return (
    <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
      {markdownWithCitationLinks(turn.answer)}
    </ReactMarkdown>
  );
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeSources, setActiveSources] = useState<Citation[]>([]);
  const [documents, setDocuments] = useState<IndexedDocument[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentsError, setDocumentsError] = useState("");
  const [sourceView, setSourceView] = useState<"documents" | "answer">("documents");
  const [activeView, setActiveView] = useState<"chat" | "faq">("chat");
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [noticeOpen, setNoticeOpen] = useState(true);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingFailedRef = useRef(false);
  const transcriptionControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation && turns.length > 0) {
      conversation.scrollTop = conversation.scrollHeight;
    }
  }, [turns, loading]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [question]);

  useEffect(() => () => {
    if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    transcriptionControllerRef.current?.abort();
  }, []);

  const loadDocuments = useCallback(async () => {
    setDocumentsLoading(true);
    setDocumentsError("");
    try {
      const response = await fetch("/api/documents", { cache: "no-store" });
      const payload = await response.json() as { documents?: IndexedDocument[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load indexed documents.");
      setDocuments(payload.documents || []);
    } catch (error) {
      setDocumentsError(error instanceof Error ? error.message : "Could not load indexed documents.");
    } finally {
      setDocumentsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    if (window.matchMedia("(max-width: 760px)").matches) {
      setSourcesOpen(false);
    }
  }, []);

  async function ask(value: string) {
    const message = value.trim();
    if (!message || loading) return;
    setActiveView("chat");
    const turnId = crypto.randomUUID();
    setQuestion("");
    setLoading(true);
    setTurns((existing) => [...existing, {
      id: turnId,
      question: message,
      answer: "",
      citations: [],
      abstained: false,
      pending: true,
    }]);
    setSourceView("answer");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const payload = (await response.json()) as ChatResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Something went wrong.");
      const citations = payload.citations || [];
      setTurns((existing) => existing.map((turn) => turn.id === turnId
        ? { ...turn, answer: payload.answer, citations, abstained: payload.abstained, pending: false }
        : turn));
      setActiveSources(citations);
    } catch (error) {
      setTurns((existing) => existing.map((turn) => turn.id === turnId
        ? { ...turn, pending: false, error: error instanceof Error ? error.message : "Could not reach the assistant." }
        : turn));
      setActiveSources([]);
    } finally {
      setLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  function startFresh() {
    discardVoiceWork();
    setVoiceError("");
    setTurns([]);
    setActiveSources([]);
    setSourceView("documents");
    setActiveView("chat");
    setQuestion("");
    textareaRef.current?.focus();
  }

  function stopRecordingResources() {
    if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
    recordingTimeoutRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
  }

  function discardVoiceWork() {
    if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
    recordingTimeoutRef.current = null;
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    recordingChunksRef.current = [];
    transcriptionControllerRef.current?.abort();
    transcriptionControllerRef.current = null;
    setRecording(false);
    setTranscribing(false);
  }

  async function transcribeRecording(blob: Blob) {
    if (!blob.size) {
      setVoiceError("No audio was captured. Please try recording again.");
      return;
    }
    if (blob.size > 2 * 1024 * 1024) {
      setVoiceError("Recording is too large. Try a shorter recording.");
      return;
    }

    setTranscribing(true);
    setVoiceError("");
    const controller = new AbortController();
    transcriptionControllerRef.current = controller;
    try {
      const extension = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
      const form = new FormData();
      form.append("audio", blob, `question.${extension}`);
      const response = await fetch("/api/speech/transcribe", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const payload = await response.json() as { transcript?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not transcribe the recording.");
      const transcript = payload.transcript?.trim();
      if (!transcript) throw new Error("No speech was detected. Please try again or type your question.");
      setQuestion((current) => [current.trim(), transcript].filter(Boolean).join(" "));
      textareaRef.current?.focus();
    } catch (error) {
      if (controller.signal.aborted) return;
      setVoiceError(error instanceof Error ? error.message : "Could not transcribe the recording.");
    } finally {
      if (transcriptionControllerRef.current === controller) transcriptionControllerRef.current = null;
      setTranscribing(false);
    }
  }

  async function startRecording() {
    setVoiceError("");
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setVoiceError("Audio recording is not supported by this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recordingChunksRef.current = [];
      recordingFailedRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size) recordingChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        recordingFailedRef.current = true;
        setVoiceError("Recording failed. Check microphone access and try again.");
        if (recorder.state !== "inactive") recorder.stop();
      };
      recorder.onstop = () => {
        const failed = recordingFailedRef.current;
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        recordingChunksRef.current = [];
        stopRecordingResources();
        if (!failed) void transcribeRecording(blob);
      };
      recorder.start(250);
      setRecording(true);
      recordingTimeoutRef.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 60_000);
    } catch (error) {
      stopRecordingResources();
      setVoiceError(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone access was denied. Allow microphone access or type your question."
        : "Could not start recording. Check your microphone and try again.");
    }
  }

  function toggleRecording() {
    if (recording) {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      return;
    }
    if (!transcribing && !loading) void startRecording();
  }

  function updateQuestion(value: string) {
    setQuestion(value);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    }
  }

  return (
    <main className={`app-shell ${sourcesOpen ? "" : "sources-collapsed"}`}>
      <header className="topbar">
        <div className="brand" aria-label="Silverline">
          <span className="brand-mark"><Sparkles size={18} strokeWidth={1.8} /></span>
        </div>
        <div className="topbar-actions">
          <button className="icon-button source-toggle" onClick={() => setSourcesOpen(!sourcesOpen)} aria-label="Toggle sources">
            <BookOpenText size={18} />
          </button>
          <button className="new-chat-button" onClick={startFresh}><span>＋</span> New chat</button>
        </div>
      </header>

      <div className="workspace">
        <section className="chat-column">
          <div className="chat-tabs" role="tablist" aria-label="Chat views">
            <button role="tab" aria-selected={activeView === "chat"} className={activeView === "chat" ? "selected" : ""} onClick={() => setActiveView("chat")}>Chat</button>
            <button role="tab" aria-selected={activeView === "faq"} className={activeView === "faq" ? "selected" : ""} onClick={() => setActiveView("faq")}>FAQs</button>
          </div>

          {activeView === "faq" ? (
            <div className="faq-view">
              <div className="faq-content">
                <div className="faq-heading">
                  <span className="faq-mark"><MessageSquareText size={18} /></span>
                  <h1>Frequently asked questions</h1>
                  <p>Choose a question to get an answer grounded in the sample documents.</p>
                </div>
                <div className="faq-list">
                  {faqQuestions.map(({ category, question: faqQuestion }) => (
                    <button key={faqQuestion} className="faq-card" onClick={() => void ask(faqQuestion)} disabled={loading}>
                      <span className="faq-category">{category}</span>
                      <span className="faq-question">{faqQuestion}</span>
                      <span className="faq-action">Ask AI <ArrowDown size={14} /></span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="conversation" ref={conversationRef}>
              {turns.length === 0 ? (
                <div className="welcome">
                  <div className="welcome-mark"><Sparkles size={20} /></div>
                  <h1>Ask your documents</h1>
                  <p className="welcome-copy">Get answers grounded in the Silverline sample documents.</p>
                  <div className="suggestions">
                    {suggestions.map((suggestion) => (
                      <button key={suggestion} className="suggestion-card" onClick={() => void ask(suggestion)}>
                        <span>{suggestion}</span><ArrowDown size={15} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="turn-list">
                  {turns.map((turn) => (
                    <article className="turn" key={turn.id}>
                      <div className="user-question"><p>{turn.question}</p></div>
                      {turn.error ? (
                        <div className="error-box"><TriangleAlert size={17} /><span>{turn.error}</span><button onClick={() => void ask(turn.question)}>Try again</button></div>
                      ) : turn.pending ? (
                        <div className="loading-row"><LoaderCircle className="spinner" size={18} /><span>Thinking…</span></div>
                      ) : (
                        <div className={`assistant-answer ${turn.abstained ? "abstained" : ""}`}>
                          <div className="answer-content">
                            {turn.abstained && <div className="abstain-tag">NOT FOUND IN SAMPLE SOURCES</div>}
                            <MarkdownAnswer
                              turn={turn}
                              onOpenSources={(sources) => {
                                setActiveSources(sources);
                                setSourceView("answer");
                                setSourcesOpen(true);
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="composer-area">
            <form className="composer" onSubmit={submit}>
              <textarea
                ref={textareaRef}
                aria-label="Ask about the Silverline sample documents"
                placeholder="Ask a question about the sample documents…"
                value={question}
                maxLength={2000}
                rows={1}
                onChange={(event) => updateQuestion(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(question); } }}
              />
              {recording && <div className="voice-status recording-status" role="status"><span className="recording-dot" /> Recording · tap the microphone to finish (60 sec max)</div>}
              {transcribing && <div className="voice-status" role="status"><LoaderCircle className="spinner" size={14} /> Transcribing your question…</div>}
              {voiceError && <div className="voice-status voice-error" role="alert"><TriangleAlert size={14} /> {voiceError}</div>}
              <div className="composer-footer"><span>Use Shift + Enter for a new line</span>
                <div className="composer-actions">
                  <button
                    aria-label={recording ? "Stop recording and transcribe" : "Record a question"}
                    title={recording ? "Stop recording" : "Record a question"}
                    className={`record-button ${recording ? "is-recording" : ""}`}
                    type="button"
                    disabled={loading || transcribing}
                    onClick={toggleRecording}
                  >
                    {recording ? <Square size={15} /> : transcribing ? <LoaderCircle className="spinner" size={16} /> : <Mic size={17} />}
                    <span>{recording ? "Stop" : transcribing ? "Transcribing" : "Voice"}</span>
                  </button>
                  <button aria-label="Send question" className="send-button" disabled={!question.trim() || loading || transcribing}><ArrowUp size={18} /></button>
                </div>
              </div>
            </form>
            <p className="disclaimer">AI can make mistakes. Verify important details in the cited sources.</p>
          </div>
        </section>

        {sourcesOpen && <button className="source-backdrop" aria-label="Close sources panel" onClick={() => setSourcesOpen(false)} />}
        <aside className={`source-panel ${sourcesOpen ? "" : "panel-hidden"}`} aria-label="Sources panel">
          <div className="panel-heading">
            <div><h2>Sources <span className="source-count">{sourceView === "documents" ? documents.length : activeSources.length}</span></h2></div>
            <div className="panel-actions">
              <button className={`icon-button ${documentsLoading ? "refreshing" : ""}`} onClick={() => void loadDocuments()} disabled={documentsLoading} aria-label="Refresh indexed documents" title="Refresh documents"><RefreshCw size={16} /></button>
              <button className="icon-button collapse-button" onClick={() => setSourcesOpen(false)} aria-label="Close sources panel"><PanelRightClose size={18} /></button>
            </div>
          </div>
          <div className="source-tabs" role="tablist" aria-label="Source views">
            <button role="tab" aria-selected={sourceView === "documents"} className={sourceView === "documents" ? "selected" : ""} onClick={() => setSourceView("documents")}>Documents</button>
            <button role="tab" aria-selected={sourceView === "answer"} className={sourceView === "answer" ? "selected" : ""} onClick={() => setSourceView("answer")}>Answer sources</button>
          </div>
          {sourceView === "documents" ? (
            <div className="source-list">
              {documentsLoading && documents.length === 0 ? (
                <div className="library-state"><LoaderCircle className="spinner" size={19} /><span>Loading indexed documents…</span></div>
              ) : documentsError ? (
                <div className="library-state library-error"><TriangleAlert size={18} /><p>{documentsError}</p><button className="text-action" onClick={() => void loadDocuments()}>Try again</button></div>
              ) : documents.length === 0 ? (
                <div className="empty-sources">
                  <div className="empty-icon"><BookOpenText size={19} /></div>
                  <strong>No indexed documents yet</strong>
                  <p>Index the supplied files with the Docling CLI, then refresh this list.</p>
                </div>
              ) : (
                <>
                  <p className="source-intro">Indexed files available to the assistant</p>
                  {documents.map((document) => (
                    <article className="source-card library-card" key={document.id}>
                      <span className="file-type-icon"><FileGlyph type={document.documentType} /></span>
                      <div className="library-card-details">
                        <h3>{document.filename}</h3>
                        <span className="source-location">{document.chunkCount} passages · {document.factCount} facts</span>
                      </div>
                      <button
                        className="ask-document"
                        type="button"
                        aria-label={`Ask about ${document.filename}`}
                        title={`Ask about ${document.filename}`}
                        onClick={() => void ask(`Summarize the key information in ${document.filename}.`)}
                      >
                        <MessageSquareText size={16} />
                      </button>
                    </article>
                  ))}
                </>
              )}
            </div>
          ) : activeSources.length === 0 ? (
            <div className="empty-sources">
              <div className="empty-icon"><BookOpenText size={19} /></div>
              <strong>No answer sources yet</strong>
              <p>Ask a question to see the matching passages, page or sheet, and file names here.</p>
            </div>
          ) : (
            <div className="source-list">
              <p className="source-intro">Sources cited in the latest answer</p>
              {activeSources.map((source) => (
                <article className="source-card" key={source.id}>
                  <div className="source-card-top"><span className="source-label">{source.id}</span><span className="file-type-icon"><FileGlyph type={source.documentType} /></span></div>
                  <h3>{source.filename}</h3>
                  <span className="source-location">{formatLocation(source.location)}</span>
                  <blockquote>{source.excerpt}{source.excerpt.length >= 420 ? "…" : ""}</blockquote>
                </article>
              ))}
            </div>
          )}
          <div className="corpus-footer"><ChevronDown size={15} /><span>{documents.length} indexed {documents.length === 1 ? "document" : "documents"}</span></div>
        </aside>
      </div>
    </main>
  );
}
