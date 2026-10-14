// 跨设备访问的令牌门禁（供 server.js 使用）
// 门禁是否启用与监听地址解耦：绑定非回环 HOST（对外暴露）或显式配置 ACCESS_TOKEN
// （典型场景是本机 TLS 反向代理转发到 127.0.0.1 上游）都会启用；两者都没有时
// 保持默认的本机免令牌体验。
// 启用后**不再信任 socket 来源地址**：本机 TLS 反向代理向上游连 127.0.0.1，
// 远端请求在 socket 层与本机请求完全同形，按来源放行等于把接口对公网敞开。
// 本机 permission-server / MCP 回报链路改走受限的内部令牌，且只对固定几条内部路由有效。
const crypto = require("crypto");

const ACCESS_COOKIE = "access_token";
const INTERNAL_HEADER = "x-internal-token";
// 内部令牌只在这些路由生效：审批长轮询、审批结果、工具执行回报、MCP 代发消息、
// WebSearch 内部执行（仍须配合一次性审批 requestId，门禁放行不等于已批准）。
// 会话历史、会话列表、SSE 与页面永远只认 ACCESS_TOKEN，内部令牌读不到任何聊天内容。
// 这些路由上正确的内部令牌还会豁免 ALLOWED_HOSTS：子进程连的是实际监听地址，
// 其 Host 天然不在面向浏览器的白名单里
const INTERNAL_ROUTES = new Set([
    "/api/permission-request",
    "/api/permission-response",
    "/api/tool-result",
    "/api/mcp-send-message",
    "/api/web-search",
]);

function normalizeAddress(address) {
    if (!address) return "";
    const lower = String(address).toLowerCase();
    // IPv4-mapped IPv6（如 ::ffff:127.0.0.1）按 IPv4 判定
    return lower.startsWith("::ffff:") ? lower.slice(7) : lower;
}

function isLoopbackAddress(address) {
    const value = normalizeAddress(address);
    if (value === "::1" || value === "localhost") return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

function randomToken() {
    return crypto.randomBytes(24).toString("base64url");
}

function isWildcardAddress(address) {
    const value = normalizeAddress(address);
    return value === "" || value === "0.0.0.0" || value === "::" || value === "::0" || value === "*";
}

// 内部回报链路（permission-server / 工具结果回报）必须连"实际监听的那个地址"：
// 绑定 0.0.0.0 / :: 时回环可达，绑定具体网卡地址或 ::1 时 127.0.0.1 会连接失败
function resolveInternalHost(listenHost) {
    const value = typeof listenHost === "string" ? listenHost.trim() : "";
    if (!value || isWildcardAddress(value)) return "127.0.0.1";
    return value;
}

// 门禁启用条件与监听地址解耦：绑定非回环地址（对外暴露）必须启用；
// 显式配置 ACCESS_TOKEN 也启用，即使只监听 127.0.0.1（本机 TLS 反向代理场景）。
// 启用时必须有令牌：未显式配置则生成一次性随机令牌，宁可用户复制一次，
// 也不留下无凭证的对外端口
function resolveAccessToken({ host, envToken, envInternalToken, allowedHosts }) {
    const configured = typeof envToken === "string" ? envToken.trim() : "";
    const hostExposed = !isLoopbackAddress(host);
    if (!hostExposed && !configured) {
        return { enabled: false, hostExposed: false, token: "", generated: false, internalToken: "", allowedHosts: [] };
    }
    const internal = typeof envInternalToken === "string" && envInternalToken.trim() ? envInternalToken.trim() : randomToken();
    return {
        enabled: true,
        hostExposed,
        token: configured || randomToken(),
        generated: !configured,
        internalToken: internal,
        allowedHosts: parseAllowedHosts(allowedHosts),
    };
}

// DNS 重绑定防护：设置 ALLOWED_HOSTS 后只接受这些 Host 头（端口可选）
function parseAllowedHosts(value) {
    if (Array.isArray(value)) return value.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
    if (typeof value !== "string" || !value.trim()) return [];
    return value.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
}

function isHostAllowed(req, allowedHosts) {
    if (!allowedHosts || allowedHosts.length === 0) return true;
    const host = String(req.headers?.host || "").toLowerCase();
    const hostname = host.replace(/:\d+$/, "");
    return allowedHosts.some((entry) => entry === host || entry === hostname);
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

function requestPath(req) {
    const raw = String(req.path || req.url || "/");
    return raw.split("?")[0];
}

function deny(req, res, message) {
    const isApi = requestPath(req).startsWith("/api/");
    res.status(401);
    if (isApi) {
        res.json({ error: message });
        return;
    }
    res.type("text/plain; charset=utf-8").send(message);
}

function createAccessGate(access) {
    const { enabled, token, internalToken, allowedHosts } = access || {};
    return function accessGate(req, res, next) {
        if (!enabled) return next();
        const path = requestPath(req);
        const isInternalRoute = INTERNAL_ROUTES.has(path);
        // 内部回报链路的 Host 是主服务实际监听地址（127.0.0.1:PORT 或具体网卡地址），
        // 不在面向浏览器的 ALLOWED_HOSTS 里；持正确内部令牌即放行，否则开启白名单会让
        // 审批、SendMessage 与执行结果回报全部 403。内部令牌不进入浏览器，
        // 因此这条豁免不削弱 DNS 重绑定防护（没有令牌的请求仍走下面的 Host 校验）
        if (isInternalRoute && tokensEqual(req.headers?.[INTERNAL_HEADER], internalToken)) {
            return next();
        }
        if (!isHostAllowed(req, allowedHosts)) {
            res.status(403);
            return res.type("text/plain; charset=utf-8").send("Host 不在 ALLOWED_HOSTS 允许列表内");
        }
        const provided = extractToken(req);
        if (tokensEqual(provided.token, token)) {
            if (provided.source === "query") {
                // 首次带令牌打开页面后写入 Cookie，静态资源、fetch 与 EventSource 才能一并带上
                if (typeof res.cookie === "function") {
                    res.cookie(ACCESS_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
                } else {
                    res.setHeader("Set-Cookie", `${ACCESS_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/`);
                }
            }
            return next();
        }
        return deny(req, res, isInternalRoute
            ? "需要访问令牌或内部令牌：脚本请用 x-internal-token 请求头，浏览器请用 ?token= / x-access-token / access_token Cookie"
            : "需要访问令牌：请通过 ?token=、x-access-token 请求头或 access_token Cookie 提供");
    };
}

module.exports = {
    ACCESS_COOKIE,
    INTERNAL_HEADER,
    INTERNAL_ROUTES,
    isLoopbackAddress,
    isWildcardAddress,
    resolveInternalHost,
    resolveAccessToken,
    parseAllowedHosts,
    isHostAllowed,
    extractToken,
    tokensEqual,
    createAccessGate,
};
