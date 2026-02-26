import { z } from "zod";
import { supabaseAdmin } from "./supabase";
import { embedText } from "./providers/embeddings";
import { callGroqJson, stripPossibleCodeFences } from "./groqClient";

const followupSchema = z.object({
  subject_id: z.string().uuid(),
  question: z.string().min(1),
  thread_id: z.string().min(1),
  context: z.object({
    last_chunk_ids: z.array(z.string().uuid()),
    last_extracts: z.array(
      z.object({
        text: z.string(),
        chunk_id: z.string().uuid(),
        citation: z.any().optional(),
      })
    ),
  }),
});

const STOPWORDS = new Set([
  "the",
  "is",
  "and",
  "or",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "from",
  "as",
  "that",
  "this",
  "it",
  "are",
  "was",
  "be",
  "can",
  "will",
  "shall",
]);

const splitIntoSentences = (text: string): string[] => {
  return text
    .split(/(?<=[\.!\?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

const sentenceScore = (sentence: string, questionTokens: Set<string>): number => {
  const tokens = sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
  let score = 0;
  for (const t of tokens) {
    if (questionTokens.has(t)) score += 1;
  }
  return score;
};

interface ChunkRecord {
  id: string;
  file_name: string;
  page_range: string;
  content: string;
}

interface GroqFollowupRaw {
  notFound?: boolean;
  answer?: string;
  citations?: { chunk_id: string; file_name: string; page_range: string }[];
  used_chunk_ids?: string[];
}

export const handleQaFollowup = async (userId: string, body: unknown) => {
  const parsed = followupSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(parsed.error.errors.map((e) => e.message).join("; "));
  }
  const { subject_id, question, thread_id, context } = parsed.data;

  const { data: subject, error: subjectError } = await supabaseAdmin
    .from("subjects")
    .select("id, name, user_id")
    .eq("id", subject_id)
    .eq("user_id", userId)
    .single();

  if (subjectError || !subject) {
    throw new Error("Subject not found for user");
  }

  const baseChunkIds = Array.from(new Set(context.last_chunk_ids));

  let allChunks: ChunkRecord[] = [];
  if (baseChunkIds.length > 0) {
    const { data: baseChunks, error: baseError } = await supabaseAdmin
      .from("chunks")
      .select("id, file_name, page_range, content")
      .eq("user_id", userId)
      .eq("subject_id", subject_id)
      .in("id", baseChunkIds);
    if (baseError) {
      throw new Error(`Failed to load context chunks: ${baseError.message}`);
    }
    if (baseChunks) {
      allChunks = baseChunks as ChunkRecord[];
    }
  }

  try {
    const questionEmbedding = await embedText(question);
    const { data: matches, error: matchError } = await supabaseAdmin.rpc("match_chunks", {
      p_user_id: userId,
      p_subject_id: subject_id,
      query_embedding: questionEmbedding,
      match_count: 3,
    });
    if (!matchError && matches && matches.length > 0) {
      const existingIds = new Set(allChunks.map((c) => c.id));
      for (const m of matches as any[]) {
        if (!existingIds.has(m.id)) {
          allChunks.push({
            id: m.id,
            file_name: m.file_name,
            page_range: m.page_range,
            content: m.content,
          });
          existingIds.add(m.id);
        }
      }
    }
  } catch (err) {
    console.error("Optional vector search for follow-up failed", err);
  }

  if (allChunks.length === 0) {
    return {
      thread_id,
      notFound: true,
      answer: "Not found in your notes for this subject.",
      citations: [] as { chunk_id: string; file_name: string; page_range: string }[],
      used_chunk_ids: [] as string[],
      supporting_extracts: [] as { text: string; chunk_id: string; citation?: any }[],
    };
  }

  const allowedChunkIds = new Set(allChunks.map((c) => c.id));

  const contextText = allChunks
    .map(
      (c) =>
        `CHUNK_ID: ${c.id}\nFILE: ${c.file_name}\nPAGE_RANGE: ${c.page_range}\nTEXT:\n${c.content}\n---`
    )
    .join("\n\n");

  const systemPrompt = `
You are a helpful explanation assistant for study notes.
You ONLY use the provided chunks of text to answer.
If the answer is not clearly contained in the chunks, you MUST treat it as not found.
You must respond with STRICT JSON ONLY (no markdown, no extra text).
`;

  const userPrompt = `
You are given note chunks for the subject "${subject.name}".

Chunks:
${contextText}

Follow-up question:
${question}

Instructions:
- Answer ONLY using the information from the given chunks.
- If the answer is not present in the chunks, set "notFound": true.
- When "notFound" is true, "answer" MUST be exactly: "Not found in your notes for this subject."
- When "notFound" is false, provide a concise natural-language explanation in "answer".
- Always include "citations" referencing the chunks you used:
  - Each citation must be: { "chunk_id": string, "file_name": string, "page_range": string }.
- Also include an array "used_chunk_ids" listing the IDs of all chunks you relied on.

Return STRICT JSON ONLY with shape:
{
  "notFound": boolean,
  "answer": string,
  "citations": [{ "chunk_id": "...", "file_name": "...", "page_range": "..." }],
  "used_chunk_ids": string[]
}
`;

  const raw = await callGroqJson(systemPrompt, userPrompt);
  const cleaned = stripPossibleCodeFences(raw);

  let parsedJson: GroqFollowupRaw;
  try {
    parsedJson = JSON.parse(cleaned) as GroqFollowupRaw;
  } catch (err) {
    console.error("Failed to parse Groq follow-up JSON", err, cleaned);
    return {
      thread_id,
      notFound: true,
      answer: "Not found in your notes for this subject.",
      citations: [] as { chunk_id: string; file_name: string; page_range: string }[],
      used_chunk_ids: [] as string[],
      supporting_extracts: [] as { text: string; chunk_id: string; citation?: any }[],
    };
  }

  let notFound = !!parsedJson.notFound;
  let answer = parsedJson.answer ?? "";
  let citations = Array.isArray(parsedJson.citations) ? parsedJson.citations : [];
  let usedChunkIds = Array.isArray(parsedJson.used_chunk_ids) ? parsedJson.used_chunk_ids : [];

  citations = citations.filter((c) => allowedChunkIds.has(c.chunk_id));

  if (usedChunkIds.length === 0) {
    usedChunkIds = citations.map((c) => c.chunk_id);
  }
  usedChunkIds = Array.from(new Set(usedChunkIds.filter((id) => allowedChunkIds.has(id))));

  if (citations.length === 0 || usedChunkIds.length === 0) {
    notFound = true;
  }

  if (notFound) {
    answer = "Not found in your notes for this subject.";
    citations = [];
    usedChunkIds = [];
  }

  const qTokens = new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t && !STOPWORDS.has(t))
  );

  type SupportingExtract = { text: string; chunk_id: string; citation?: any };
  const supportingExtracts: SupportingExtract[] = [];

  if (!notFound && usedChunkIds.length > 0) {
    const chunkById = new Map<string, ChunkRecord>();
    allChunks.forEach((c) => chunkById.set(c.id, c));

    const evidences: {
      text: string;
      chunk_id: string;
      file_name: string;
      page_range: string;
      score: number;
    }[] = [];

    for (const cid of usedChunkIds) {
      const c = chunkById.get(cid);
      if (!c) continue;
      const sentences = splitIntoSentences(c.content);
      for (const s of sentences) {
        const score = sentenceScore(s, qTokens);
        if (score <= 0) continue;
        evidences.push({
          text: s,
          chunk_id: cid,
          file_name: c.file_name,
          page_range: c.page_range,
          score,
        });
      }
    }

    evidences.sort((a, b) => b.score - a.score);
    const top = evidences.slice(0, 8);
    for (const e of top) {
      supportingExtracts.push({
        text: e.text,
        chunk_id: e.chunk_id,
        citation: {
          file_name: e.file_name,
          page_range: e.page_range,
        },
      });
    }
  }

  return {
    thread_id,
    notFound,
    answer,
    citations,
    used_chunk_ids: usedChunkIds,
    supporting_extracts: supportingExtracts,
  };
};

