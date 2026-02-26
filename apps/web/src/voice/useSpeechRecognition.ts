import { useEffect, useRef, useState } from "react";

type SpeechRecognitionType = typeof window.SpeechRecognition | typeof window.webkitSpeechRecognition;

declare global {
  interface Window {
    webkitSpeechRecognition?: any;
    SpeechRecognition?: any;
  }
}

interface UseSpeechRecognitionResult {
  start: () => void;
  stop: () => void;
  listening: boolean;
  error: string | null;
  transcript: string;
  resetTranscript: () => void;
  supported: boolean;
}

export const useSpeechRecognition = (): UseSpeechRecognitionResult => {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const supported =
    typeof window !== "undefined" &&
    (((window as any).SpeechRecognition as SpeechRecognitionType) ||
      ((window as any).webkitSpeechRecognition as SpeechRecognitionType));

  useEffect(() => {
    if (!supported) return;

    const SpeechRecognitionCtor: SpeechRecognitionType =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    const recognition: SpeechRecognition = new (SpeechRecognitionCtor as any)();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setListening(true);
      setError(null);
    };

    recognition.onerror = (event: any) => {
      setError(event.error || "Speech recognition error");
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognition.onresult = (event: any) => {
      const result = event.results?.[event.resultIndex];
      if (result && result.isFinal) {
        const text = result[0].transcript;
        setTranscript(text);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
      recognitionRef.current = null;
    };
  }, [supported]);

  const start = () => {
    if (!supported || !recognitionRef.current) return;
    setTranscript("");
    setError(null);
    try {
      recognitionRef.current.start();
    } catch {
      // ignore
    }
  };

  const stop = () => {
    if (!supported || !recognitionRef.current) return;
    recognitionRef.current.stop();
  };

  const resetTranscript = () => setTranscript("");

  return {
    start,
    stop,
    listening,
    error,
    transcript,
    resetTranscript,
    supported: !!supported,
  };
};

