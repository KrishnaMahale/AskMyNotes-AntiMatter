import { z } from "zod";
import { supabaseAdmin } from "./supabase";
import { callGroqJson, stripPossibleCodeFences } from "./groqClient";

const studyRequestSchema = z.object({
  subject_id: z.string().uuid(),
});

const MCQItemSchema = z.object({
  question: z.string(),
  options: z.object({
    A: z.string(),
    B: z.string(),
    C: z.string(),
    D: z.string(),
  }),
  correct: z.enum(["A", "B", "C", "D"]),
  explanation: z.string(),
  citations: z.array(
    z.object({
      chunk_id: z.string().uuid(),
      file: z.string(),
      page: z.string(),
    })
  ).min(1),
});

const ShortItemSchema = z.object({
  question: z.string(),
  answer: z.string(),
  citations: z.array(
    z.object({
      chunk_id: z.string().uuid(),
      file: z.string(),
      page: z.string(),
    })
  ).min(1),
});

const pickCoverageChunks = (chunks: any[]): any[] => {
  if (chunks.length <= 50) return chunks;

  const keywords = ["definition", "types", "advantages", "algorithm", "steps", "example"];
  const keywordMatches: any[] = [];
  const remaining: any[] = [];

  for (const c of chunks) {
    const lower = (c.content as string).toLowerCase();
    if (keywords.some((k) => lower.includes(k))) {
      keywordMatches.push(c);
    } else {
      remaining.push(c);
    }
  }

  const selected: any[] = [];

  // take up to 25 keyword-based chunks
  keywordMatches.slice(0, 25).forEach((c) => selected.push(c));

  // fill the rest randomly from remaining up to 50
  const shuffled = remaining.sort(() => Math.random() - 0.5);
  shuffled.slice(0, Math.max(0, 50 - selected.length)).forEach((c) => selected.push(c));

  return selected;
};

export const handleStudyMcq = async (userId: string, body: unknown) => {
  const parsed = studyRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(parsed.error.errors.map((e) => e.message).join("; "));
  }
  const { subject_id } = parsed.data;

  const { data: subject, error: subjectError } = await supabaseAdmin
    .from("subjects")
    .select("id, name, user_id")
    .eq("id", subject_id)
    .eq("user_id", userId)
    .single();

  if (subjectError || !subject) {
    throw new Error("Subject not found for user");
  }

  const { data: chunks, error: chunksError } = await supabaseAdmin
    .from("chunks")
    .select("id, file_name, page_range, content")
    .eq("user_id", userId)
    .eq("subject_id", subject_id)
    .limit(200);

  if (chunksError) {
    throw new Error(`Failed to load chunks for study mode: ${chunksError.message}`);
  }

  if (!chunks || chunks.length === 0) {
    return {
      status: "insufficient" as const,
      message: `Insufficient content in your notes for ${subject.name}`,
    };
  }

  const coverage = pickCoverageChunks(chunks);
  const chunkMap = new Map<string, any>();
  coverage.forEach((c) => {
    chunkMap.set(c.id, c);
  });

  const context = coverage
    .map(
      (c) =>
        `CHUNK_ID: ${c.id}\nFILE: ${c.file_name}\nPAGE: ${c.page_range}\nTEXT:\n${c.content}\n---`
    )
    .join("\n\n");

  const systemPrompt = `
You are a study assistant. You ONLY use the provided chunks of text to create questions.
Do not use any outside knowledge.
Always include citations for each question, pointing to the chunk IDs and their file/page.
Output valid JSON only.
`;

  const userPrompt = `
You are given course notes chunks for the subject "${subject.name}".

Chunks:
${context}

Task:
- Create exactly 5 multiple-choice questions (MCQs).
- Each MCQ must have:
  - "question": string
  - "options": { "A": string, "B": string, "C": string, "D": string }
  - "correct": one of "A","B","C","D"
  - "explanation": brief explanation string
  - "citations": array of { "chunk_id": string, "file": string, "page": string } referencing ONLY the chunk IDs given above.

Important:
- Use ONLY the given chunks.
- Every question and explanation must be supported directly by at least one citation.

Return JSON with shape:
{ "items": [ {question, options, correct, explanation, citations: [...]}, ... ] }
`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await callGroqJson(systemPrompt, userPrompt);
      const cleaned = stripPossibleCodeFences(raw);
      const parsedJson = JSON.parse(cleaned);

      const items = Array.isArray(parsedJson.items) ? parsedJson.items : [];
      const validated: any[] = [];

      for (const item of items) {
        const result = MCQItemSchema.safeParse(item);
        if (!result.success) {
          throw new Error("MCQ item validation failed");
        }

        // validate citations reference provided chunks
        for (const cit of result.data.citations) {
          if (!chunkMap.has(cit.chunk_id)) {
            throw new Error("Citation refers to unknown chunk_id");
          }
        }

        validated.push(result.data);
      }

      if (validated.length !== 5) {
        throw new Error("Expected exactly 5 MCQs");
      }

      return {
        status: "ok" as const,
        items: validated,
      };
    } catch (err) {
      lastError = err;
    }
  }

  console.error("Study MCQ generation failed after retries", lastError);
  return {
    status: "insufficient" as const,
    message: `Insufficient content in your notes for ${subject.name}`,
  };
};

