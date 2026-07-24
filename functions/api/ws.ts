import type { Env } from "../_lib/auth";

/**
 * WebSocket entry point for a race room.
 *
 * The room lives in a Durable Object on a separate Worker script that has no
 * public route of its own — it is reachable only through this binding, and this
 * route only runs after `_middleware` has verified the session cookie. So the
 * realtime layer inherits the password gate rather than needing a second one.
 */

/** Room names are the shareable part of an invite link, so keep them tidy. */
function normaliseRoom(raw: string | null): string {
  const cleaned = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return cleaned || "GRAND-PRIX";
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected a websocket upgrade", { status: 426 });
  }
  if (!env.RACE_ROOM) {
    return new Response(
      "RACE_ROOM binding missing: deploy the rooms Worker and bind it to this Pages project",
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const room = normaliseRoom(url.searchParams.get("room"));
  const id = env.RACE_ROOM.idFromName(room);
  const stub = env.RACE_ROOM.get(id);

  // Forward the upgrade, keeping the query the room reads (display name).
  return stub.fetch(new Request(url.toString(), request));
};
