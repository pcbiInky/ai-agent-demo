# WebFetch Public URL Auto-Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically approve WebFetch requests whose HTTP/HTTPS target resolves exclusively to public IP addresses, while retaining manual approval for local, private, reserved, invalid, or credential-bearing targets.

**Architecture:** Add a focused asynchronous URL/DNS policy to `safe-command.js` while preserving the existing synchronous policy API for all current callers. Make the permission endpoint await the new policy, and verify both the pure policy and the HTTP endpoint behavior without making live DNS requests.

**Tech Stack:** Node.js CommonJS, built-in `dns`, `net.BlockList`, Express 5, existing script-style Node tests.

## Global Constraints

- Only public `http:` and `https:` WebFetch URLs are auto-approved.
- Invalid URLs, credential-bearing URLs, explicit local hostnames, DNS failures, empty DNS results, and any target resolving to a non-public IPv4/IPv6 address remain manual-approval requests.
- `SendMessage` and every non-WebFetch tool retain their current approval behavior.
- Automatic approvals remain visible in permission history and SSE events.
- No new npm dependency is introduced.
- Redirect-chain enforcement and DNS-rebinding protection are outside this change; the policy classifies the initial URL only.

---

## File Map

- Modify `safe-command.js`: public IP classification, public WebFetch URL resolution, and asynchronous approval entrypoint.
- Create `test/test-webfetch-auto-approval.js`: deterministic unit coverage with injected DNS resolvers.
- Modify `test/test-safe-command.js`: align five stale Bash approval assertions with the current unconditional Bash policy so the existing policy test remains a usable regression gate.
- Modify `server.js`: await asynchronous approval decisions.
- Modify `test/test-permission-history.js`: endpoint-level WebFetch auto-approval and history coverage.

### Task 1: Public WebFetch approval policy

**Files:**
- Modify: `safe-command.js`
- Create: `test/test-webfetch-auto-approval.js`
- Modify: `test/test-safe-command.js:121-124`

**Interfaces:**
- Produces: `isPublicIpAddress(address: string): boolean`
- Produces: `isPublicWebFetchUrl(rawUrl: string, lookup?: Function): Promise<boolean>`
- Produces: `shouldAutoAllowPermissionAsync(toolName: string, input: object, context?: object, dependencies?: { lookup?: Function }): Promise<boolean>`
- Preserves: `shouldAutoAllowPermission(toolName, input, context): boolean`

- [ ] **Step 1: Add deterministic failing WebFetch policy tests**

Create `test/test-webfetch-auto-approval.js`:

```js
#!/usr/bin/env node

const {
  isPublicIpAddress,
  isPublicWebFetchUrl,
  shouldAutoAllowPermissionAsync,
} = require("../safe-command");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
  } else {
    console.error(`FAIL ${label}`);
    failed += 1;
  }
}

const publicLookup = async () => [
  { address: "93.184.216.34", family: 4 },
  { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
];
const mixedLookup = async () => [
  { address: "93.184.216.34", family: 4 },
  { address: "10.0.0.8", family: 4 },
];
const emptyLookup = async () => [];
const failingLookup = async () => { throw new Error("DNS unavailable"); };

async function main() {
  assert(isPublicIpAddress("93.184.216.34"), "public IPv4 is allowed");
  assert(!isPublicIpAddress("127.0.0.1"), "loopback IPv4 is blocked");
  assert(!isPublicIpAddress("10.0.0.1"), "private IPv4 is blocked");
  assert(!isPublicIpAddress("169.254.1.1"), "link-local IPv4 is blocked");
  assert(isPublicIpAddress("2606:4700:4700::1111"), "public IPv6 is allowed");
  assert(!isPublicIpAddress("::1"), "loopback IPv6 is blocked");
  assert(!isPublicIpAddress("fc00::1"), "unique-local IPv6 is blocked");
  assert(!isPublicIpAddress("::ffff:127.0.0.1"), "mapped IPv4 IPv6 is blocked conservatively");

  assert(await isPublicWebFetchUrl("https://example.com/docs", publicLookup), "public HTTPS domain is allowed");
  assert(await isPublicWebFetchUrl("http://93.184.216.34/", publicLookup), "public IPv4 literal is allowed");
  assert(!await isPublicWebFetchUrl("ftp://example.com/file", publicLookup), "non-HTTP protocol is blocked");
  assert(!await isPublicWebFetchUrl("https://user:secret@example.com/", publicLookup), "credential URL is blocked");
  assert(!await isPublicWebFetchUrl("http://localhost:3000/", publicLookup), "localhost is blocked");
  assert(!await isPublicWebFetchUrl("http://service.internal/", publicLookup), "internal hostname is blocked");
  assert(!await isPublicWebFetchUrl("https://example.com/", mixedLookup), "mixed public/private DNS is blocked");
  assert(!await isPublicWebFetchUrl("https://example.com/", emptyLookup), "empty DNS result is blocked");
  assert(!await isPublicWebFetchUrl("https://example.com/", failingLookup), "DNS failure is blocked");
  assert(!await isPublicWebFetchUrl("not a url", publicLookup), "invalid URL is blocked");

  assert(
    await shouldAutoAllowPermissionAsync("WebFetch", { url: "https://example.com" }, {}, { lookup: publicLookup }),
    "WebFetch uses the async public URL policy"
  );
  assert(
    !await shouldAutoAllowPermissionAsync("WebFetch", { url: "https://example.com" }, {}, { lookup: mixedLookup }),
    "WebFetch stays manual when any DNS answer is private"
  );
  assert(
    await shouldAutoAllowPermissionAsync("Read", { file_path: "/tmp/a" }),
    "non-WebFetch tools preserve the synchronous policy"
  );

  console.log(`Result: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
