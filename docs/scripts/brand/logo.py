"""chant's logo: the pixel face (hair, ringed eyes, open mouth, sound waves).

The grid below is the drawing, one character per art pixel: '#' is ink, '.' is
empty. A pixel change is a one-character edit here, then a re-run of
generate.sh. The output is pure pixel SVG (one rect per run of ink,
shape-rendering="crispEdges", no text, no fonts).

    python3 logo.py <fill> <out.svg>       the logo, one colour
    python3 logo.py --favicon <out.svg>    a square favicon that follows the
                                           browser's light or dark scheme
    python3 logo.py --png <out.png>        a 48 px PNG favicon, light ink on a
                                           dark tile (standard library only)

The site draws the logo with CSS mask-image over a colour token, so the fill
in docs/public/brand/logo.svg only matters to its alpha.
"""
import struct
import sys
import zlib

GRID = """
..##...##...##...##...##..............
.#..#.#..#.#..#.#..#.#..#.............
......................................
.#......................#.............
.#...#####......#####...#.............
.#..#.....#....#.....#..#.............
.#.#..###..#..#..###..#.#.............
.#.#.#####.#..#.#####.#.#.............
.#.#.#####.#..#.#####.#.#.............
.#.#..###..#..#..###..#.#.............
.#..#.....#....#.....#..#.............
.#...#####......#####...#........#....
.#......................#.....#...#...
.#......................#..#...#..#...
.#.........######.......#...#..#..#...
.#........#......#......#...#..#..#...
..#.......#......#.....#....#..#..#...
...###.....######...###....#...#..#...
..............................#...#...
.................................#....
......................................
""".strip().splitlines()
W = max(map(len, GRID))
H = len(GRID)

# The favicon's ink: near-black on a light browser chrome, near-white on dark.
INK_LIGHT = "#0d0f14"
INK_DARK = "#f4f5f8"
TILE = (0x0c, 0x0e, 0x12)
TILE_INK = (0xf4, 0xf5, 0xf8)


def rects():
    out = []
    for y, row in enumerate(GRID):
        x = 0
        while x < len(row):
            if row[x] == "#":
                s = x
                while x < len(row) and row[x] == "#":
                    x += 1
                out.append(f'<rect x="{s}" y="{y}" width="{x - s}" height="1"/>')
            else:
                x += 1
    return "".join(out)


def logo(fill, out):
    with open(out, "w") as f:
        f.write(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 {W + 2} {H + 2}" '
            f'width="{(W + 2) * 10}" height="{(H + 2) * 10}" shape-rendering="crispEdges">'
            f'<g fill="{fill}">{rects()}</g></svg>\n'
        )


def favicon(out):
    # A square box around the art, centred, one pixel of air on each side.
    side = W + 2
    top = -1 - (side - (H + 2)) // 2
    with open(out, "w") as f:
        f.write(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 {top} {side} {side}" '
            f'width="{side * 4}" height="{side * 4}" shape-rendering="crispEdges">'
            f'<style>g{{fill:{INK_LIGHT}}}@media (prefers-color-scheme:dark){{g{{fill:{INK_DARK}}}}}</style>'
            f'<g>{rects()}</g></svg>\n'
        )


def png(out, size=48):
    # One art pixel per image pixel, centred on a dark tile.
    ox = (size - W) // 2
    oy = (size - H) // 2
    raw = b""
    for y in range(size):
        raw += b"\x00"
        for x in range(size):
            gx, gy = x - ox, y - oy
            ink = 0 <= gy < H and 0 <= gx < len(GRID[gy]) and GRID[gy][gx] == "#"
            raw += bytes(TILE_INK if ink else TILE)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    with open(out, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


if __name__ == "__main__":
    if sys.argv[1] == "--favicon":
        favicon(sys.argv[2])
    elif sys.argv[1] == "--png":
        png(sys.argv[2])
    else:
        logo(sys.argv[1], sys.argv[2])
