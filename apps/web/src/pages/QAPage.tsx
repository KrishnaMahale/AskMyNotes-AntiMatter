import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useSpeechRecognition } from "../voice/useSpeechRecognition";
import { useTextToSpeech } from "../voice/useTextToSpeech";

interface Subject {
  id: string;
  name: string;
}

type Confidence = "High" | "Medium" | "Low";

interface QASnippet {
  text: string;
  file_name: string;
  page_range: string;
  chunk_id: string;
  similarity: number;
}

interface QAOkResponse {
  status: "ok";
  confidence: Confidence;
  snippets: QASnippet[];
}

interface QANotFoundResponse {
  status: "not_found";
  message: string;
}

type QAResponse = QAOkResponse | QANotFoundResponse;

interface FollowupCitation {
  chunk_id: string;
  file_name: string;
  page_range: string;
}

interface FollowupSupportingExtract {
  text: string;
  chunk_id: string;
  citation?: any;
}

interface FollowupResponse {
  thread_id: string;
  notFound: boolean;
  answer: string;
  citations: FollowupCitation[];
  used_chunk_ids: string[];
  supporting_extracts: FollowupSupportingExtract[];
}

type Message =
  | {
      role: "user";
      text: string;
      at: string;
    }
  | {
      role: "assistant";
      mode: "evidence";
      confidence?: Confidence;
      text: string;
      extracts: QASnippet[];
      citations: FollowupCitation[];
      chunk_ids: string[];
      at: string;
    }
  | {
      role: "assistant";
      mode: "explain";
      text: string;
      citations: FollowupCitation[];
      used_chunk_ids: string[];
      supporting_extracts: FollowupSupportingExtract[];
      at: string;
    };

const createThreadId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
};