export const handleStudyShort = async (userId: string, body: unknown) => {
  const parsed = studyRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(parsed.error.errors.map((e) => e.message).join("; "));
  }
  const { subject_id } = parsed.data;

  const { data: subject, error: subjectError } = await supabaseAdmin
    .from("subjects")
    .select("id, name, user_id")
    .eq("id", subject_id)
    .eq("user_id", userId)
    .single();

  if (subjectError || !subject) {
    throw new Error("Subject not found for user");
  }

  const { data: chunks, error: chunksError } = await supabaseAdmin
    .from("chunks")
    .select("id, file_name, page_range, content")
    .eq("user_id", userId)
    .eq("subject_id", subject_id)
    .limit(200);

  if (chunksError) {
    throw new Error(`Failed to load chunks for study mode: ${chunksError.message}`);
  }

  if (!chunks || chunks.length === 0) {
    return {
      status: "insufficient" as const,
      message: `Insufficient content in your notes for ${subject.name}`,
    };
  }

  const coverage = pickCoverageChunks(chunks);
  const chunkMap = new Map<string, any>();
  coverage.forEach((c) => {
    chunkMap.set(c.id, c);
  });

  const context = coverage
    .map(
      (c) =>
        `CHUNK_ID: ${c.id}\nFILE: ${c.file_name}\nPAGE: ${c.page_range}\nTEXT:\n${c.content}\n---`
    )
    .join("\n\n");

  const systemPrompt = `
You are a study assistant. You ONLY use the provided chunks of text to create questions.
Do not use any outside knowledge.
Always include citations for each question, pointing to the chunk IDs and their file/page.
Output valid JSON only.
`;

  const userPrompt = `
You are given course notes chunks for the subject "${subject.name}".

Chunks:
${context}

Task:
- Create exactly 3 short-answer questions.
- Each item must have:
  - "question": string
  - "answer": model answer string
  - "citations": array of { "chunk_id": string, "file": string, "page": string } referencing ONLY the chunk IDs given above.

Important:
- Use ONLY the given chunks.
- Every question and answer must be supported directly by at least one citation.

Return JSON with shape:
{ "items": [ {question, answer, citations: [...]}, ... ] }
`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await callGroqJson(systemPrompt, userPrompt);
      const cleaned = stripPossibleCodeFences(raw);
      const parsedJson = JSON.parse(cleaned);

      const items = Array.isArray(parsedJson.items) ? parsedJson.items : [];
      const validated: any[] = [];

      for (const item of items) {
        const result = ShortItemSchema.safeParse(item);
        if (!result.success) {
          throw new Error("Short-answer item validation failed");
        }

        for (const cit of result.data.citations) {
          if (!chunkMap.has(cit.chunk_id)) {
            throw new Error("Citation refers to unknown chunk_id");
          }
        }

        validated.push(result.data);
      }

      if (validated.length !== 3) {
        throw new Error("Expected exactly 3 short-answer questions");
      }

      return {
        status: "ok" as const,
        items: validated,
      };
    } catch (err) {
      lastError = err;
    }
  }

  console.error("Study short-answer generation failed after retries", lastError);
  return {
    status: "insufficient" as const,
    message: `Insufficient content in your notes for ${subject.name}`,
  };
};