```

In `test/test-safe-command.js`, change only the five stale Bash policy assertions so they match commit `c0b4149`:

```js
assert(shouldAutoAllowPermission("Bash", { command: "git log | xargs rm" }), "Bash xargs command follows unconditional auto-approval policy");
assert(shouldAutoAllowPermission("Bash", { command: "git log | awk '{print}'" }), "Bash awk command follows unconditional auto-approval policy");
assert(shouldAutoAllowPermission("Bash", { command: "rm -rf /" }), "Bash command follows unconditional auto-approval policy");
assert(
  shouldAutoAllowPermission("Bash", { command: "rg TODO .", cwd: "/tmp/outside" }, { workingDirectory: workdir }) === true,
  "out-of-worktree Bash follows unconditional auto-approval policy"
);
assert(
  shouldAutoAllowPermission("Bash", { command: "cd /tmp/project && rg TODO ." }, { workingDirectory: workdir }) === true,
  "Bash with cd and command chaining follows unconditional auto-approval policy"
);
```

- [ ] **Step 2: Run tests and verify the new policy test fails before implementation**

Run:

```bash
node test/test-safe-command.js
node test/test-webfetch-auto-approval.js
```

Expected: `test-safe-command.js` passes; `test-webfetch-auto-approval.js` fails because the three new exports do not exist.

- [ ] **Step 3: Implement the minimal asynchronous WebFetch policy**

Add built-in imports near the top of `safe-command.js`:

```js
const dns = require("dns");
const net = require("net");
```

Add the public-address policy after the existing command constants:

```js
const NON_PUBLIC_IPS = new net.BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) {
  NON_PUBLIC_IPS.addSubnet(address, prefix, "ipv4");
}

for (const [address, prefix] of [
  ["::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 32], ["2001:2::", 48],
  ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) {
  NON_PUBLIC_IPS.addSubnet(address, prefix, "ipv6");
}

const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function stripIpv6Brackets(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isPublicIpAddress(address) {
  const normalized = stripIpv6Brackets(String(address || "").toLowerCase());
  if (normalized.startsWith("::ffff:")) return false;
  const family = net.isIP(normalized);
  if (family === 4) return !NON_PUBLIC_IPS.check(normalized, "ipv4");
  if (family === 6) return !NON_PUBLIC_IPS.check(normalized, "ipv6");
  return false;
}

function isExplicitLocalHostname(hostname) {
  const normalized = stripIpv6Brackets(String(hostname || "").toLowerCase()).replace(/\.$/, "");
  return normalized === "localhost" || LOCAL_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

async function isPublicWebFetchUrl(rawUrl, lookup = dns.promises.lookup) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!new Set(["http:", "https:"]).has(parsed.protocol)) return false;
  if (parsed.username || parsed.password || isExplicitLocalHostname(parsed.hostname)) return false;

  const hostname = stripIpv6Brackets(parsed.hostname);
  if (net.isIP(hostname)) return isPublicIpAddress(hostname);

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => isPublicIpAddress(address));
  } catch {
    return false;
  }
}
```

Add the asynchronous entrypoint after `shouldAutoAllowPermission()`:

```js
async function shouldAutoAllowPermissionAsync(toolName, input, context = {}, dependencies = {}) {
  if (toolName === "WebFetch") {
    return isPublicWebFetchUrl(input?.url, dependencies.lookup || dns.promises.lookup);
  }
  return shouldAutoAllowPermission(toolName, input, context);
}
```

Export the new interfaces:

```js
  isPublicIpAddress,
  isPublicWebFetchUrl,
  shouldAutoAllowPermissionAsync,
