import { useEffect, useMemo, useRef, useState } from "react";
import { Download, MapPinned, Search } from "lucide-react";
import { searchPlaces, type PlaceHit } from "@/lib/geocode.functions";
import { coverSquare, drawHillshade, milesBox, sampleElevation, spanMiles, type Bounds } from "@/lib/ground";
import { buildRustMap, gridNote, resolutions } from "@/lib/rustmap";
import { PlaceMap } from "./PlaceMap";

const EXAMPLES = ["Conejos County, Colorado", "Astoria, Oregon", "Moab, Utah"];

function formatMb(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Maker() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [place, setPlace] = useState<PlaceHit | null>(null);
  const [miles, setMiles] = useState(8);
  const [worldSize, setWorldSize] = useState(4000);
  const [searching, setSearching] = useState(false);
  const [building, setBuilding] = useState(false);
  const [status, setStatus] = useState("Find a place");
  const [error, setError] = useState("");
  const [file, setFile] = useState<{ name: string; bytes: number } | null>(null);
  const [shade, setShade] = useState<HTMLCanvasElement | null>(null);
  const shadeRef = useRef<HTMLCanvasElement>(null);

  const bounds = useMemo<Bounds | null>(() => {
    if (!place) return null;
    if (place.point) return milesBox(place.lat, place.lon, miles);
    return coverSquare({ west: place.west, south: place.south, east: place.east, north: place.north });
  }, [place, miles]);

  useEffect(() => {
    if (!bounds) return;
    let dead = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const heights = await sampleElevation(bounds, 180);
          if (dead) return;
          const canvas = document.createElement("canvas");
          drawHillshade(canvas, heights, 180);
          setShade(canvas);
        } catch {
          if (!dead) setShade(null);
        }
      })();
    }, 250);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [bounds]);

  useEffect(() => {
    const node = shadeRef.current;
    if (!node || !shade) return;
    node.getContext("2d")?.drawImage(shade, 0, 0, node.width, node.height);
  }, [shade]);

  async function runSearch(text: string) {
    const q = text.trim();
    if (q.length < 2) {
      setError("Type a county, a town, or an address");
      return;
    }
    setSearching(true);
    setError("");
    setFile(null);
    try {
      const found = await searchPlaces({ data: { q } });
      setHits(found);
      if (!found.length) setError("Nothing matched that place");
      else if (found.length === 1) choose(found[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The place search failed");
    } finally {
      setSearching(false);
    }
  }

  function choose(hit: PlaceHit) {
    setPlace(hit);
    setHits([]);
    setQuery(hit.label);
    setFile(null);
    setStatus(hit.name);
    setError("");
  }

  async function build() {
    if (!bounds || !place || building) return;
    setBuilding(true);
    setError("");
    setFile(null);
    try {
      const { mesh } = resolutions(worldSize);
      setStatus("Reading the ground");
      const heights = await sampleElevation(bounds, mesh, setStatus);
      setStatus("Building the map");
      const built = await buildRustMap({
        worldSize,
        northUpMeters: heights,
        place: place.name,
        onProgress: setStatus,
      });
      const url = URL.createObjectURL(built.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = built.filename;
      link.click();
      URL.revokeObjectURL(url);
      setFile({ name: built.filename, bytes: built.bytes });
      setStatus(place.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The map did not build");
      setStatus(place?.name ?? "Find a place");
    } finally {
      setBuilding(false);
    }
  }

  const milesAcross = bounds ? Math.round(spanMiles(bounds)) : null;

  return (
    <main className="relative h-dvh overflow-hidden bg-bg text-fg">
      <PlaceMap bounds={bounds} />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-end p-4">
        <div className="pointer-events-none hidden text-right md:block">
          <p className="font-display text-2xl leading-none text-fg drop-shadow-md">Play Where You Live</p>
          <p className="mt-1 font-mono text-xs tracking-widest text-primary">RUST MAP MAKER</p>
        </div>
      </header>

      <aside className="absolute z-20 flex flex-col gap-4 overflow-y-auto border border-border bg-surface/95 p-4 backdrop-blur-md max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[72dvh] max-md:rounded-t-lg md:top-4 md:bottom-4 md:left-4 md:w-96 md:rounded-lg">
        <div>
          <p className="font-mono text-xs tracking-widest text-primary">SENTINEL SUPER INTELLIGENT SYSTEMS</p>
          <h1 className="font-display text-3xl leading-tight">Play Where You Live</h1>
          <p className="mt-1 text-sm text-muted">A real place, squeezed into a Rust map a server can boot.</p>
        </div>

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch(query);
          }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Conejos County, Colorado"
            aria-label="Place"
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-3 text-sm text-fg outline-none placeholder:text-muted"
          />
          <button
            type="submit"
            aria-label="Find place"
            disabled={searching}
            className="rounded-md bg-primary px-3 py-3 text-primary-fg disabled:opacity-60"
          >
            <Search className="size-4" />
          </button>
        </form>

        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setQuery(example);
                void runSearch(example);
              }}
              className="rounded-full border border-border px-3 py-2 text-xs text-muted"
            >
              {example}
            </button>
          ))}
        </div>

        {hits.length > 1 ? (
          <ul className="flex flex-col gap-1">
            {hits.map((hit) => (
              <li key={hit.label}>
                <button
                  type="button"
                  onClick={() => choose(hit)}
                  className="w-full rounded-md px-2 py-2 text-left text-sm hover:bg-surface-2"
                >
                  {hit.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {error ? <p className="text-sm text-primary">{error}</p> : null}

        <label className="text-sm text-muted">
          Rust world size {worldSize}
          <input
            type="range"
            min={2000}
            max={4500}
            step={100}
            value={worldSize}
            onChange={(event) => setWorldSize(Number(event.target.value))}
            className="mt-2 w-full accent-primary"
          />
          <span className="mt-1 block text-xs">{gridNote(worldSize)}</span>
        </label>

        {place?.point ? (
          <label className="text-sm text-muted">
            Miles around this address, {miles}
            <input
              type="range"
              min={2}
              max={40}
              step={1}
              value={miles}
              onChange={(event) => setMiles(Number(event.target.value))}
              className="mt-2 w-full accent-primary"
            />
          </label>
        ) : null}

        {bounds && milesAcross ? (
          <div className="flex items-center gap-3">
            {shade ? (
              <canvas ref={shadeRef} width={96} height={96} className="size-24 rounded-md border border-border" />
            ) : (
              <div className="flex size-24 items-center justify-center rounded-md border border-border text-muted">
                <MapPinned className="size-5" />
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate font-medium">{place?.name}</p>
              <p className="text-sm text-muted">
                About {milesAcross} miles on a side, into a {worldSize} meter Rust world.
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">
            The satellite is the check. The file is the shape of that ground: rivers low, flats walkable, ridges high.
          </p>
        )}

        <button
          type="button"
          disabled={!bounds || building}
          onClick={() => void build()}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 font-medium text-primary-fg disabled:opacity-50"
        >
          <Download className="size-4" />
          {building ? status : "Build the map"}
        </button>

        {file ? (
          <div className="rounded-md border border-border bg-bg p-3 text-sm">
            <p className="font-medium">{file.name}</p>
            <p className="mt-1 text-muted">{formatMb(file.bytes)} downloaded.</p>
            <p className="mt-3 text-muted">Host the file somewhere that serves it directly. Then on a wipe:</p>
            <p className="mt-2 font-mono text-xs text-fg">+server.levelurl "https://your-host/{file.name}"</p>
            <p className="mt-2 text-muted">Clear world size and seed. Give the next version a new file name.</p>
          </div>
        ) : null}

        <p className="text-xs leading-relaxed text-muted">
          In the game the ground uses Rust's own textures, shaped like this place. Trees, stone, and spawn beaches come
          from the layers in the file. Monuments are not placed yet. The first boot on your server is the proof.
        </p>
      </aside>
    </main>
  );
}
