import { useEffect, useState } from "react";

interface UseTextToSpeechResult {
  speak: (text: string) => void;
  stop: () => void;
  speaking: boolean;
  supported: boolean;
}

export const useTextToSpeech = (): UseTextToSpeechResult => {
  const [speaking, setSpeaking] = useState(false);

  const supported =
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof window.SpeechSynthesisUtterance !== "undefined";

  useEffect(() => {
    if (!supported) return;

    const handleEnd = () => setSpeaking(false);
    window.speechSynthesis.addEventListener("end", handleEnd as any);
    return () => {
      window.speechSynthesis.removeEventListener("end", handleEnd as any);
      window.speechSynthesis.cancel();
    };
  }, [supported]);

  const speak = (text: string) => {
    if (!supported || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  const stop = () => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  };

  return {
    speak,
    stop,
    speaking,
    supported,
  };
};

