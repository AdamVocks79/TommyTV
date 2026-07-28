const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || "http://127.0.0.1:3001";

async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const incomingUrl = new URL(request.url);
  const target = new URL(`/api/${path.join("/")}${incomingUrl.search}`, GAME_SERVICE_URL);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
      redirect: "manual",
    });
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return Response.json(
      { error: "The local TommyTV game service is not running." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
