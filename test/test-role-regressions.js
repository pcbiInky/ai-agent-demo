#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const projectRoot = path.join(__dirname, "..");
const dataDir = path.join(projectRoot, "role-system", "data");
const sessionsDir = path.join(dataDir, "sessions");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
    return;
  }

  console.log(`FAIL ${label}`);
  failed += 1;
}

function resetDataDir() {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
}

function writeSession(sessionId, memberIds) {
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify(
      {
        sessionId,
        members: Object.fromEntries(memberIds.map((id) => [id, { providerSessionId: null }])),
        updatedAt: Date.now(),
      },
      null,
      2
    )
  );
}

async function testMentionParsingHonorsSessionMembers() {
  resetDataDir();
  const server = require("../server");
  const roles = server.__test.ensureRoleSystemInitializedForTests();
  const yyfRole = roles.find((role) => role.name === "YYF");
  const fakerRole = roles.find((role) => role.name === "Faker");

  const sessionId = `session-${crypto.randomUUID()}`;
  writeSession(sessionId, [yyfRole.id]);

  const mentions = server.__test.parseMentions("@YYF 你好 @Faker 不该命中", sessionId);
  assert(
    mentions.length === 1 && mentions[0].character === "YYF",
    "parseMentions only returns session members"
  );

  assert(
    server.__test.isMentionAllowedInSession(sessionId, fakerRole.name) === false,
    "non-member role is rejected by session mention guard"
  );
}

async function testFallbackReplyDoesNotDeriveAIMentions() {
  resetDataDir();
  delete require.cache[require.resolve("../role-system/roles")];
  delete require.cache[require.resolve("../role-system/migrations")];
  delete require.cache[require.resolve("../server")];

  const server = require("../server");
  const roles = server.__test.ensureRoleSystemInitializedForTests();
  const yyfRole = roles.find((role) => role.name === "YYF");
  const fakerRole = roles.find((role) => role.name === "Faker");

  const sessionId = `session-${crypto.randomUUID()}`;
  writeSession(sessionId, [yyfRole.id, fakerRole.id]);

  // getFallbackAIMentions 已被移除，非 MCP fallback 路径已清理
  assert(
    typeof server.__test.getFallbackAIMentions === "undefined",
    "getFallbackAIMentions should no longer be exported (old fallback removed)"
  );
}

async function testBuildContextPromptUsesSendMessageSummonRules() {
  resetDataDir();
  delete require.cache[require.resolve("../role-system/roles")];
  delete require.cache[require.resolve("../role-system/migrations")];
  delete require.cache[require.resolve("../server")];

  const server = require("../server");
  const roles = server.__test.ensureRoleSystemInitializedForTests();
  const yyfRole = roles.find((role) => role.name === "YYF");
  const fakerRole = roles.find((role) => role.name === "Faker");

  const sessionId = `session-${crypto.randomUUID()}`;
  writeSession(sessionId, [yyfRole.id, fakerRole.id]);

  const prompt = server.__test.buildContextPrompt(sessionId, "测试", "YYF", { depth: 0, fromCharacter: "Faker" });

  assert(
    prompt.includes("SendMessage 的 atTargets") && !prompt.includes("在回复中使用 @角色名 来召唤他们"),
    "buildContextPrompt uses SendMessage-based summon instructions"
  );
}

async function testRenamePreservesLegacyLookup() {
  resetDataDir();
  delete require.cache[require.resolve("../role-system/roles")];
  delete require.cache[require.resolve("../role-system/migrations")];
  delete require.cache[require.resolve("../server")];

  let server = require("../server");
  let roles = server.__test.ensureRoleSystemInitializedForTests();
  const fakerRole = roles.find((role) => role.name === "Faker");

  await server.__test.roleStore.updateRole(fakerRole.id, { name: "架构师A" });

  delete require.cache[require.resolve("../role-system/roles")];
  delete require.cache[require.resolve("../role-system/migrations")];
  delete require.cache[require.resolve("../server")];

  server = require("../server");

  const renamed = server.__test.getRoleConfig("架构师A");
  const legacy = server.__test.getRoleConfig("Faker");

  assert(Boolean(renamed), "renamed role can still be resolved");
  assert(Boolean(legacy), "legacy role name can still be resolved after restart");
  assert(
    renamed && legacy && renamed.id === legacy.id,
    "legacy role name resolves to the same role id after rename"
  );
}

async function main() {
  process.env.PORT = "0";

  try {
    await testMentionParsingHonorsSessionMembers();
    await testFallbackReplyDoesNotDeriveAIMentions();
    await testBuildContextPromptUsesSendMessageSummonRules();
    await testRenamePreservesLegacyLookup();
  } finally {
    try {
      const server = require("../server");
      server.__test.closeServer();
    } catch {
      // ignore
    }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
