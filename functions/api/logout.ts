import { clearCookie, type Env } from "../_lib/auth";

export const onRequest: PagesFunction<Env> = ({ request }) => {
  const url = new URL(request.url);
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": clearCookie(url),
      "Cache-Control": "no-store",
    },
  });
};
