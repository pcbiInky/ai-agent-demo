// 跨设备访问的令牌门禁（供 server.js 使用）
// 服务默认只监听回环地址；显式设置非回环 HOST 时，同网段设备即可访问
// /api/sessions、/api/history、/api/events，而 chat-logs 的 execution 含完整文件快照，
// 因此非回环模式必须带令牌。回环请求始终放行，本机使用方式不变。
const crypto = require("crypto");

const ACCESS_COOKIE = "access_token";

function normalizeAddress(address) {
    if (!address) return "";
    const lower = String(address).toLowerCase();
    // IPv4-mapped IPv6（如 ::ffff:127.0.0.1）按 IPv4 判定
    return lower.startsWith("::ffff:") ? lower.slice(7) : lower;
}

function isLoopbackAddress(address) {
    const value = normalizeAddress(address);
    if (value === "::1" || value === "localhost") return true;
    const match = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(value);
    return !!match;
}

// 非回环监听必须有令牌：未显式配置 ACCESS_TOKEN 时生成一次性随机令牌，
// 宁可用户需要复制一次，也不留下无鉴权的对外端口
function resolveAccessToken({ host, envToken }) {
    const enabled = !isLoopbackAddress(host);
    const configured = typeof envToken === "string" ? envToken.trim() : "";
    if (!enabled) return { enabled: false, token: "", generated: false };
    if (configured) return { enabled: true, token: configured, generated: false };
    return { enabled: true, token: crypto.randomBytes(24).toString("base64url"), generated: true };
}

function parseCookies(header) {
    const cookies = {};
    if (!header) return cookies;
    for (const part of String(header).split(";")) {
        const index = part.indexOf("=");
        if (index < 1) continue;
        cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return cookies;
}

// 令牌来源优先级：请求头（脚本/API 调用）→ 查询串（首次打开页面）→ Cookie（后续资源与 SSE）
function extractToken(req) {
    const header = req.headers?.["x-access-token"];
    if (typeof header === "string" && header.trim()) return { token: header.trim(), source: "header" };
    const query = req.query?.token ?? new URLSearchParams(req.url?.split("?")[1] ?? "").get("token");
    if (typeof query === "string" && query.trim()) return { token: query.trim(), source: "query" };
    const cookie = parseCookies(req.headers?.cookie)[ACCESS_COOKIE];
    if (cookie) return { token: cookie, source: "cookie" };
    return { token: "", source: null };
}

function tokensEqual(provided, expected) {
    if (typeof provided !== "string" || !provided || typeof expected !== "string" || !expected) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function deny(req, res) {
    const isApi = String(req.path || req.url || "").startsWith("/api/");
    res.status(401);
    if (isApi) {
        res.json({ error: "需要访问令牌：请通过 ?token=、x-access-token 请求头或 access_token Cookie 提供" });
        return;
    }
    res.type("text/plain; charset=utf-8").send("需要访问令牌：请在 URL 后附加 ?token=<ACCESS_TOKEN>");
}

function createAccessGate(access) {
    const { enabled, token } = access || {};
    return function accessGate(req, res, next) {
        if (!enabled) return next();
        if (isLoopbackAddress(req.socket?.remoteAddress ?? req.ip)) return next();
        const provided = extractToken(req);
        if (!tokensEqual(provided.token, token)) return deny(req, res);
        if (provided.source === "query") {
            // 首次带令牌打开页面后写入 Cookie，静态资源、fetch 与 EventSource 才能一并带上
            if (typeof res.cookie === "function") {
                res.cookie(ACCESS_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
            } else {
                res.setHeader("Set-Cookie", `${ACCESS_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/`);
            }
        }
        return next();
    };
}

module.exports = {
    ACCESS_COOKIE,
    isLoopbackAddress,
    resolveAccessToken,
    extractToken,
    tokensEqual,
    createAccessGate,
};
