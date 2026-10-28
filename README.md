# Play Where You Live

Rust Map Maker by Sentinel Super Intelligent Systems.

Type a real place. The app pulls the satellite image and the elevation for that ground, squeezes it into a Rust world from 2000 to 4500 meters, and downloads a `.map` file.

A county or a town uses its real outline. A street address uses the miles control. The satellite picture is the check. The file is the shape of that ground: rivers low, flats walkable, ridges high. Rust paints its own textures on that shape. Trees, stone, and spawn beaches come from the layers in the file. Monuments are not placed yet.

Host the file on a direct link, then on a wipe:

```
+server.levelurl "https://your-host/YourPlace-4000-YYYYMMDD.map"
```

Clear world size and seed. Give every new version a new file name.

Ground data is public elevation tiles and Esri World Imagery. Places come from OpenStreetMap. The first boot on a Rust server is the proof that the file matches that server's build.
