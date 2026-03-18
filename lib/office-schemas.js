const { z } = require("zod");

const ALLOWED_EXTENSIONS = [".docx", ".pptx"];

// -- Tool input schemas --

const OpenDocumentSessionInput = z.object({
  file_path: z.string().describe("Office 文件的绝对路径（.docx 或 .pptx）"),
});

const AnalyzeDocumentInput = z.object({
  session_id: z.string().describe("文档会话 ID"),
  mode: z.enum(["summary", "search"]).default("summary").describe("分析模式：summary（结构概要）或 search（关键词搜索）"),
  query: z.string().optional().describe("search 模式下的搜索关键词"),
});

const DocxOperation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace_text"),
    target: z.object({ paragraph_index: z.number().describe("目标段落索引（来自 analyze 结果）") }),
    args: z.object({
      old_text: z.string().describe("要替换的原文"),
      new_text: z.string().describe("替换后的文本"),
    }),
  }),
  z.object({
    op: z.literal("insert_paragraph_after"),
    target: z.object({ paragraph_index: z.number() }),
    args: z.object({
      text: z.string(),
      style: z.string().optional().default("Normal"),
    }),
  }),
  z.object({
    op: z.literal("delete_paragraph"),
    target: z.object({ paragraph_index: z.number() }),
    args: z.object({}).optional().default({}),
  }),
]);

const PptxOperation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace_text"),
    target: z.object({
      slide_index: z.number().describe("目标 slide 索引"),
      shape_index: z.number().describe("目标 shape 索引（来自 analyze 结果）"),
    }),
    args: z.object({
      old_text: z.string(),
      new_text: z.string(),
    }),
  }),
  z.object({
    op: z.literal("add_text_slide"),
    target: z.object({ slide_index: z.number() }).optional(),
    args: z.object({
      title: z.string(),
      body: z.string().optional().default(""),
    }),
  }),
  z.object({
    op: z.literal("delete_slide"),
    target: z.object({ slide_index: z.number() }),
    args: z.object({}).optional().default({}),
  }),
]);

const ApplyDocumentOperationsInput = z.object({
  session_id: z.string().describe("文档会话 ID"),
  operations: z.array(z.any()).min(1).max(20).describe("操作列表，最多 20 个"),
});

const SaveDocumentSessionInput = z.object({
  session_id: z.string().describe("文档会话 ID"),
  output_path: z.string().optional().describe("保存路径（默认保存到工作副本位置）"),
  overwrite: z.boolean().optional().default(false).describe("是否允许覆盖已有文件（默认 false）"),
});

module.exports = {
  ALLOWED_EXTENSIONS,
  OpenDocumentSessionInput,
  AnalyzeDocumentInput,
  ApplyDocumentOperationsInput,
  SaveDocumentSessionInput,
  DocxOperation,
  PptxOperation,
};
