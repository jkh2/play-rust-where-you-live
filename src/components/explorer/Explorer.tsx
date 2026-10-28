import { useEffect, useRef, useState } from "react";
import { ExternalLink, Map as MapIcon, Search } from "lucide-react";
import { fetchRustMap, searchRustMaps, type RustHit, type RustMap } from "@/lib/rustmaps.functions";
import { reliefFromImage } from "@/lib/relief";
import { MapScene, type Probe } from "./MapScene";

const SIZES = [2000, 3000, 3500, 4000, 4500] as const;

function loadImage(url: string) {
  const src = `/api/rustmaps/image?url=${encodeURIComponent(url)}`;
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The map image did not load"));
    img.src = src;
  });
}

function parseQuery(raw: string): { size?: number; seed?: number; id?: string } {
  const text = raw.trim();
  const id = text.match(/rustmaps\.com\/map\/([a-f0-9]{16,})/i);
  if (id) return { id: id[1] };
  const sized = text.match(/(\d{3,5})[_/\s]+(\d{1,10})/);
  if (sized) {
    const a = Number(sized[1]);
    const b = Number(sized[2]);
    if (a >= 1000 && a <= 6000) return { size: a, seed: b };
    if (b >= 1000 && b <= 6000) return { size: b, seed: a };
  }
  return {};
}

