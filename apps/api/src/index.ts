import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { loadEnv } from "./env";
import { requireAuth, AuthedRequest } from "./authMiddleware";
import { supabaseAdmin } from "./supabase";
import { ingestDocument } from "./ingestion";
import { handleQaRequest } from "./qa";
import { handleQaFollowup } from "./qaFollowup";
import { handleStudyMcq, handleStudyShort } from "./study";
import { z } from "zod";

const env = loadEnv();

const app = express();

app.use(
  cors({
    origin: "*",
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "10mb" }));

const upload = multer({
  dest: path.join(__dirname, "..", "uploads"),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
  },
});

// Health endpoint (also auth-protected per requirements)
app.get("/health", requireAuth, (req, res) => {
  res.json({ status: "ok" });
});

// Subject schemas
const createSubjectSchema = z.object({
  name: z.string().min(1).max(100),
});

// POST /subjects
app.post("/subjects", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const userId = req.userId!;
    const parsed = createSubjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("subjects")
      .select("id")
      .eq("user_id", userId);

    if (existingError) {
      return res.status(500).json({ error: `Failed to load subjects: ${existingError.message}` });
    }

    if ((existing?.length ?? 0) >= 3) {
      return res.status(400).json({ error: "You can only create up to 3 subjects." });
    }

    const { data, error } = await supabaseAdmin
      .from("subjects")
      .insert({
        user_id: userId,
        name: parsed.data.name,
      })
      .select("*")
      .single();

    if (error) {
      return res.status(500).json({ error: `Failed to create subject: ${error.message}` });
    }

    return res.json(data);
  } catch (err) {
    console.error("POST /subjects error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /subjects
app.get("/subjects", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const userId = req.userId!;
    const { data, error } = await supabaseAdmin
      .from("subjects")
      .select("id, name, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) {
      return res.status(500).json({ error: `Failed to load subjects: ${error.message}` });
    }

    return res.json(data ?? []);
  } catch (err) {
    console.error("GET /subjects error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /documents?subject_id=...
app.get("/documents", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const userId = req.userId!;
    const subjectId = req.query.subject_id as string | undefined;
    if (!subjectId) {
      return res.status(400).json({ error: "subject_id is required" });
    }

    const { data, error } = await supabaseAdmin
      .from("documents")
      .select("id, file_name, page_count, created_at")
      .eq("user_id", userId)
      .eq("subject_id", subjectId)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: `Failed to load documents: ${error.message}` });
    }

    return res.json(data ?? []);
  } catch (err) {
    console.error("GET /documents error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /upload
app.post(
  "/upload",
  requireAuth,
  upload.single("file"),
  async (req: AuthedRequest, res) => {
    const tmpPath = (req.file && req.file.path) || "";
    try {
      const userId = req.userId!;
      const subjectId = req.body.subject_id as string | undefined;

      if (!subjectId) {
        return res.status(400).json({ error: "subject_id is required" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "file is required" });
      }

      // Verify subject belongs to user
      const { data: subject, error: subjectError } = await supabaseAdmin
        .from("subjects")
        .select("id")
        .eq("id", subjectId)
        .eq("user_id", userId)
        .single();

      if (subjectError || !subject) {
        return res.status(400).json({ error: "Subject not found for user" });
      }

      const result = await ingestDocument({
        filePath: tmpPath,
        fileName: req.file.originalname,
        userId,
        subjectId,
      });

      return res.json({
        document_id: result.documentId,
        chunk_count: result.chunkCount,
        page_count: result.pageCount,
      });
    } catch (err: any) {
      console.error("POST /upload error", err);
      return res
        .status(500)
        .json({ error: err?.message ?? "Internal server error during upload" });
    } finally {
      if (tmpPath) {
        fs.promises.unlink(tmpPath).catch(() => undefined);
      }
    }
  }
);

// POST /qa
app.post("/qa", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const userId = req.userId!;
    const result = await handleQaRequest(userId, req.body);
    return res.json(result);
  } catch (err: any) {
    console.error("POST /qa error", err);
    return res
      .status(500)
      .json({ error: err?.message ?? "Internal server error during QA" });
  }
});

// POST /qa/followup
app.post("/qa/followup", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const userId = req.userId!;
    const result = await handleQaFollowup(userId, req.body);
    return res.json(result);
  } catch (err: any) {
    console.error("POST /qa/followup error", err);
    return res
      .status(500)
      .json({ error: err?.message ?? "Internal server error during QA follow-up" });
  }
});

// POST /study/mcq
app.post("/study/mcq", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const userId = req.userId!;
    const result = await handleStudyMcq(userId, req.body);
    return res.json(result);
  } catch (err: any) {
    console.error("POST /study/mcq error", err);
    return res
      .status(500)
      .json({ error: err?.message ?? "Internal server error during study MCQ" });
  }
});

// POST /study/short
app.post("/study/short", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const userId = req.userId!;
    const result = await handleStudyShort(userId, req.body);
    return res.json(result);
  } catch (err: any) {
    console.error("POST /study/short error", err);
    return res
      .status(500)
      .json({ error: err?.message ?? "Internal server error during study short" });
  }
});

app.listen(env.PORT, () => {
  console.log(`AskMyNotes API listening on port ${env.PORT}`);
});
