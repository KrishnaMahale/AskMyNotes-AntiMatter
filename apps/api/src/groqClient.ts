import Groq from "groq-sdk";
import { loadEnv } from "./env";

const env = loadEnv();

const groq = new Groq({
  apiKey: env.GROQ_API_KEY,
});

export const callGroqJson = async (systemPrompt: string, userPrompt: string): Promise<string> => {
  const completion = await groq.chat.completions.create({
    model: env.GROQ_LLM_MODEL,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Groq returned empty response");
  }
  return content;
};

export const stripPossibleCodeFences = (text: string): string => {
  return text.replace(/```json/g, "").replace(/```/g, "").trim();
};

