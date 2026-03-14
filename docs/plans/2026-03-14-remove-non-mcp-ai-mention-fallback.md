# Remove Non-MCP AI Mention Fallback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the legacy behavior where non-MCP assistant reply text can trigger AI-to-AI summons via inline `@角色名`.

**Architecture:** Keep user-authored `@角色名` parsing unchanged in `/api/chat`, but make the non-MCP fallback reply path treat assistant text as plain output only. MCP-driven summons continue to flow exclusively through `SendMessage.atTargets`.

**Tech Stack:** Node.js, Express, existing custom test scripts.

---

### Task 1: Lock the new fallback behavior with a regression test

**Files:**
- Modify: `test/test-role-regressions.js`
- Test: `test/test-role-regressions.js`

**Step 1: Write the failing test**

Add a regression asserting the server exposes a fallback helper and that helper returns `[]` even when assistant reply text contains valid session member mentions.

**Step 2: Run test to verify it fails**

Run: `node test/test-role-regressions.js`
Expected: FAIL because the fallback helper is not exposed yet.

**Step 3: Write minimal implementation**

Add a small server helper used by `processAIChain()` for non-MCP fallback mention extraction and make it always return an empty array.

**Step 4: Run test to verify it passes**

Run: `node test/test-role-regressions.js`
Expected: PASS with the new fallback regression.

### Task 2: Remove legacy fallback parsing from the reply path

**Files:**
- Modify: `server.js`
- Test: `test/test-role-regressions.js`
- Test: `test/test-send-message.js`

**Step 1: Update the non-MCP fallback path**

Make `processAIChain()` stop deriving `aiMentions` from assistant reply text and stop dispatching follow-up invokes from that old path.

**Step 2: Keep MCP summon behavior intact**

Do not change `/api/mcp-send-message`; MCP summons must still come from `atTargets`.

**Step 3: Run targeted tests**

Run:
- `node test/test-role-regressions.js`
- `node test/test-send-message.js`

Expected: both scripts PASS.

### Task 3: Final verification

**Files:**
- Modify: `server.js`
- Test: `test/test-role-regressions.js`
- Test: `test/test-send-message.js`

**Step 1: Sanity check server syntax**

Run: `node --check server.js`
Expected: no output.

**Step 2: Confirm final test set stays green**

Run:
- `node test/test-role-regressions.js`
- `node test/test-send-message.js`

Expected: all PASS with no new failures.
