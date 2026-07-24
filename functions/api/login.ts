import { issueToken, sessionCookie, timingSafeEqual, type Env } from "../_lib/auth";
import { gatePage } from "../_lib/gate";

/**
 * Exchange the access key for a signed session cookie.
 *
 * There is no per-IP counter store here, so instead every failure costs a fixed
 * ~400 ms. That is imperceptible to a person typing a password once and turns
 * online guessing into a rate of a couple of attempts per second per
 * connection, which is what actually matters for a shared access key.
 */

const FAILURE_DELAY_MS = 400;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const expected = env.APP_PASSWORD;

  const contentType = request.headers.get("Content-Type") ?? "";
  const wantsJson =
    contentType.includes("application/json") ||
    (request.headers.get("Accept") ?? "").includes("application/json");

  let supplied = "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { password?: unknown };
      supplied = typeof body.password === "string" ? body.password : "";
    } else {
      const form = await request.formData();
      const v = form.get("password");
      supplied = typeof v === "string" ? v : "";
    }
  } catch {
    supplied = "";
  }

  if (!expected) {
    return fail(
      "This deployment has no APP_PASSWORD configured.",
      503,
      wantsJson,
      url,
      true,
    );
  }

  // Compare before sleeping so the delay is the only timing signal.
  if (!timingSafeEqual(supplied, expected)) {
    await sleep(FAILURE_DELAY_MS);
    return fail("Incorrect access key.", 401, wantsJson, url, false);
  }

  const token = await issueToken(expected);
  const headers = new Headers({
    "Set-Cookie": sessionCookie(token, url),
    "Cache-Control": "no-store",
  });
  if (wantsJson) {
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }
  headers.set("Location", "/");
  return new Response(null, { status: 303, headers });
};

/** A bare GET of /api/login just sends you back to the gate. */
export const onRequestGet: PagesFunction<Env> = () =>
  new Response(null, {
    status: 303,
    headers: { Location: "/", "Cache-Control": "no-store" },
  });

function fail(
  message: string,
  status: number,
  wantsJson: boolean,
  _url: URL,
  misconfigured: boolean,
) {
  if (wantsJson) {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new Response(gatePage({ error: message, misconfigured }), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
