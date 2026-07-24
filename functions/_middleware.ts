import { isAuthed, type Env } from "./_lib/auth";
import { gatePage } from "./_lib/gate";

/**
 * The gate. Runs ahead of every route, including the static assets.
 *
 * Nothing behind the password is served to an unauthenticated request — not the
 * HTML shell, not the JavaScript, not the track data. An unauthorised visitor
 * receives only the self-contained login page, so the app's existence and size
 * are all they can learn.
 */

const PUBLIC_PATHS = new Set(["/api/login", "/api/logout"]);

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env, next } = ctx;
  const url = new URL(request.url);

  if (PUBLIC_PATHS.has(url.pathname)) return next();

  if (await isAuthed(request, env)) {
    const res = await next();
    return withSecurityHeaders(res, url);
  }

  // API routes get a machine-readable refusal; browsers get the gate.
  if (url.pathname.startsWith("/api/")) {
    return json({ error: "unauthorised" }, 401);
  }

  return new Response(gatePage({ misconfigured: !env.APP_PASSWORD }), {
    status: 401,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
};

function withSecurityHeaders(res: Response, url: URL): Response {
  const out = new Response(res.body, res);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("X-Frame-Options", "DENY");
  out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // Everything the game needs is same-origin and self-contained, so the policy
  // can be this tight. `wasm-unsafe-eval` is not needed; three.js is plain JS.
  out.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' ${url.protocol === "https:" ? "wss:" : "ws:"}`,
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  // The gated HTML must never be cached by a shared cache.
  if ((out.headers.get("Content-Type") ?? "").includes("text/html")) {
    out.headers.set("Cache-Control", "no-store");
  }
  return out;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}
