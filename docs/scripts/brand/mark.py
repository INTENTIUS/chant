"""chant's small mark: the logo's sound waves alone, on a 15x15 grid.

One character per art pixel: '#' is ink, '.' is empty. Edit the grid, then
re-run generate.sh. Pure pixel SVG, shape-rendering="crispEdges".

    python3 mark.py <fill> <out.svg>

The site draws the mark with CSS mask-image over the gold token, so the fill
only matters to its alpha.
"""
import sys

GRID = """
...............
..........#....
...........#...
......#....#...
.......#...#...
..#....#...#...
...#...#...#...
...#...#...#...
...#...#...#...
..#....#...#...
.......#...#...
......#....#...
...........#...
..........#....
...............
""".strip().splitlines()
W = H = 15
assert len(GRID) == H and all(len(r) == W for r in GRID), "the mark is 15x15"


def mark(fill, out):
    rects = []
    for y, row in enumerate(GRID):
        x = 0
        while x < W:
            if row[x] == "#":
                s = x
                while x < W and row[x] == "#":
                    x += 1
                rects.append(f'<rect x="{s}" y="{y}" width="{x - s}" height="1"/>')
            else:
                x += 1
    with open(out, "w") as f:
        f.write(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
            f'shape-rendering="crispEdges"><g fill="{fill}">{"".join(rects)}</g></svg>\n'
        )


if __name__ == "__main__":
    mark(sys.argv[1], sys.argv[2])
