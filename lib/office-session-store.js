const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { ALLOWED_EXTENSIONS } = require("./office-schemas");

const MAX_SESSIONS = 5;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

class OfficeSessionStore {
  constructor() {
    this._sessions = new Map();
    // Track locked source paths → session_id (single writable session per source)
    this._sourceLocks = new Map();
    this._cleanupTimer = setInterval(() => this._cleanup(), 60_000);
  }

  open(filePath) {
    this._cleanup();

    // Validate extension first (before touching filesystem)
    const ext = path.extname(filePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`Unsupported file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`);
    }

    // Validate file exists and resolve to real path for consistent locking
    let resolvedPath;
    try {
      resolvedPath = fs.realpathSync(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    // Same-source conflict control: only one writable session per source
    if (this._sourceLocks.has(resolvedPath)) {
      const existingId = this._sourceLocks.get(resolvedPath);
      throw new Error(`Source file already has an active session: ${existingId}. Close it first.`);
    }

    // Check session limit
    if (this._sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum ${MAX_SESSIONS} concurrent sessions reached. Close or wait for expiry.`);
    }

    const sessionId = crypto.randomUUID();
    const docType = ext.slice(1); // "docx" or "pptx"

    // Create working copy in temp dir
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-mcp-"));
    const copyName = `working_copy${ext}`;
    const workingCopyPath = path.join(tmpDir, copyName);
    fs.copyFileSync(resolvedPath, workingCopyPath);

    const session = {
      id: sessionId,
      sourcePath: resolvedPath,
      workingCopyPath,
      tmpDir,
      docType,
      dirty: false,
      opLog: [],
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
    };

    this._sessions.set(sessionId, session);
    this._sourceLocks.set(resolvedPath, sessionId);
    return session;
  }

  get(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.lastAccessAt = Date.now();
    return session;
  }

  markDirty(sessionId, ops) {
    const session = this.get(sessionId);
    session.dirty = true;
    session.opLog.push(...ops);
  }

  save(sessionId, outputPath, overwrite = false) {
    const session = this.get(sessionId);

    if (!outputPath) {
      // Save to working copy (already there), just mark clean
      session.dirty = false;
      return session.workingCopyPath;
    }

    // -- Save safety checks --

    // 1. Extension must match doc type
    const expectedExt = "." + session.docType;
    const actualExt = path.extname(outputPath).toLowerCase();
    if (actualExt !== expectedExt) {
      throw new Error(`Extension mismatch: output_path has '${actualExt}', expected '${expectedExt}'`);
    }

    // 2. Reject if target is a directory
    if (fs.existsSync(outputPath)) {
      const stat = fs.lstatSync(outputPath);
      if (stat.isDirectory()) {
        throw new Error(`output_path is a directory: ${outputPath}`);
      }
      // 3. Reject symlink targets
      if (stat.isSymbolicLink()) {
        throw new Error(`output_path is a symlink, refused for safety: ${outputPath}`);
      }
      // 4. Reject overwrite unless explicit
      if (!overwrite) {
        throw new Error(`File already exists: ${outputPath}. Set overwrite=true to replace.`);
      }
    }

    // 5. Atomic write: write to temp file, then rename
    const destDir = path.dirname(outputPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const tmpFile = path.join(destDir, `.office-mcp-save-${crypto.randomUUID()}${expectedExt}`);
    fs.copyFileSync(session.workingCopyPath, tmpFile);
    fs.renameSync(tmpFile, outputPath);

    session.dirty = false;
    return outputPath;
  }

  close(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;
    // Release source lock
    this._sourceLocks.delete(session.sourcePath);
    // Clean up temp files
    try {
      fs.rmSync(session.tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    this._sessions.delete(sessionId);
  }

  _cleanup() {
    const now = Date.now();
    for (const [id, session] of this._sessions) {
      if (now - session.lastAccessAt > SESSION_TTL_MS) {
        this.close(id);
      }
    }
  }

  destroy() {
    clearInterval(this._cleanupTimer);
    for (const id of this._sessions.keys()) {
      this.close(id);
    }
  }
}

module.exports = { OfficeSessionStore };
