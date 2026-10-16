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
    python3 logo.py --og <out.png>         the 1200x630 share card that LinkedIn,
                                           Slack and the rest show for a link
                                           (they take PNG, not SVG)

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


def write_png(out, width, height, pixel):
    # pixel(x, y) gives an (r, g, b) tuple. Standard library only.
    raw = bytearray()
    for y in range(height):
        raw += b"\x00"
        for x in range(width):
            raw += bytes(pixel(x, y))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    with open(out, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))


def ink_at(grid, gx, gy):
    return 0 <= gy < len(grid) and 0 <= gx < len(grid[gy]) and grid[gy][gx] == "#"


def png(out, size=48):
    # One art pixel per image pixel, centred on a dark tile.
    ox = (size - W) // 2
    oy = (size - H) // 2
    write_png(out, size, size, lambda x, y: TILE_INK if ink_at(GRID, x - ox, y - oy) else TILE)


# The share card's wordmark, CHANT in tracked pixel capitals (5x7 each).
LETTERS = {
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "N": ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
}
WORD = ["".join(LETTERS[c][r] + "...." for c in "CHANT")[:-4] for r in range(7)]
# The face ends at column 25; the sound waves to its right take the accent.
WAVES_FROM = 26
ACCENT = (0xa7, 0x8b, 0xfa)
GOLD = (0xc9, 0xa9, 0x6e)


def og(out, width=1200, height=630):
    # The face 12 screen pixels per art pixel, the wordmark at 6, a gold
    # hairline between them. Centred on the face, as the home page is.
    fs, ws = 12, 6
    face_w = WAVES_FROM - 1
    word_w = len(WORD[0])
    gap1, rule_h, gap2 = 48, 2, 40
    block_h = H * fs + gap1 + rule_h + gap2 + 7 * ws
    fx = (width - face_w * fs) // 2
    fy = (height - block_h) // 2
    ry = fy + H * fs + gap1
    wx = (width - word_w * ws) // 2
    wy = ry + rule_h + gap2
    rule_w = 160

    def pixel(x, y):
        gx, gy = (x - fx) // fs, (y - fy) // fs
        if x >= fx and y >= fy and ink_at(GRID, gx, gy):
            return ACCENT if gx >= WAVES_FROM else TILE_INK
        if ry <= y < ry + rule_h and abs(x - width // 2) < rule_w // 2:
            return GOLD
        if x >= wx and y >= wy and ink_at(WORD, (x - wx) // ws, (y - wy) // ws):
            return TILE_INK
        return TILE

    write_png(out, width, height, pixel)


if __name__ == "__main__":
    if sys.argv[1] == "--favicon":
        favicon(sys.argv[2])
    elif sys.argv[1] == "--png":
        png(sys.argv[2])
    elif sys.argv[1] == "--og":
        og(sys.argv[2])
    else:
        logo(sys.argv[1], sys.argv[2])