const QAPage = () => {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<string>("");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [lastChunkIds, setLastChunkIds] = useState<string[]>([]);
  const [lastExtracts, setLastExtracts] = useState<FollowupSupportingExtract[]>([]);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [autoSubmitVoice, setAutoSubmitVoice] = useState(true);
  const [lastSpokenText, setLastSpokenText] = useState("");

  const {
    start: startListening,
    stop: stopListening,
    listening,
    error: speechError,
    transcript,
    resetTranscript,
    supported: sttSupported,
  } = useSpeechRecognition();

  const {
    speak,
    stop: stopSpeaking,
    speaking,
    supported: ttsSupported,
  } = useTextToSpeech();

  useEffect(() => {
    const loadSubjects = async () => {
      try {
        const res = await api.get<Subject[]>("/subjects");
        setSubjects(res.data);
        if (res.data.length > 0) {
          setSelectedSubject(res.data[0].id);
        }
      } catch (err: any) {
        setError(err?.response?.data?.error ?? "Failed to load subjects");
      }
    };
    void loadSubjects();
  }, []);

  useEffect(() => {
    setThreadId(null);
    setMessages([]);
    setLastChunkIds([]);
    setLastExtracts([]);
  }, [selectedSubject]);

  const handleResetThread = () => {
    setThreadId(null);
    setMessages([]);
    setLastChunkIds([]);
    setLastExtracts([]);
  };

  const speakIfEnabled = (text: string) => {
    if (autoSpeak && ttsSupported && text) {
      speak(text);
    }
  };

  const askNewQuestion = async (text: string) => {
    if (!selectedSubject || !text) return;
    setError(null);
    setLoading(true);
    try {
      const userMessage: Message = {
        role: "user",
        text,
        at: new Date().toISOString(),
      };

      const res = await api.post<QAResponse>("/qa", {
        subject_id: selectedSubject,
        question: text,
      });

      const newThreadId = createThreadId();
      let assistantMessages: Message[] = [];
      let spoken = "";
      let newLastChunkIds: string[] = [];
      let newLastExtracts: FollowupSupportingExtract[] = [];

      if (res.data.status === "not_found") {
        const msg: Message = {
          role: "assistant",
          mode: "evidence",
          confidence: undefined,
          text: res.data.message,
          extracts: [],
          citations: [],
          chunk_ids: [],
          at: new Date().toISOString(),
        };
        assistantMessages = [msg];
        spoken = res.data.message;
      } else {
        const snippets = res.data.snippets;
        const citations: FollowupCitation[] = snippets.map((s) => ({
          chunk_id: s.chunk_id,
          file_name: s.file_name,
          page_range: s.page_range,
        }));
        const chunkIds = Array.from(new Set(snippets.map((s) => s.chunk_id)));
        const msg: Message = {
          role: "assistant",
          mode: "evidence",
          confidence: res.data.confidence,
          text: "",
          extracts: snippets,
          citations,
          chunk_ids: chunkIds,
          at: new Date().toISOString(),
        };
        assistantMessages = [msg];
        spoken = snippets.map((s) => s.text).join(" ");
        newLastChunkIds = chunkIds;
        newLastExtracts = snippets.map((s) => ({
          text: s.text,
          chunk_id: s.chunk_id,
          citation: {
            file_name: s.file_name,
            page_range: s.page_range,
          },
        }));
      }

      setThreadId(newThreadId);
      setLastChunkIds(newLastChunkIds);
      setLastExtracts(newLastExtracts);
      setMessages((prev) => [...prev, userMessage, ...assistantMessages]);
      setLastSpokenText(spoken);
      speakIfEnabled(spoken);
      setQuestion("");
    } catch (err: any) {
      setError(err?.response?.data?.error ?? "Failed to run Q&A");
    } finally {
      setLoading(false);
    }
  };

  const askFollowup = async (text: string) => {
    if (!threadId || !selectedSubject || !text) return;
    setError(null);
    setLoading(true);
    try {
      const userMessage: Message = {
        role: "user",
        text,
        at: new Date().toISOString(),
      };

      const res = await api.post<FollowupResponse>("/qa/followup", {
        subject_id: selectedSubject,
        question: text,
        thread_id: threadId,
        context: {
          last_chunk_ids: lastChunkIds,
          last_extracts: lastExtracts,
        },
      });

      const assistantText = res.answer;
      const assistantMessage: Message = {
        role: "assistant",
        mode: "explain",
        text: assistantText,
        citations: res.citations,
        used_chunk_ids: res.used_chunk_ids,
        supporting_extracts: res.supporting_extracts,
        at: new Date().toISOString(),
      };

      setLastChunkIds(res.used_chunk_ids.length ? res.used_chunk_ids : lastChunkIds);
      setLastExtracts(res.supporting_extracts);
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setLastSpokenText(assistantText);
      speakIfEnabled(assistantText);
      setQuestion("");
    } catch (err: any) {
      setError(err?.response?.data?.error ?? "Failed to run follow-up Q&A");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!transcript) return;
    const raw = transcript.trim();
    const lower = raw.toLowerCase();

    const handleNewQuestion = async (text: string) => {
      setQuestion(text);
      if (autoSubmitVoice) {
        handleResetThread();
        await askNewQuestion(text);
      }
    };

    const handleFollowupVoice = async (text: string) => {
      setQuestion(text);
      if (!threadId) {
        setError("Ask a first question first.");
        return;
      }
      if (autoSubmitVoice) {
        await askFollowup(text);
      }
    };

    const withoutPrefix = (prefix: string) => raw.slice(prefix.length).trim();

    if (lower.startsWith("stop listening")) {
      stopListening();
      resetTranscript();
      return;
    }
    if (lower.startsWith("stop speaking")) {
      stopSpeaking();
      resetTranscript();
      return;
    }
    if (lower.startsWith("new question")) {
      const text = withoutPrefix("new question");
      void handleNewQuestion(text);
      resetTranscript();
      return;
    }
    if (lower.startsWith("follow up")) {
      const text = withoutPrefix("follow up");
      void handleFollowupVoice(text);
      resetTranscript();
      return;
    }
    if (lower.startsWith("ask")) {
      const text = withoutPrefix("ask");
      if (threadId) {
        void handleFollowupVoice(text);
      } else {
        void handleNewQuestion(text);
      }
      resetTranscript();
      return;
    }

    setQuestion(raw);
    if (autoSubmitVoice) {
      if (threadId) {
        void handleFollowupVoice(raw);
      } else {
        void handleNewQuestion(raw);
      }
    }
    resetTranscript();
  }, [transcript, autoSubmitVoice, threadId, stopListening, stopSpeaking, resetTranscript]);

  const currentThreadMessages = useMemo(() => messages, [messages]);

  const handleNewQuestionClick = async (e: FormEvent) => {
    e.preventDefault();
    handleResetThread();
    await askNewQuestion(question);
  };

  const handleFollowupClick = async (e: FormEvent) => {
    e.preventDefault();
    if (!threadId) return;
    await askFollowup(question);
  };

  return (
    <div className="page-shell max-w-4xl">
      <div>
        <h1 className="page-title">Q&amp;A</h1>
        <p className="page-subtitle">
          First questions use evidence mode (verbatim snippets). Follow-ups use explain mode grounded in
          the same notes.
        </p>
      </div>

      {error && <p className="text-sm text-red-400 mb-2">{error}</p>}
      {speechError && <p className="text-sm text-red-400 mb-2">{speechError}</p>}

      <div className="card-subtle p-5 space-y-4 mb-4">
        <div className="flex flex-col md:flex-row gap-3 md:items-center">
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-400 mb-1.5">
              Subject
            </label>
            <select
              className="select md:min-w-[220px]"
              value={selectedSubject}
              onChange={(e) => setSelectedSubject(e.target.value)}
            >
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <label className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                className="rounded border-slate-600 bg-slate-900/60"
                checked={autoSpeak}
                onChange={(e) => setAutoSpeak(e.target.checked)}
              />
              Auto speak
            </label>
            <label className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                className="rounded border-slate-600 bg-slate-900/60"
                checked={autoSubmitVoice}
                onChange={(e) => setAutoSubmitVoice(e.target.checked)}
              />
              Auto submit voice
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            {ttsSupported && (
              <>
                <button
                  type="button"
                  onClick={() => speak(lastSpokenText)}
                  disabled={!lastSpokenText}
                  className="btn-ghost px-2 py-1 disabled:opacity-50"
                >
                  Speak again
                </button>
                <button
                  type="button"
                  onClick={stopSpeaking}
                  className="btn-ghost px-2 py-1"
                >
                  Stop speaking
                </button>
              </>
            )}
            {sttSupported && (
              <button
                type="button"
                onClick={listening ? stopListening : startListening}
                className={`btn-ghost px-2 py-1 ${
                  listening ? "border-emerald-400 text-emerald-300" : ""
                }`}
              >
                {listening ? "Stop listening" : "Start voice"}
              </button>
            )}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-400 mb-1.5">
            Question
          </label>
          <textarea
            className="textarea"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={
              threadId
                ? "Ask a follow-up about this subject..."
                : "Ask a first question about this subject..."
            }
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500 max-w-xs">
            Evidence mode never calls an LLM. Follow-ups use Groq but stay grounded in your note chunks.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              onClick={handleNewQuestionClick}
              disabled={loading || !question || !selectedSubject}
              className="btn-primary"
            >
              New Question (Evidence Mode)
            </button>
            <button
              type="submit"
              onClick={handleFollowupClick}
              disabled={loading || !question || !selectedSubject || !threadId}
              className="btn-secondary"
            >
              Ask Follow-up (Explain Mode)
            </button>
            <button
              type="button"
              onClick={handleResetThread}
              className="text-xs text-slate-500 underline"
            >
              Reset thread
            </button>
          </div>
        </div>
      </div>

      <div className="card p-5 space-y-3">
        <h2 className="text-lg font-medium text-slate-50 mb-1">Thread</h2>
        {currentThreadMessages.length === 0 ? (
          <p className="text-sm text-slate-400">
            No questions yet. Ask something to start a new thread.
          </p>
        ) : (
          <div className="space-y-3">
            {currentThreadMessages.map((m, idx) => {
              if (m.role === "user") {
                return (
                  <div key={idx} className="flex justify-end">
                    <div className="max-w-[80%] rounded-lg bg-slate-200 text-slate-900 px-3 py-2 text-sm">
                      {m.text}
                    </div>
                  </div>
                );
              }

              if (m.mode === "evidence") {
                return (
                  <div key={idx} className="flex justify-start">
                    <div className="max-w-[80%] rounded-lg border border-slate-800/80 bg-slate-900/70 px-3 py-2 text-sm space-y-2">
                      {m.confidence && (
                        <p className="text-xs">
                          <span className="font-semibold text-slate-200">Confidence:</span>{" "}
                          <span
                            className={
                              m.confidence === "High"
                                ? "text-emerald-400"
                                : m.confidence === "Medium"
                                ? "text-amber-300"
                                : "text-red-400"
                            }
                          >
                            {m.confidence}
                          </span>
                        </p>
                      )}
                      {m.extracts.length > 0 && (
                        <div className="space-y-2">
                          {m.extracts.map((s) => (
                            <div
                              key={s.chunk_id + s.page_range + s.text.slice(0, 8)}
                              className="rounded border border-slate-800 bg-slate-900/80 p-2"
                            >
                              <p className="text-sm text-slate-100 whitespace-pre-line">
                                {s.text}
                              </p>
                              <p className="text-xs text-slate-500 mt-1">
                                <span className="font-semibold text-slate-300">Source:</span>{" "}
                                {s.file_name} — page {s.page_range}, chunk {s.chunk_id}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                      {!m.extracts.length && m.text && (
                        <p className="text-sm text-slate-200 whitespace-pre-line">{m.text}</p>
                      )}
                    </div>
                  </div>
                );
              }

              return (
                <div key={idx} className="flex justify-start">
                  <div className="max-w-[80%] rounded-lg border border-slate-800/80 bg-slate-900/70 px-3 py-2 text-sm space-y-2">
                    <p className="text-sm text-slate-100 whitespace-pre-line">{m.text}</p>
                    {m.citations.length > 0 && (
                      <p className="text-xs text-slate-500">
                        <span className="font-semibold text-slate-300">Citations:</span>{" "}
                        {m.citations
                          .map(
                            (c) =>
                              `${c.file_name} (page ${c.page_range}, chunk ${c.chunk_id})`
                          )
                          .join("; ")}
                      </p>
                    )}
                    {m.supporting_extracts.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs font-semibold text-slate-400">
                          Supporting extracts:
                        </p>
                        {m.supporting_extracts.map((e) => (
                          <div
                            key={e.chunk_id + e.text.slice(0, 8)}
                            className="text-xs text-slate-200"
                          >
                            <p className="whitespace-pre-line">{e.text}</p>
                            {e.citation && (
                              <p className="text-[10px] text-slate-500">
                                {e.citation.file_name} (page {e.citation.page_range}, chunk{" "}
                                {e.chunk_id})
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default QAPage;
