import { createFileRoute } from "@tanstack/react-router";

function allowedImage(raw: string) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.hostname !== "content.rustmaps.com") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/rustmaps/image")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const target = allowedImage(new URL(request.url).searchParams.get("url") ?? "");
        if (!target) return new Response("Bad image", { status: 400 });
        const upstream = await fetch(target, { signal: AbortSignal.timeout(20000) });
        if (!upstream.ok) return new Response("Image missing", { status: upstream.status });
        const bytes = await upstream.arrayBuffer();
        const type = target.endsWith(".webp")
          ? "image/webp"
          : target.endsWith(".jpg") || target.endsWith(".jpeg")
            ? "image/jpeg"
            : "image/png";
        return new Response(bytes, {
          headers: {
            "Content-Type": type,
            "Cache-Control": "public, max-age=86400",
          },
        });
      },
    },
  },
});