```

- [ ] **Step 4: Run the focused policy tests**

Run:

```bash
node test/test-safe-command.js
node test/test-webfetch-auto-approval.js
```

Expected: both commands exit 0 and report zero failures.

- [ ] **Step 5: Commit the policy and unit tests**

```bash
git add safe-command.js test/test-safe-command.js test/test-webfetch-auto-approval.js
git commit -m "feat: auto approve public WebFetch URLs"
```

### Task 2: Await the policy in the permission endpoint

**Files:**
- Modify: `server.js:157,593-644`
- Modify: `test/test-permission-history.js`

**Interfaces:**
- Consumes: `shouldAutoAllowPermissionAsync(toolName, input, context): Promise<boolean>`
- Preserves: `POST /api/permission-request` response schema and approval-history format.

- [ ] **Step 1: Add a failing endpoint regression test**

Add this function before `main()` in `test/test-permission-history.js`:

```js
async function testPublicWebFetchAutoApproval() {
  const sessionId = `webfetch-auto-${crypto.randomUUID()}`;
  const requestId = `perm-${crypto.randomUUID()}`;
  cleanupLog(sessionId);

  const requestPromise = postJson("/api/permission-request", {
    toolName: "WebFetch",
    toolUseId: requestId,
    input: { url: "https://93.184.216.34/docs", prompt: "summarize" },
    browserSessionId: sessionId,
    character: "YYF",
    timestamp: Date.now(),
  });

  try {
    const result = await Promise.race([
      requestPromise,
      sleep(500).then(() => null),
    ]);

    assert(result?.ok === true, "public WebFetch permission request returns immediately");
    assert(result?.body?.behavior === "allow", "public WebFetch is auto-approved");

    if (!result) {
      await postJson("/api/permission-response", { requestId, behavior: "deny" });
      await requestPromise;
      return;
    }

    const log = readLog(sessionId);
    const entry = log.messages.find((msg) => msg.role === "permission" && msg.requestId === requestId);
    assert(entry?.status === "allow", "public WebFetch auto-approval is persisted");
    assert(entry?.toolName === "WebFetch", "public WebFetch history keeps the tool name");
  } finally {
    cleanupLog(sessionId);
  }
}
```

Call it in `main()` immediately after the existing history test:

```js
await testPermissionRequestsPersistAndUpdateInHistory();
await testPublicWebFetchAutoApproval();
```

- [ ] **Step 2: Run the endpoint test and verify it fails or hangs in the manual path**

Run:

```bash
node test/test-permission-history.js
```

Expected before implementation: the test exits non-zero after the 500 ms race because `server.js` still sends WebFetch through the pending manual-approval path.

- [ ] **Step 3: Await asynchronous auto-approval in `server.js`**

Replace the import:

```js
const { isSafeBashCommand, shouldAutoAllowPermissionAsync } = require("./safe-command");
```

Make the route async and await the policy:

```js
app.post("/api/permission-request", async (req, res) => {
  // existing request parsing and context construction stay unchanged

  if (await shouldAutoAllowPermissionAsync(toolName, input, permContext)) {
    // existing auto-approval persistence, SSE emission, and response stay unchanged
  }

  // existing manual approval path stays unchanged
});
```

- [ ] **Step 4: Run policy and endpoint regression tests**

Run:

```bash
node test/test-webfetch-auto-approval.js
node test/test-safe-command.js
node test/test-permission-history.js
node test/test-send-message.js
```

Expected: all commands exit 0; the permission-history test reports both manual Write history and automatic WebFetch history assertions passing.

- [ ] **Step 5: Commit endpoint integration**

```bash
git add server.js test/test-permission-history.js
git commit -m "fix: auto approve public WebFetch requests"
```

### Task 3: Full regression verification

**Files:**
- No source changes expected.

**Interfaces:**
- Verifies the repository-wide behavior after Tasks 1-2.

- [ ] **Step 1: Run syntax and whitespace checks**

```bash
node --check safe-command.js
node --check server.js
node --check test/test-webfetch-auto-approval.js
git diff --check HEAD~2..HEAD
```

Expected: all commands exit 0 with no syntax or whitespace errors.

- [ ] **Step 2: Run all JavaScript tests**

```bash
for test_file in test/test-*.js; do node "$test_file" || exit 1; done
```

Expected: every test exits 0. If an unrelated pre-existing failure remains, record its exact test and output without changing unrelated source code.

- [ ] **Step 3: Verify the final diff and working-tree boundaries**

```bash
git status --short
git diff --stat HEAD~2..HEAD
git log -3 --oneline
```

Expected: only the two implementation commits and the earlier design commit contain this feature's files; pre-existing user changes remain untouched.
