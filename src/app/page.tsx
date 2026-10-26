"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownWithCitationLinks } from "@/lib/markdown";
import { AuthScreen } from "@/app/auth-screen";
import { authenticatedFetch, getBrowserSupabase } from "@/lib/supabase-browser";
import {
  ArrowDown,
  ArrowUp,
  BookOpenText,
  Check,
  Copy,
  ChevronDown,
  Clock3,
  FileSpreadsheet,
  FileText,
  LogOut,
  LoaderCircle,
  Mic,
  MessageSquareText,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  PanelRightClose,
  RefreshCw,
  Sparkles,
  Square,
  TriangleAlert,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  UserRound,
} from "lucide-react";
import type { ChatResponse, Citation, IndexedDocument } from "@/lib/types";

type ChatSession = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type ChatTurn = {
  id: string;
  question: string;
  answer: string;
  citations: Citation[];
  abstained: boolean;
  intent?: "search" | "transform";
  documentId?: string;
  pending?: boolean;
  status?: string;
  error?: string;
  feedbackId?: string;
  vote?: -1 | 1 | null;
  feedbackPending?: boolean;
  feedbackError?: string;
  retrievalMatchPercent?: number | null;
  feedbackApprovalPercent?: number | null;
  feedbackRatingsCount?: number;
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

function MarkdownAnswer({ turn, onOpenSources }: {
  turn: ChatTurn;
  onOpenSources: (sources: Citation[]) => void;
}) {
  const components: Components = {
    a: ({ href, children, ...props }) => {
      if (href?.startsWith("#citation-")) {
        const citationId = href.slice("#citation-".length);
        if (turn.pending) {
          return <span className="inline-citation" title="Sources appear when the answer is complete">{children}</span>;
        }
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
  const supabase = getBrowserSupabase();
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeSources, setActiveSources] = useState<Citation[]>([]);
  const [documents, setDocuments] = useState<IndexedDocument[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentsError, setDocumentsError] = useState("");
  const [sourceView, setSourceView] = useState<"documents" | "answer">("documents");
  const [activeView, setActiveView] = useState<"chat" | "faq">("chat");
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [copyFeedback, setCopyFeedback] = useState<{ turnId: string; message: string } | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(true);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingFailedRef = useRef(false);
  const transcriptionControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return;
    }

    let mounted = true;
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) console.error("Could not restore authentication session", error);
      setUser(data.session?.user ?? null);
      setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (!session) {
        setTurns([]);
        setSessions([]);
        setActiveSessionId(null);
        setActiveSources([]);
      }
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

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
    if (!supabase || !user) return;
    setDocumentsLoading(true);
    setDocumentsError("");
    try {
      const response = await authenticatedFetch(supabase, "/api/documents", { cache: "no-store" });
      const payload = await response.json() as { documents?: IndexedDocument[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load indexed documents.");
      setDocuments(payload.documents || []);
    } catch (error) {
      setDocumentsError(error instanceof Error ? error.message : "Could not load indexed documents.");
    } finally {
      setDocumentsLoading(false);
    }
  }, [supabase, user]);

  useEffect(() => {
    if (user) void loadDocuments();
  }, [loadDocuments, user]);

  const loadSessions = useCallback(async () => {
    if (!supabase || !user) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const response = await authenticatedFetch(supabase, "/api/conversations", { cache: "no-store" });
      const payload = await response.json() as { sessions?: ChatSession[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load chat history.");
      setSessions(payload.sessions || []);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not load chat history.");
    } finally {
      setHistoryLoading(false);
    }
  }, [supabase, user]);

  useEffect(() => {
    if (user) void loadSessions();
  }, [loadSessions, user]);

  useEffect(() => {
    if (window.matchMedia("(max-width: 900px)").matches) {
      setHistoryOpen(false);
      setSourcesOpen(false);
    }
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [accountMenuOpen]);

  async function ask(value: string, documentId?: string, replaceTurnId?: string) {
    const message = value.trim();
    if (!message || loading || !supabase || !user) return;
    setActiveView("chat");
    const turnId = replaceTurnId || crypto.randomUUID();
    if (!replaceTurnId) setQuestion("");
    setLoading(true);
    setTurns((existing) => replaceTurnId
      ? existing.map((turn) => turn.id === replaceTurnId
        ? {
          ...turn,
          answer: "",
          citations: [],
          abstained: false,
          intent: undefined,
          feedbackId: undefined,
          vote: undefined,
          feedbackPending: false,
          feedbackError: undefined,
          retrievalMatchPercent: undefined,
          feedbackApprovalPercent: undefined,
          feedbackRatingsCount: undefined,
          pending: true,
          status: undefined,
          error: undefined,
        }
        : turn)
      : [...existing, {
        id: turnId,
        question: message,
        answer: "",
        citations: [],
        abstained: false,
        documentId,
        intent: undefined as "search" | "transform" | undefined,
        pending: true,
      }]);
    setSourceView("answer");
    try {
      let sessionId = activeSessionId;
      const turnToSave = {
        id: turnId,
        question: message,
        answer: "",
        citations: [] as Citation[],
        abstained: false,
        documentId,
        intent: undefined as "search" | "transform" | undefined,
        feedbackId: undefined as string | undefined,
        retrievalMatchPercent: undefined as number | null | undefined,
        feedbackApprovalPercent: undefined as number | null | undefined,
        feedbackRatingsCount: undefined as number | undefined,
      };

      const response = await authenticatedFetch(supabase, "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          message,
          turnId,
          ...(activeSessionId ? { sessionId: activeSessionId } : {}),
          ...(documentId ? { documentId } : {}),
        }),
      });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error || "Something went wrong.");
      }

      if (response.headers.get("content-type")?.includes("application/json")) {
        const payload = await response.json() as ChatResponse;
        const citations = payload.citations || [];
        turnToSave.answer = payload.answer;
        turnToSave.citations = citations;
        turnToSave.abstained = payload.abstained;
        turnToSave.intent = payload.intent;
        turnToSave.feedbackId = payload.feedbackId;
        turnToSave.retrievalMatchPercent = payload.retrievalMatchPercent;
        turnToSave.feedbackApprovalPercent = payload.feedbackApprovalPercent;
        turnToSave.feedbackRatingsCount = payload.feedbackRatingsCount;
        setTurns((existing) => existing.map((turn) => turn.id === turnId
          ? {
            ...turn,
            answer: payload.answer,
            citations,
            abstained: payload.abstained,
            intent: payload.intent,
            feedbackId: payload.feedbackId,
            retrievalMatchPercent: payload.retrievalMatchPercent,
            feedbackApprovalPercent: payload.feedbackApprovalPercent,
            feedbackRatingsCount: payload.feedbackRatingsCount,
            pending: false,
          }
          : turn));
        setActiveSources(citations);
      } else {
        if (!response.body) throw new Error("The assistant did not return a response stream.");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamedAnswer = "";
        let receivedFinal = false;

        const handleEvent = (block: string) => {
          const lines = block.replace(/\r/g, "").split("\n");
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          const data = lines.filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!event || !data) return;
          const payload = JSON.parse(data) as ChatResponse & {
            text?: string;
            status?: string;
            error?: string;
          };

          if (event === "status" && payload.status) {
            setTurns((existing) => existing.map((turn) => turn.id === turnId
              ? { ...turn, status: payload.status }
              : turn));
          } else if (event === "token" && payload.text) {
            streamedAnswer += payload.text;
            setTurns((existing) => existing.map((turn) => turn.id === turnId
              ? { ...turn, answer: streamedAnswer, pending: true }
              : turn));
          } else if (event === "final") {
            receivedFinal = true;
            const citations = payload.citations || [];
            turnToSave.answer = payload.answer;
            turnToSave.citations = citations;
            turnToSave.abstained = payload.abstained;
            turnToSave.intent = payload.intent;
            turnToSave.feedbackId = payload.feedbackId;
            turnToSave.retrievalMatchPercent = payload.retrievalMatchPercent;
            turnToSave.feedbackApprovalPercent = payload.feedbackApprovalPercent;
            turnToSave.feedbackRatingsCount = payload.feedbackRatingsCount;
            setTurns((existing) => existing.map((turn) => turn.id === turnId
              ? {
                ...turn,
                answer: payload.answer,
                citations,
                abstained: payload.abstained,
                intent: payload.intent,
                feedbackId: payload.feedbackId,
                retrievalMatchPercent: payload.retrievalMatchPercent,
                feedbackApprovalPercent: payload.feedbackApprovalPercent,
                feedbackRatingsCount: payload.feedbackRatingsCount,
                pending: false,
                status: undefined,
              }
              : turn));
            setActiveSources(citations);
          } else if (event === "error") {
            throw new Error(payload.error || "Something went wrong.");
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || "";
          for (const block of blocks) handleEvent(block);
          if (done) break;
        }
        if (buffer.trim()) handleEvent(buffer);
        if (!receivedFinal) throw new Error("The assistant response ended unexpectedly.");
      }
      if (!sessionId) {
        const createResponse = await authenticatedFetch(supabase, "/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: message.slice(0, 120) }),
        });
        const createPayload = await createResponse.json() as { session?: ChatSession; error?: string };
        if (!createResponse.ok || !createPayload.session) {
          throw new Error(createPayload.error || "Could not create a chat session.");
        }
        sessionId = createPayload.session.id;
        setActiveSessionId(sessionId);
        setSessions((existing) => [createPayload.session!, ...existing]);
      }
      const persistResponse = await authenticatedFetch(supabase, "/api/conversations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "turn", sessionId, turn: turnToSave }),
      });
      const persistPayload = await persistResponse.json() as { error?: string };
      if (!persistResponse.ok) throw new Error(persistPayload.error || "Answer received but could not be saved to chat history.");
      setSessions((existing) => {
        const updated = existing.map((session) => session.id === sessionId
          ? { ...session, updated_at: new Date().toISOString() }
          : session);
        return updated.sort((first, second) => second.updated_at.localeCompare(first.updated_at));
      });
    } catch (error) {
      setTurns((existing) => existing.map((turn) => turn.id === turnId
        ? { ...turn, pending: false, status: undefined, error: error instanceof Error ? error.message : "Could not reach the assistant." }
        : turn));
      setActiveSources([]);
    } finally {
      setLoading(false);
    }
  }

  async function copyAnswer(turn: ChatTurn) {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is not available in this browser.");
      }
      await navigator.clipboard.writeText(turn.answer);
      setCopyFeedback({ turnId: turn.id, message: "Answer copied." });
    } catch {
      setCopyFeedback({
        turnId: turn.id,
        message: "Could not copy the answer. Check clipboard permissions or select the text to copy it.",
      });
    }
  }

  async function rateAnswer(turn: ChatTurn, vote: -1 | 1) {
    if (!supabase || !turn.feedbackId || turn.feedbackPending) return;
    setTurns((existing) => existing.map((item) => item.id === turn.id
      ? { ...item, feedbackPending: true, feedbackError: undefined }
      : item));
    try {
      const response = await authenticatedFetch(supabase, "/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnId: turn.feedbackId, vote }),
      });
      const payload = await response.json() as {
        vote?: -1 | 1;
        approvalPercent?: number | null;
        ratingsCount?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Could not save feedback.");
      setTurns((existing) => existing.map((item) => item.id === turn.id
        ? {
          ...item,
          vote: payload.vote,
          feedbackApprovalPercent: payload.approvalPercent,
          feedbackRatingsCount: payload.ratingsCount,
          feedbackPending: false,
        }
        : item));
    } catch (error) {
      setTurns((existing) => existing.map((item) => item.id === turn.id
        ? {
          ...item,
          feedbackPending: false,
          feedbackError: error instanceof Error ? error.message : "Could not save feedback.",
        }
        : item));
    }
  }

  async function openSession(sessionId: string) {
    if (!supabase || !user || loading) return;
    setHistoryError("");
    setHistoryLoading(true);
    try {
      const response = await authenticatedFetch(
        supabase,
        `/api/conversations?id=${encodeURIComponent(sessionId)}`,
        { cache: "no-store" },
      );
      const payload = await response.json() as {
        session?: ChatSession;
        turns?: Array<{
          id: string;
          question: string;
          answer: string;
          citations: Citation[];
          abstained: boolean;
          intent: "search" | "transform";
          document_id: string | null;
          feedback_id: string | null;
          feedback_vote: -1 | 1 | null;
          retrieval_match_percent: number | null;
          feedback_approval_percent: number | null;
          feedback_ratings_count: number;
        }>;
        error?: string;
      };
      if (!response.ok || !payload.session) throw new Error(payload.error || "Could not open this chat.");
      setActiveSessionId(payload.session.id);
      setTurns((payload.turns || []).map((turn) => ({
        id: turn.id,
        question: turn.question,
        answer: turn.answer,
        citations: turn.citations || [],
        abstained: turn.abstained,
        intent: turn.intent,
        documentId: turn.document_id || undefined,
        feedbackId: turn.feedback_id || undefined,
        vote: turn.feedback_vote,
        retrievalMatchPercent: turn.retrieval_match_percent,
        feedbackApprovalPercent: turn.feedback_approval_percent,
        feedbackRatingsCount: turn.feedback_ratings_count,
      })));
      const latestCitations = payload.turns?.at(-1)?.citations || [];
      setActiveSources(latestCitations);
      setSourceView("answer");
      setActiveView("chat");
      setHistoryOpen(false);
      setQuestion("");
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not open this chat.");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function renameSession(session: ChatSession) {
    if (!supabase) return;
    const title = window.prompt("Rename this chat", session.title)?.trim();
    if (!title || title === session.title) return;
    try {
      const response = await authenticatedFetch(supabase, "/api/conversations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "rename", sessionId: session.id, title }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not rename this chat.");
      setSessions((existing) => existing.map((item) => item.id === session.id ? { ...item, title } : item));
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not rename this chat.");
    }
  }

  async function deleteSession(session: ChatSession) {
    if (!supabase || !window.confirm(`Delete "${session.title}" and its messages? This cannot be undone.`)) return;
    try {
      const response = await authenticatedFetch(
        supabase,
        `/api/conversations?id=${encodeURIComponent(session.id)}`,
        { method: "DELETE" },
      );
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not delete this chat.");
      setSessions((existing) => existing.filter((item) => item.id !== session.id));
      if (activeSessionId === session.id) startFresh();
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not delete this chat.");
    }
  }

  async function signOut() {
    if (!supabase) return;
    discardVoiceWork();
    const { error } = await supabase.auth.signOut();
    if (error) setHistoryError(`Could not sign out: ${error.message}`);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  function startFresh() {
    discardVoiceWork();
    setVoiceError("");
    setTurns([]);
    setActiveSessionId(null);
    setActiveSources([]);
    setSourceView("documents");
    setActiveView("chat");
    setHistoryOpen(false);
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
      if (!supabase) throw new Error("Sign in to transcribe a recording.");
      const response = await authenticatedFetch(supabase, "/api/speech/transcribe", {
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

  if (!authReady) {
    return <main className="auth-loading"><LoaderCircle className="spinner" size={22} /><span>Restoring your workspace…</span></main>;
  }
  if (!supabase) {
    return (
      <main className="auth-loading auth-config-error">
        <TriangleAlert size={22} />
        <h1>Authentication needs setup</h1>
        <p>Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, then restart the app.</p>
      </main>
    );
  }
  if (!user) return <AuthScreen supabase={supabase} />;

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
          <div className="account-menu-wrap" ref={accountMenuRef}>
            <button
              className="account-menu-trigger"
              type="button"
              aria-label="Open account menu"
              aria-haspopup="menu"
              aria-expanded={accountMenuOpen}
              onClick={() => setAccountMenuOpen((open) => !open)}
            >
              <span className="account-avatar">{user.email?.slice(0, 1).toUpperCase() || <UserRound size={16} />}</span>
              <ChevronDown className="account-menu-chevron" size={14} />
            </button>
            {accountMenuOpen && (
              <div className="account-dropdown" role="menu" aria-label="Account">
                <div className="account-dropdown-email">{user.email}</div>
                <div className="account-dropdown-divider" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    void signOut();
                  }}
                >
                  <LogOut size={15} />
                  <span>Log out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="workspace">
        {historyOpen && <button className="history-backdrop" aria-label="Close chat history" onClick={() => setHistoryOpen(false)} />}
        <aside className={`history-sidebar ${historyOpen ? "history-open" : "history-hidden"}`} aria-label="Chat history">
          <div className="history-heading"><Clock3 size={15} /><span>Recent chats</span></div>
          {historyError && <p className="history-error" role="alert">{historyError}</p>}
          {historyLoading && sessions.length === 0 ? (
            <div className="history-loading"><LoaderCircle className="spinner" size={15} /> Loading history…</div>
          ) : sessions.length === 0 ? (
            <p className="history-empty">Your conversations will appear here.</p>
          ) : (
            <div className="history-list">
              {sessions.map((session) => (
                <div className={`history-row ${session.id === activeSessionId ? "selected" : ""}`} key={session.id}>
                  <button className="history-item" onClick={() => void openSession(session.id)} disabled={loading || historyLoading}>
                    <MessageSquareText size={14} /><span>{session.title}</span>
                  </button>
                  <button className="history-action" title="Rename chat" aria-label={`Rename ${session.title}`} onClick={() => void renameSession(session)}><Pencil size={13} /></button>
                  <button className="history-action delete-history" title="Delete chat" aria-label={`Delete ${session.title}`} onClick={() => void deleteSession(session)}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </aside>
        <section className="chat-column">
          <div className="chat-toolbar">
            <button
              className="icon-button history-toggle"
              onClick={() => {
                const opening = !historyOpen;
                setHistoryOpen(opening);
                if (opening && window.matchMedia("(max-width: 900px)").matches) {
                  setSourcesOpen(false);
                }
              }}
              aria-label={historyOpen ? "Hide chat history" : "Show chat history"}
              aria-pressed={historyOpen}
              title={historyOpen ? "Hide chat history" : "Show chat history"}
            >
              {historyOpen ? <PanelLeftClose size={17} /> : <PanelLeft size={17} />}
            </button>
            <div className="chat-tabs" role="tablist" aria-label="Chat views">
              <button role="tab" aria-selected={activeView === "chat"} className={activeView === "chat" ? "selected" : ""} onClick={() => setActiveView("chat")}>Chat</button>
              <button role="tab" aria-selected={activeView === "faq"} className={activeView === "faq" ? "selected" : ""} onClick={() => setActiveView("faq")}>FAQs</button>
            </div>
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
                      <div className="user-message-row">
                        <div className="user-question"><p>{turn.question}</p></div>
                        <span className="conversation-avatar user-avatar" aria-label="You">
                          <UserRound size={16} />
                        </span>
                      </div>
                      {turn.error && !turn.answer ? (
                        <div className="assistant-message-row">
                          <span className="conversation-avatar assistant-avatar" aria-label="AI assistant"><Sparkles size={16} /></span>
                          <div className="error-box"><TriangleAlert size={17} /><span>{turn.error}</span><button onClick={() => void ask(turn.question, turn.documentId, turn.id)}>Try again</button></div>
                        </div>
                      ) : turn.pending && !turn.answer ? (
                        <div className="assistant-message-row">
                          <span className="conversation-avatar assistant-avatar" aria-label="AI assistant"><Sparkles size={16} /></span>
                          <div className="loading-row"><LoaderCircle className="spinner" size={18} /><span>{turn.status || "Thinking…"}</span></div>
                        </div>
                      ) : (
                        <div className="assistant-message-row">
                          <span className="conversation-avatar assistant-avatar" aria-label="AI assistant"><Sparkles size={16} /></span>
                          <div className={`assistant-answer ${turn.abstained ? "abstained" : ""}`}>
                            <div className="answer-content">
                              {turn.abstained && <div className="abstain-tag">NOT FOUND IN SAMPLE SOURCES</div>}
                              {turn.pending ? (
                                <div className="streaming-answer">{turn.answer}</div>
                              ) : (
                                <MarkdownAnswer
                                  key={`completed-${turn.id}`}
                                  turn={turn}
                                  onOpenSources={(sources) => {
                                    setActiveSources(sources);
                                    setSourceView("answer");
                                    setSourcesOpen(true);
                                  }}
                                />
                              )}
                            </div>
                            {turn.pending && <div className="loading-row stream-indicator"><LoaderCircle className="spinner" size={15} /><span>{turn.status || "Writing answer…"}</span></div>}
                            {turn.error && <div className="stream-error" role="alert">{turn.error}</div>}
                            {!turn.pending && turn.answer && (
                              <div className="answer-footer">
                                <div className="retrieval-feedback">
                                  {turn.retrievalMatchPercent !== null && turn.retrievalMatchPercent !== undefined && (
                                    <span
                                      className="retrieval-match"
                                      title="Estimated from the average relevance score of the five highest-scoring selected evidence records; this is not a verified accuracy rate."
                                    >
                                      Evidence match estimate: {turn.retrievalMatchPercent}%
                                    </span>
                                  )}
                                  {turn.feedbackRatingsCount ? (
                                    <span className="feedback-approval">
                                      Your feedback approval: {turn.feedbackApprovalPercent ?? 0}% ({turn.feedbackRatingsCount} ratings)
                                    </span>
                                  ) : null}
                                </div>
                                <div className="answer-action-row">
                                  {turn.intent === "search" && <div className="feedback-buttons" aria-label="Rate this answer">
                                    <button
                                      type="button"
                                      aria-label="Helpful answer"
                                      aria-pressed={turn.vote === 1}
                                      title={turn.feedbackId ? "This answer was helpful" : "Feedback storage is unavailable"}
                                      disabled={!turn.feedbackId || turn.feedbackPending}
                                      className={turn.vote === 1 ? "selected" : ""}
                                      onClick={() => void rateAnswer(turn, 1)}
                                    >
                                      <ThumbsUp size={15} />
                                    </button>
                                    <button
                                      type="button"
                                      aria-label="Unhelpful answer"
                                      aria-pressed={turn.vote === -1}
                                      title={turn.feedbackId ? "This answer was not helpful" : "Feedback storage is unavailable"}
                                      disabled={!turn.feedbackId || turn.feedbackPending}
                                      className={turn.vote === -1 ? "selected" : ""}
                                      onClick={() => void rateAnswer(turn, -1)}
                                    >
                                      <ThumbsDown size={15} />
                                    </button>
                                    {turn.feedbackPending && <span className="answer-action-feedback" role="status">Saving feedback…</span>}
                                    {turn.vote && !turn.feedbackPending && <span className="answer-action-feedback" role="status">Thanks for your feedback.</span>}
                                    {turn.feedbackError && <span className="feedback-error" role="alert">{turn.feedbackError}</span>}
                                  </div>}
                                  <div className="answer-actions">
                                    <button
                                      type="button"
                                      title={copyFeedback?.turnId === turn.id && copyFeedback.message === "Answer copied." ? "Copied" : "Copy answer"}
                                      aria-label="Copy answer"
                                      onClick={() => void copyAnswer(turn)}
                                    >
                                      {copyFeedback?.turnId === turn.id && copyFeedback.message === "Answer copied."
                                        ? <Check size={15} />
                                        : <Copy size={15} />}
                                    </button>
                                    <button
                                      type="button"
                                      title="Retry answer"
                                      aria-label="Retry answer"
                                      onClick={() => void ask(turn.question, turn.documentId, turn.id)}
                                      disabled={loading}
                                    >
                                      <RefreshCw size={15} />
                                    </button>
                                    {copyFeedback?.turnId === turn.id && copyFeedback.message !== "Answer copied." && (
                                      <span className="answer-action-feedback" role="status">{copyFeedback.message}</span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}
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
                    aria-label={recording ? "Stop recording and transcribe" : transcribing ? "Transcribing question" : "Record a question"}
                    title={recording ? "Stop recording" : transcribing ? "Transcribing question" : "Record a question"}
                    className={`record-button ${recording ? "is-recording" : ""}`}
                    type="button"
                    disabled={loading || transcribing}
                    onClick={toggleRecording}
                  >
                    {recording ? <Square size={15} /> : transcribing ? <LoaderCircle className="spinner" size={16} /> : <Mic size={17} />}
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
                        onClick={() => void ask(
                          `Summarize the key information, decisions or figures, actions, and caveats in ${document.filename}.`,
                          document.id,
                        )}
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
                  <span className="source-location">
                    {formatLocation(source.location)} · Score {typeof source.score === "number" ? source.score.toFixed(3) : "unavailable"}
                  </span>
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
