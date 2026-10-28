import { createFileRoute } from "@tanstack/react-router";

function tile(raw: string | null, zoom: number) {
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (n < 0 || n >= 2 ** zoom) return null;
  return n;
}

export const Route = createFileRoute("/api/elev")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const z = Number(url.searchParams.get("z"));
        if (!Number.isInteger(z) || z < 0 || z > 14) return new Response("Bad zoom", { status: 400 });
        const x = tile(url.searchParams.get("x"), z);
        const y = tile(url.searchParams.get("y"), z);
        if (x == null || y == null) return new Response("Bad tile", { status: 400 });
        const upstream = await fetch(
          `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
          { signal: AbortSignal.timeout(20000) },
        );
        if (!upstream.ok) return new Response("Elevation missing", { status: upstream.status });
        const bytes = await upstream.arrayBuffer();
        return new Response(bytes, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
          },
        });
      },
    },
  },
});
