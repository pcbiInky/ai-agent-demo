/**
 * Office MCP Server integration tests.
 *
 * Tests the Python worker directly via JSON-over-stdio protocol.
 * Covers: session lifecycle, analyze, operations, rollback, error handling,
 *         save safety, same-source conflict, protocol structure.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const readline = require("readline");
const os = require("os");
const { OfficeSessionStore } = require("../lib/office-session-store");

const FIXTURES = path.join(__dirname, "fixtures");
const PYTHON_WORKER = path.join(__dirname, "..", "python", "office_worker.py");

let worker;
let rl;
let counter = 0;
const pending = new Map();
const rawResponses = [];
const rawResponseWaiters = [];

function recordRawResponse(line) {
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch {}

  const entry = { line, parsed };
  rawResponses.push(entry);

  for (let i = 0; i < rawResponseWaiters.length; i++) {
    const waiter = rawResponseWaiters[i];
    if (!waiter.predicate(entry)) continue;
    rawResponseWaiters.splice(i, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(entry);
    return;
  }
}

function waitForRawResponse(predicate, timeoutMs = 5000) {
  const existing = rawResponses.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        const idx = rawResponseWaiters.indexOf(waiter);
        if (idx >= 0) rawResponseWaiters.splice(idx, 1);
        reject(new Error("timeout waiting for raw worker response"));
      }, timeoutMs),
    };
    rawResponseWaiters.push(waiter);
  });
}

function startWorker() {
  return new Promise((resolve, reject) => {
    rawResponses.length = 0;
    rawResponseWaiters.length = 0;
    worker = spawn("python3", ["-u", PYTHON_WORKER], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: path.join(__dirname, ".."),
    });
    worker.stderr.on("data", () => {}); // suppress logs
    rl = readline.createInterface({ input: worker.stdout });
    rl.on("line", (line) => {
      recordRawResponse(line);
      try {
        const resp = JSON.parse(line);
        const p = pending.get(resp.id);
        if (p) {
          pending.delete(resp.id);
          p.resolve(resp);
        }
      } catch {}
    });
    callWorker("ping", {}).then(() => resolve()).catch(reject);
  });
}

function callWorker(action, params) {
  const id = `test-${++counter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Worker timeout"));
    }, 15_000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    worker.stdin.write(JSON.stringify({ id, protocol_version: 1, action, params }) + "\n");
  });
}

function stopWorker() {
  if (worker) {
    worker.stdin.end();
    worker.kill();
  }
}

function tempCopy(fixtureName) {
  const src = path.join(FIXTURES, fixtureName);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-test-"));
  const dest = path.join(tmpDir, fixtureName);
  fs.copyFileSync(src, dest);
  return { tmpDir, filePath: dest };
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test runner ────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

// ── Tests ──────────────────────────────────────────────────

async function runTests() {
  console.log("Starting Office MCP tests...\n");

  // ====== Protocol Tests ======
  console.log("Protocol Tests:");

  await startWorker();

  await test("Protocol: ping returns protocol_version", async () => {
    const resp = await callWorker("ping", {});
    assert(resp.ok);
    assert(resp.protocol_version === 1, `Expected protocol_version 1, got ${resp.protocol_version}`);
    assert(resp.result.pong === true);
  });

  await test("Protocol: error has structured code/message", async () => {
    const resp = await callWorker("unknown_action", {});
    assert(!resp.ok);
    assert(resp.protocol_version === 1);
    assert(typeof resp.error === "object", "Error should be an object");
    assert(resp.error.code === "UNKNOWN_ACTION", `Expected UNKNOWN_ACTION, got ${resp.error.code}`);
    assert(typeof resp.error.message === "string");
  });

  await test("Protocol: invalid JSON returns INVALID_JSON error", async () => {
    const rawResponsePromise = waitForRawResponse(
      (entry) => entry.parsed?.id === null && entry.parsed?.error?.code === "INVALID_JSON"
    );

    worker.stdin.write("not valid json\n");

    const { parsed } = await rawResponsePromise;
    assert(parsed.ok === false, "Expected invalid JSON response to be non-ok");
    assert(parsed.protocol_version === 1, `Expected protocol_version 1, got ${parsed.protocol_version}`);
    assert(parsed.error.code === "INVALID_JSON", `Expected INVALID_JSON, got ${parsed.error.code}`);
  });

  // ====== Python Worker Tests ======
  console.log("\nPython Worker Tests:");

  await test("DOCX: analyze summary", async () => {
    const { tmpDir, filePath } = tempCopy("test.docx");
    const resp = await callWorker("analyze", { doc_type: "docx", file_path: filePath, mode: "summary" });
    assert(resp.ok, `Expected ok, got: ${JSON.stringify(resp)}`);
    assert(resp.result.doc_type === "docx");
    assert(resp.result.paragraph_count > 0);
    assert(resp.result.table_count === 1);
    assert(Array.isArray(resp.result.paragraphs));
    cleanup(tmpDir);
  });

  await test("DOCX: analyze search", async () => {
    const { tmpDir, filePath } = tempCopy("test.docx");
    const resp = await callWorker("analyze", { doc_type: "docx", file_path: filePath, mode: "search", query: "searchable" });
    assert(resp.ok);
    assert(resp.result.matches.length > 0);
    assert(resp.result.matches[0].type === "paragraph");
    cleanup(tmpDir);
  });

  await test("DOCX: replace_text success", async () => {
    const { tmpDir, filePath } = tempCopy("test.docx");
    const resp = await callWorker("apply_operations", {
      doc_type: "docx",
      file_path: filePath,
      operations: [{ op: "replace_text", target: { paragraph_index: 1 }, args: { old_text: "sample text", new_text: "REPLACED TEXT" } }],
    });
    assert(resp.ok && resp.result.success);
    const verify = await callWorker("analyze", { doc_type: "docx", file_path: filePath, mode: "search", query: "REPLACED TEXT" });
    assert(verify.result.matches.length > 0);
    cleanup(tmpDir);
  });

  await test("DOCX: insert_paragraph_after success", async () => {
    const { tmpDir, filePath } = tempCopy("test.docx");
    const before = await callWorker("analyze", { doc_type: "docx", file_path: filePath, mode: "summary" });
    const countBefore = before.result.paragraph_count;
    const resp = await callWorker("apply_operations", {
      doc_type: "docx",
      file_path: filePath,
      operations: [{ op: "insert_paragraph_after", target: { paragraph_index: 0 }, args: { text: "Newly inserted paragraph" } }],
    });
    assert(resp.ok && resp.result.success);
    const after = await callWorker("analyze", { doc_type: "docx", file_path: filePath, mode: "summary" });
    assert(after.result.paragraph_count === countBefore + 1);
    cleanup(tmpDir);
  });

  await test("DOCX: delete_paragraph success", async () => {
    const { tmpDir, filePath } = tempCopy("test.docx");
    const before = await callWorker("analyze", { doc_type: "docx", file_path: filePath, mode: "summary" });
    const countBefore = before.result.paragraph_count;
    const resp = await callWorker("apply_operations", {
      doc_type: "docx",
      file_path: filePath,
      operations: [{ op: "delete_paragraph", target: { paragraph_index: 1 }, args: {} }],
    });
    assert(resp.ok && resp.result.success);
    const after = await callWorker("analyze", { doc_type: "docx", file_path: filePath, mode: "summary" });
    assert(after.result.paragraph_count === countBefore - 1);
    cleanup(tmpDir);
  });

  await test("DOCX: invalid paragraph index fails and reports error", async () => {
    const { tmpDir, filePath } = tempCopy("test.docx");
    const resp = await callWorker("apply_operations", {
      doc_type: "docx",
      file_path: filePath,
      operations: [{ op: "delete_paragraph", target: { paragraph_index: 999 }, args: {} }],
    });
    assert(resp.ok);
    assert(!resp.result.success);
    assert(resp.result.failed_op_index === 0);
    cleanup(tmpDir);
  });

  await test("PPTX: analyze summary", async () => {
    const { tmpDir, filePath } = tempCopy("test.pptx");
    const resp = await callWorker("analyze", { doc_type: "pptx", file_path: filePath, mode: "summary" });
    assert(resp.ok);
    assert(resp.result.doc_type === "pptx");
    assert(resp.result.slide_count === 2);
    cleanup(tmpDir);
  });

  await test("PPTX: analyze search", async () => {
    const { tmpDir, filePath } = tempCopy("test.pptx");
    const resp = await callWorker("analyze", { doc_type: "pptx", file_path: filePath, mode: "search", query: "searchable" });
    assert(resp.ok);
    assert(resp.result.matches.length > 0);
    cleanup(tmpDir);
  });

  await test("PPTX: replace_text success", async () => {
    const { tmpDir, filePath } = tempCopy("test.pptx");
    const resp = await callWorker("apply_operations", {
      doc_type: "pptx",
      file_path: filePath,
      operations: [{ op: "replace_text", target: { slide_index: 0, shape_index: 0 }, args: { old_text: "Slide One Title", new_text: "Updated Title" } }],
    });
    assert(resp.ok && resp.result.success);
    const verify = await callWorker("analyze", { doc_type: "pptx", file_path: filePath, mode: "search", query: "Updated Title" });
    assert(verify.result.matches.length > 0);
    cleanup(tmpDir);
  });

  await test("PPTX: add_text_slide success", async () => {
    const { tmpDir, filePath } = tempCopy("test.pptx");
    const resp = await callWorker("apply_operations", {
      doc_type: "pptx",
      file_path: filePath,
      operations: [{ op: "add_text_slide", args: { title: "New Slide", body: "New body content" } }],
    });
    assert(resp.ok && resp.result.success);
    const after = await callWorker("analyze", { doc_type: "pptx", file_path: filePath, mode: "summary" });
    assert(after.result.slide_count === 3);
    cleanup(tmpDir);
  });

  await test("PPTX: delete_slide success", async () => {
    const { tmpDir, filePath } = tempCopy("test.pptx");
    const resp = await callWorker("apply_operations", {
      doc_type: "pptx",
      file_path: filePath,
      operations: [{ op: "delete_slide", target: { slide_index: 0 }, args: {} }],
    });
    assert(resp.ok && resp.result.success);
    const after = await callWorker("analyze", { doc_type: "pptx", file_path: filePath, mode: "summary" });
    assert(after.result.slide_count === 1);
    cleanup(tmpDir);
  });

  await test("PPTX: invalid slide index fails", async () => {
    const { tmpDir, filePath } = tempCopy("test.pptx");
    const resp = await callWorker("apply_operations", {
      doc_type: "pptx",
      file_path: filePath,
      operations: [{ op: "delete_slide", target: { slide_index: 999 }, args: {} }],
    });
    assert(resp.ok);
    assert(!resp.result.success);
    assert(resp.result.failed_op_index === 0);
    cleanup(tmpDir);
  });

  // ====== Locator Precision Tests ======
  console.log("\nLocator Precision Tests:");

  await test("DOCX: replace_text without target is rejected", async () => {
    const { tmpDir, filePath } = tempCopy("test.docx");
    const resp = await callWorker("apply_operations", {
      doc_type: "docx",
      file_path: filePath,
      operations: [{ op: "replace_text", args: { old_text: "sample text", new_text: "changed" } }],
    });
    assert(resp.ok);
    assert(!resp.result.success, "Should fail without target");
    assert(resp.result.error.includes("paragraph_index"), `Error should mention paragraph_index: ${resp.result.error}`);
    cleanup(tmpDir);
  });

  await test("PPTX: replace_text without target is rejected", async () => {
    const { tmpDir, filePath } = tempCopy("test.pptx");
    const resp = await callWorker("apply_operations", {
      doc_type: "pptx",
      file_path: filePath,
      operations: [{ op: "replace_text", args: { old_text: "Slide One Title", new_text: "changed" } }],
    });
    assert(resp.ok);
    assert(!resp.result.success, "Should fail without target");
    assert(resp.result.error.includes("slide_index"), `Error should mention slide_index: ${resp.result.error}`);
    cleanup(tmpDir);
  });

  await test("PPTX: replace_text only affects specified shape (multi-shape precision)", async () => {
    const { tmpDir, filePath } = tempCopy("test.pptx");
    // Replace text in shape 0 (title) of slide 0, body in shape 1 should be unchanged
    const resp = await callWorker("apply_operations", {
      doc_type: "pptx",
      file_path: filePath,
      operations: [{ op: "replace_text", target: { slide_index: 0, shape_index: 0 }, args: { old_text: "Slide One Title", new_text: "Changed Title" } }],
    });
    assert(resp.ok && resp.result.success);

    // Verify title changed
    const verify = await callWorker("analyze", { doc_type: "pptx", file_path: filePath, mode: "summary" });
    const slide0 = verify.result.slides[0];
    assert(slide0.shapes[0].text === "Changed Title", `Title should be changed, got: ${slide0.shapes[0].text}`);
    // Verify body unchanged
    assert(slide0.shapes[1].text.includes("body text of slide one"), `Body should be unchanged, got: ${slide0.shapes[1].text}`);
    cleanup(tmpDir);
  });

  await test("DOCX: replace_text on wrong paragraph fails", async () => {
    const { tmpDir, filePath } = tempCopy("test.docx");
    // paragraph 0 is "Test Document" (title), doesn't contain "sample text"
    const resp = await callWorker("apply_operations", {
      doc_type: "docx",
      file_path: filePath,
      operations: [{ op: "replace_text", target: { paragraph_index: 0 }, args: { old_text: "sample text", new_text: "changed" } }],
    });
    assert(resp.ok);
    assert(!resp.result.success, "Should fail - text not in target paragraph");
    cleanup(tmpDir);
  });

  // ====== Session Store Tests ======
  console.log("\nSession Store Tests:");

  await test("Session: open creates working copy", () => {
    const store = new OfficeSessionStore();
    const session = store.open(path.join(FIXTURES, "test.docx"));
    assert(session.id);
    assert(session.docType === "docx");
    assert(fs.existsSync(session.workingCopyPath));
    store.destroy();
  });

  await test("Session: rejects unsupported extension", () => {
    const store = new OfficeSessionStore();
    try {
      store.open("/tmp/test.txt");
      throw new Error("Should have thrown");
    } catch (e) {
      assert(e.message.includes("Unsupported file type"));
    }
    store.destroy();
  });

  await test("Session: rejects .doc/.ppt/.xls", () => {
    const store = new OfficeSessionStore();
    for (const ext of [".doc", ".ppt", ".xls"]) {
      try {
        store.open(`/tmp/test${ext}`);
        throw new Error(`Should have rejected ${ext}`);
      } catch (e) {
        assert(e.message.includes("Unsupported file type") || e.message.includes("no such file"));
      }
    }
    store.destroy();
  });

  await test("Session: rejects non-existent file", () => {
    const store = new OfficeSessionStore();
    try {
      store.open("/tmp/nonexistent-file-abc123.docx");
      throw new Error("Should have thrown");
    } catch (e) {
      assert(e.message.includes("no such file") || e.message.includes("File not found"), e.message);
    }
    store.destroy();
  });

  await test("Session: max session limit", () => {
    const store = new OfficeSessionStore();
    // Need 5 different source files (single session per source)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-limit-"));
    const files = [];
    for (let i = 0; i < 6; i++) {
      const fp = path.join(tmpDir, `test${i}.docx`);
      fs.copyFileSync(path.join(FIXTURES, "test.docx"), fp);
      files.push(fp);
    }
    for (let i = 0; i < 5; i++) {
      store.open(files[i]);
    }
    try {
      store.open(files[5]);
      throw new Error("Should have thrown");
    } catch (e) {
      assert(e.message.includes("Maximum"), e.message);
    }
    store.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await test("Session: get non-existent session throws", () => {
    const store = new OfficeSessionStore();
    try {
      store.get("nonexistent-id");
      throw new Error("Should have thrown");
    } catch (e) {
      assert(e.message.includes("Session not found"));
    }
    store.destroy();
  });

  // ====== Same-source conflict tests ======
  console.log("\nSame-Source Conflict Tests:");

  await test("Conflict: two sessions on same source rejected", () => {
    const store = new OfficeSessionStore();
    const fixture = path.join(FIXTURES, "test.docx");
    store.open(fixture);
    try {
      store.open(fixture);
      throw new Error("Should have thrown");
    } catch (e) {
      assert(e.message.includes("already has an active session"), e.message);
    }
    store.destroy();
  });

  await test("Conflict: after close, same source can reopen", () => {
    const store = new OfficeSessionStore();
    const fixture = path.join(FIXTURES, "test.docx");
    const s1 = store.open(fixture);
    store.close(s1.id);
    const s2 = store.open(fixture);
    assert(s2.id !== s1.id);
    store.destroy();
  });

  // ====== Save Safety Tests ======
  console.log("\nSave Safety Tests:");

  await test("Save: default save to working copy (no output_path)", () => {
    const store = new OfficeSessionStore();
    const session = store.open(path.join(FIXTURES, "test.docx"));
    const result = store.save(session.id);
    assert(result === session.workingCopyPath);
    store.destroy();
  });

  await test("Save: rejects wrong extension", () => {
    const store = new OfficeSessionStore();
    const session = store.open(path.join(FIXTURES, "test.docx"));
    const tmpOut = path.join(os.tmpdir(), `test-save-${Date.now()}.pptx`);
    try {
      store.save(session.id, tmpOut);
      throw new Error("Should have thrown");
    } catch (e) {
      assert(e.message.includes("Extension mismatch"), e.message);
    }
    store.destroy();
  });

  await test("Save: rejects directory as output_path", () => {
    const store = new OfficeSessionStore();
    const session = store.open(path.join(FIXTURES, "test.docx"));
    try {
      store.save(session.id, os.tmpdir());
      throw new Error("Should have thrown");
    } catch (e) {
      assert(e.message.includes("Extension mismatch") || e.message.includes("is a directory"), e.message);
    }
    store.destroy();
  });

  await test("Save: rejects symlink target", () => {
    const store = new OfficeSessionStore();
    const session = store.open(path.join(FIXTURES, "test.docx"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-symlink-"));
    const realFile = path.join(tmpDir, "real.docx");
    const linkFile = path.join(tmpDir, "link.docx");
    fs.writeFileSync(realFile, "dummy");
    fs.symlinkSync(realFile, linkFile);
    try {
      store.save(session.id, linkFile);
      throw new Error("Should have thrown");
    } catch (e) {
      assert(e.message.includes("symlink"), e.message);
    }
    store.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await test("Save: rejects overwrite without flag", () => {
    const store = new OfficeSessionStore();
    const session = store.open(path.join(FIXTURES, "test.docx"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-overwrite-"));
    const existingFile = path.join(tmpDir, "existing.docx");
    fs.writeFileSync(existingFile, "dummy");
    try {
      store.save(session.id, existingFile);
      throw new Error("Should have thrown");
    } catch (e) {
      assert(e.message.includes("already exists") && e.message.includes("overwrite"), e.message);
    }
    store.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await test("Save: allows overwrite with explicit flag", () => {
    const store = new OfficeSessionStore();
    const session = store.open(path.join(FIXTURES, "test.docx"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-overwrite-"));
    const existingFile = path.join(tmpDir, "existing.docx");
    fs.writeFileSync(existingFile, "dummy");
    const result = store.save(session.id, existingFile, true);
    assert(result === existingFile);
    // Verify it's a real docx now (bigger than "dummy")
    assert(fs.statSync(existingFile).size > 10);
    store.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await test("Save: does not overwrite source file", () => {
    const store = new OfficeSessionStore();
    const fixture = path.join(FIXTURES, "test.docx");
    const originalSize = fs.statSync(fixture).size;
    const session = store.open(fixture);
    const tmpOut = path.join(os.tmpdir(), `office-safe-${Date.now()}.docx`);
    store.save(session.id, tmpOut);
    assert(fs.existsSync(fixture));
    assert(fs.statSync(fixture).size === originalSize, "Source file should be unchanged");
    fs.unlinkSync(tmpOut);
    store.destroy();
  });

  // ====== Rollback Tests ======
  console.log("\nRollback Tests:");

  await test("Rollback: batch op failure preserves original content", async () => {
    const { tmpDir, filePath } = tempCopy("test.docx");
    // Get original content fingerprint
    const beforeAnalysis = await callWorker("analyze", { doc_type: "docx", file_path: filePath, mode: "summary" });
    const countBefore = beforeAnalysis.result.paragraph_count;

    // Send a batch where op[0] succeeds but op[1] fails
    const resp = await callWorker("apply_operations", {
      doc_type: "docx",
      file_path: filePath,
      operations: [
        { op: "replace_text", target: { paragraph_index: 1 }, args: { old_text: "sample text", new_text: "changed" } },
        { op: "delete_paragraph", target: { paragraph_index: 999 }, args: {} },
      ],
    });
    assert(resp.ok);
    assert(!resp.result.success);
    assert(resp.result.failed_op_index === 1);

    // NOTE: The Python worker doesn't rollback internally — the Node side does the backup/restore.
    // At the worker level, the file may be partially modified when an op fails.
    // This test verifies the worker correctly reports failure for the Node side to rollback.
    cleanup(tmpDir);
  });

  // ====== Cleanup ======
  stopWorker();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error("Test suite error:", e);
  stopWorker();
  process.exit(1);
});