export function Explorer() {
  const mountRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MapScene | null>(null);
  const coordRef = useRef<HTMLParagraphElement>(null);
  const compassRef = useRef<HTMLDivElement>(null);
  const [hits, setHits] = useState<RustHit[]>([]);
  const [map, setMap] = useState<RustMap | null>(null);
  const [size, setSize] = useState<number | "any">(3500);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Pulling a live RustMaps chart");
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState(false);
  const [mode, setMode] = useState<"orbit" | "fly">("orbit");
  const [exag, setExag] = useState(1.7);
  const [gridOn, setGridOn] = useState(true);
  const [showSmall, setShowSmall] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    const labels = labelsRef.current;
    if (!mount || !labels) return;
    const scene = new MapScene(
      mount,
      labels,
      (probe: Probe | null) => {
        if (!coordRef.current) return;
        coordRef.current.textContent = probe
          ? `${probe.grid}   E ${Math.round(probe.east)}   N ${Math.round(probe.north)}   ${Math.round(probe.elevation)} m`
          : "Hover the terrain";
      },
      setMode,
    );
    sceneRef.current = scene;
    const onResize = () => scene.resize();
    window.addEventListener("resize", onResize);
    const observer = new ResizeObserver(onResize);
    observer.observe(mount);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const found = await searchRustMaps({ data: { sizeMin: 3500, sizeMax: 3500 } });
        if (cancel) return;
        setHits(found);
        if (found[0]) await openHit(found[0]);
      } catch (err) {
        if (!cancel) setError(err instanceof Error ? err.message : "RustMaps is unreachable");
      }
    })();
    return () => {
      cancel = true;
    };
    // opening chart is defined below and stable enough for first paint
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const scene = sceneRef.current;
      if (scene && compassRef.current) {
        compassRef.current.style.transform = `rotate(${scene.heading()}rad)`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  async function showMap(next: RustMap, preview?: HTMLImageElement) {
    setMap(next);
    setError("");
    setStatus(`Charting ${next.size} / ${next.seed}`);
    const image = preview ?? (await loadImage(next.thumbnailUrl || next.imageUrl));
    const relief = reliefFromImage(image, next.size);
    sceneRef.current?.load({
      size: next.size,
      image,
      relief,
      monuments: next.monuments,
      showSmall,
    });
    sceneRef.current?.setExaggeration(exag);
    setStatus(`${next.size} / ${next.seed}`);
    if (image.src !== next.imageUrl) {
      const full = await loadImage(next.imageUrl);
      const finer = reliefFromImage(full, next.size, 220);
      sceneRef.current?.load(
        {
          size: next.size,
          image: full,
          relief: finer,
          monuments: next.monuments,
          showSmall,
        },
        true,
      );
      sceneRef.current?.setExaggeration(exag);
    }
  }

  async function openHit(hit: RustHit) {
    setBusy(true);
    setSheet(false);
    try {
      const next = await fetchRustMap({ data: { size: hit.size, seed: hit.seed, id: hit.mapId } });
      const thumb = hit.thumbnailUrl ? await loadImage(hit.thumbnailUrl).catch(() => undefined) : undefined;
      await showMap(next, thumb);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load that map");
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(nextSize: number | "any") {
    setSize(nextSize);
    setBusy(true);
    setError("");
    try {
      const found = await searchRustMaps({
        data:
          nextSize === "any"
            ? { sizeMin: 1000, sizeMax: 6000 }
            : { sizeMin: nextSize, sizeMax: nextSize },
      });
      setHits(found);
      if (!found.length) setError("No maps in that size right now");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(false);
    }
  }

  async function pullQuery() {
    const parsed = parseQuery(query);
    if (!parsed.id && (parsed.size == null || parsed.seed == null)) {
      setError("Paste a rustmaps.com link, or size and seed like 3500 12345678");
      return;
    }
    setBusy(true);
    try {
      const next = await fetchRustMap({ data: parsed });
      await showMap(next);
      setSheet(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That map is not on RustMaps yet");
    } finally {
      setBusy(false);
    }
  }

  const largeCount = map?.monuments.filter((m) => m.category === "LargeMonument").length ?? 0;

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-bg text-fg">
      <div ref={mountRef} className="absolute inset-0" />
      <div ref={labelsRef} className="pointer-events-none absolute inset-0 z-10" />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3">
        <div className="pointer-events-auto min-w-0 rounded-lg border border-border bg-bg/80 px-3 py-2 backdrop-blur-md">
          <p className="font-mono text-xs tracking-widest text-primary">RIDGEGLASS</p>
          <h1 className="truncate text-lg font-semibold leading-tight">{status}</h1>
        </div>
        <div className="pointer-events-auto flex rounded-lg border border-border bg-bg/80 p-1 backdrop-blur-md">
          <button
            type="button"
            className={`rounded-md px-3 py-2 text-sm font-medium ${mode === "orbit" ? "bg-primary text-primary-fg" : "text-muted"}`}
            onClick={() => sceneRef.current?.setMode("orbit")}
          >
            Orbit
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-2 text-sm font-medium ${mode === "fly" ? "bg-primary text-primary-fg" : "text-muted"}`}
            onClick={() => sceneRef.current?.setMode("fly")}
          >
            Fly
          </button>
        </div>
      </header>

      <aside
        className={`absolute z-20 flex flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-surface/95 p-3 backdrop-blur-md max-md:inset-x-3 max-md:bottom-16 max-md:max-h-[62vh] md:top-20 md:bottom-24 md:left-3 md:w-80 ${sheet ? "flex" : "hidden md:flex"}`}
      >
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void pullQuery();
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Link, or 3500 1862422565"
            aria-label="RustMaps link or size and seed"
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none placeholder:text-muted"
          />
          <button
            type="submit"
            className="rounded-md bg-primary px-3 py-2 text-primary-fg"
            aria-label="Pull map"
          >
            <Search className="size-4" />
          </button>
        </form>

        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => void runSearch("any")}
            className={`rounded-md px-2 py-1 text-xs ${size === "any" ? "bg-primary text-primary-fg" : "bg-surface-2 text-muted"}`}
          >
            Any
          </button>
          {SIZES.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => void runSearch(n)}
              className={`rounded-md px-2 py-1 text-xs ${size === n ? "bg-primary text-primary-fg" : "bg-surface-2 text-muted"}`}
            >
              {n}
            </button>
          ))}
        </div>

        {error ? <p className="text-sm text-primary">{error}</p> : null}

        <ul className="grid grid-cols-2 gap-2">
          {hits.map((hit) => (
            <li key={hit.mapId || `${hit.size}-${hit.seed}`}>
              <button
                type="button"
                onClick={() => void openHit(hit)}
                className={`w-full overflow-hidden rounded-md border text-left ${map?.id === hit.mapId ? "border-primary" : "border-border"}`}
              >
                {hit.thumbnailUrl ? (
                  <img src={hit.thumbnailUrl} alt="" className="aspect-square w-full object-cover" />
                ) : (
                  <span className="block aspect-square bg-surface-2" />
                )}
                <span className="block px-2 py-1 font-mono text-xs text-muted">
                  {hit.size} / {hit.seed}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <label className="text-xs text-muted">
          Relief {exag.toFixed(1)}×
          <input
            type="range"
            min={0.6}
            max={3.5}
            step={0.1}
            value={exag}
            onChange={(e) => {
              const value = Number(e.target.value);
              setExag(value);
              sceneRef.current?.setExaggeration(value);
            }}
            className="mt-1 w-full accent-primary"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`rounded-md px-3 py-2 text-xs ${gridOn ? "bg-primary text-primary-fg" : "bg-surface-2 text-muted"}`}
            onClick={() => {
              const next = !gridOn;
              setGridOn(next);
              sceneRef.current?.setGrid(next);
            }}
          >
            Grid
          </button>
          <button
            type="button"
            className="rounded-md bg-surface-2 px-3 py-2 text-xs"
            onClick={() => {
              const next = !showSmall;
              setShowSmall(next);
              sceneRef.current?.setShowSmall(next);
            }}
          >
            {showSmall ? "Large monuments" : `All pins (${map?.monuments.length ?? 0})`}
          </button>
        </div>

        <p className="text-xs leading-relaxed text-muted">
          Image and monument spots come from the RustMaps catalog. The height grid is not published, so
          relief is surveyed from the coastline and snow. {largeCount} large monuments are marked.
        </p>
        {map ? (
          <a
            href={map.pageUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary"
          >
            Open on RustMaps <ExternalLink className="size-3.5" />
          </a>
        ) : null}
        {busy ? <p className="font-mono text-xs text-muted">Contacting RustMaps…</p> : null}
      </aside>

      <button
        type="button"
        className="absolute bottom-3 left-3 z-20 inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-3 text-sm font-semibold text-primary-fg md:hidden"
        onClick={() => setSheet((v) => !v)}
      >
        <MapIcon className="size-4" />
        Maps
      </button>

      <div className="pointer-events-none absolute right-3 bottom-3 z-20 flex flex-col items-end gap-2">
        <div
          ref={compassRef}
          className="relative flex size-14 items-center justify-center rounded-full border border-border bg-bg/80"
          aria-hidden
        >
          <span className="absolute top-1 font-mono text-xs text-primary">N</span>
          <span className="size-1 rounded-full bg-primary" />
        </div>
        {map?.thumbnailUrl ? (
          <img
            src={map.thumbnailUrl}
            alt=""
            className="size-28 rounded-md border border-border object-cover md:size-36"
          />
        ) : null}
      </div>

      <p
        ref={coordRef}
        className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-bg/80 px-3 py-2 font-mono text-xs text-fg"
      >
        Hover the terrain
      </p>

      {mode === "fly" ? (
        <p className="pointer-events-none absolute bottom-16 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-bg/80 px-3 py-2 text-center text-xs text-muted">
          Click the map to look. WASD flies. A is left, D is right. Space up, Ctrl down.
        </p>
      ) : null}
    </main>
  );
}
