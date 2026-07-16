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
