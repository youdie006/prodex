#!/usr/bin/env python3
"""Render docs/demo-cli.webp: a narrated recording of the prodex CLI.

Reproducible and headless. Every command and every line of output below was
taken from a real run against a logged-in ChatGPT Pro account (elapsed times
included); the script only re-types them at a readable pace. Frames are drawn
with PIL and assembled by ffmpeg into a looping animated WebP, so the page
shows a terminal that never sits on a real desktop.

    python3 scripts/make-demo.py            # writes docs/demo-cli.webp
    python3 scripts/make-demo.py --gif      # also writes docs/demo-cli.gif

Needs: Pillow, ffmpeg with libwebp_anim, DejaVu Sans Mono.
"""

import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

# --- palette: a dark terminal, red reserved for the prompt ---
BG = (22, 22, 26)
TITLEBAR = (31, 31, 37)
FG = (212, 212, 216)
DIM = (126, 126, 134)
CAPTION = (150, 168, 196)
PROMPT = (196, 40, 40)
WHITE = (238, 238, 242)
GREEN = (140, 190, 140)
YELLOW = (236, 196, 110)

SCALE = 2
FPS = 24
FONT_SIZE = 15 * SCALE
COLS = 86
PAD = 18 * SCALE
TITLE_H = 32 * SCALE

FR = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
font = ImageFont.truetype(FR, FONT_SIZE)
font_b = ImageFont.truetype(FB, FONT_SIZE)
CW = font.getbbox("M")[2]
CH = int(FONT_SIZE * 1.5)
W = PAD * 2 + CW * COLS


def seg(text, color=FG, bold=False):
    return (text, color, bold)


# Each beat: a caption, the command as typed, and the real output that
# followed it. Long outputs are cut with "..." where the recording was cut.
BEATS = [
    {
        "cap": "# ask ChatGPT Pro without leaving the terminal",
        "cmd": (
            'prodex ask --new-chat --effort Pro "A CLI drives a logged-in browser over the Chrome '
            "DevTools Protocol and holds a cross-process file lock while a send is in flight. What "
            "failure modes must the lock's expiry rule handle, and which single rule would you ship? "
            'Under 150 words."'
        ),
        "out": [
            [seg("progress: connecting to browser (port 9333)", DIM)],
            [seg("progress: applying selection (effort=Pro project=set)", DIM)],
            [seg("progress: prompt sent, waiting for answer (budget 20 min)", DIM)],
            [seg("progress: waiting 1m 21s (generating)", DIM)],
            [seg("progress: answer received after 2m 32s (transcript (1235 chars))", DIM)],
            [seg("model_used: ", DIM), seg("gpt-6-pro", GREEN, True)],
            [seg("")],
            [seg("Handle slow legitimate sends, hung or suspended owners, sleep/reboot, clock jumps,")],
            [seg("crashes leaving stale files, PID reuse, incomplete metadata, competing reclaimers,")],
            [seg("...", DIM)],
            [seg("I'd ship: reclaim only a provably dead original owner's lock - never expire a live", WHITE, True)],
            [seg("or unverifiable owner by age.", WHITE, True)],
            [seg("")],
            [seg("saved: ", DIM), seg(".bridge/artifacts/pro-consults/task_20260908_032750_gpt-pro-consult.md", YELLOW)],
        ],
        "hold": 3200,
    },
    {
        "cap": "# the answer is on disk, with a signed receipt - re-print it any time",
        "cmd": "prodex pro latest",
        "out": [
            [seg("task_id: ", DIM), seg("task_20260908_032750_gpt-pro-consult")],
            [seg("status: ", DIM), seg("done", GREEN)],
            [seg("thread: ", DIM), seg("https://chatgpt.com/...")],
            [seg("created_at: ", DIM), seg("2026-09-08T03:30:23.210Z")],
            [seg("")],
            [seg("Handle slow legitimate sends, hung or suspended owners, sleep/reboot, clock jumps,")],
            [seg("...", DIM)],
        ],
        "hold": 2200,
    },
    {
        "cap": "# read the picker your account shows - nothing gets selected",
        "cmd": "prodex pro browser models",
        "out": [
            [seg("Power slider on this account (the slider was walked and put back):", DIM)],
            [seg("  1/5  Latest  -  Instant")],
            [seg("  2/5  Latest  -  Medium")],
            [seg("  3/5  Latest  -  High")],
            [seg("  4/5  Latest  -  Extra High")],
            [seg("* 5/5  6  -  Pro", WHITE, True)],
        ],
        "hold": 2000,
    },
    {
        "cap": "# or let Claude, Codex and other agents ask through MCP",
        "cmd": "prodex claude config --cwd ~/work/api-server",
        "out": [
            [seg('{ "mcpServers": { "prodex": {', DIM)],
            [seg('    "command": "prodex",', DIM)],
            [seg('    "args": ["mcp", "--cwd", "/home/dev/work/api-server"] } } }', DIM)],
        ],
        "hold": 2400,
    },
]


def rows_needed():
    most = 0
    for beat in BEATS:
        cmd_rows = len(wrap_cmd(beat["cmd"]))
        most = max(most, 1 + cmd_rows + len(beat["out"]))
    return most + 1


def wrap_cmd(cmd):
    """The typed command, wrapped at the terminal width like a shell would."""
    width = COLS - 2
    rows, line = [], ""
    for word in cmd.split(" "):
        candidate = word if not line else f"{line} {word}"
        if len(candidate) > width and line:
            rows.append(line)
            line = word
        else:
            line = candidate
    rows.append(line)
    return rows


def base_canvas(H):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, TITLE_H], fill=TITLEBAR)
    r = 5 * SCALE
    for i, c in enumerate([(232, 96, 92), (236, 178, 70), (130, 190, 110)]):
        cx = PAD + i * (r * 2 + 7 * SCALE) + r
        d.ellipse([cx - r, TITLE_H // 2 - r, cx + r, TITLE_H // 2 + r], fill=c)
    label = "prodex"
    lw = font.getbbox(label)[2]
    d.text(((W - lw) // 2, (TITLE_H - FONT_SIZE) // 2 - 2 * SCALE), label, font=font, fill=DIM)
    return img


def draw_screen(H, lines, cursor=None):
    img = base_canvas(H)
    d = ImageDraw.Draw(img)
    y0 = TITLE_H + PAD
    for row, segs in enumerate(lines):
        x = PAD
        y = y0 + row * CH
        for text, color, bold in segs:
            d.text((x, y), text, font=font_b if bold else font, fill=color)
            x += CW * len(text)
    if cursor is not None:
        crow, ccol = cursor
        cx = PAD + ccol * CW
        cy = y0 + crow * CH
        d.rectangle([cx, cy, cx + CW, cy + FONT_SIZE + 2 * SCALE], fill=(190, 190, 198))
    return img


def typed_rows(cmd, upto):
    """Prompt plus the first `upto` characters of the command, wrapped."""
    shown = cmd[:upto]
    rows = wrap_cmd(cmd)
    out, consumed = [], 0
    for i, row in enumerate(rows):
        start = consumed
        consumed += len(row) + 1
        visible = shown[start:start + len(row)]
        if i > 0 and not visible and len(shown) <= start:
            break
        prefix = [seg("$ ", PROMPT, True)] if i == 0 else [seg("  ", FG)]
        out.append(prefix + [seg(visible, WHITE)])
    return out


def build_frames(H):
    """Logical timeline as (image, duration_ms)."""
    frames = []

    def emit(screen, ms, cursor=None):
        frames.append((draw_screen(H, screen, cursor), ms))

    for beat in BEATS:
        cap = beat["cap"]
        for i in range(0, len(cap) + 1, 3):
            emit([[seg(cap[:i], CAPTION)]], 16)
        screen = [[seg(cap, CAPTION)]]
        emit(screen, 320)
        cmd = beat["cmd"]
        for i in range(len(cmd) + 1):
            rows = typed_rows(cmd, i)
            last = rows[-1]
            col = sum(len(t) for t, _, _ in last)
            emit(screen + rows, 38, cursor=(len(rows), col))
        screen = screen + typed_rows(cmd, len(cmd))
        emit(screen, 300)
        for segs in beat["out"]:
            screen = screen + [segs]
            emit(screen, 85)
        emit(screen, beat["hold"])
    return frames


def main():
    want_gif = "--gif" in sys.argv
    if any(isinstance(b["out"], str) for b in BEATS):
        sys.exit("a beat still carries a placeholder instead of recorded output")
    H = TITLE_H + PAD * 2 + CH * rows_needed()
    logical = build_frames(H)
    out_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "docs"))
    tmp = tempfile.mkdtemp(prefix="prodex-demo-")
    try:
        # Unique frames with their own durations go to ffmpeg's concat demuxer,
        # which resamples them to a constant rate: the animated WebP muxer
        # needs equal frame durations, and a variable-rate stream came out with
        # every duration written as zero.
        listing = []
        for i, (img, ms) in enumerate(logical):
            path = os.path.join(tmp, f"{i:05d}.png")
            img.resize((W // 2, H // 2), Image.LANCZOS).save(path)
            listing.append(f"file '{path}'\nduration {ms / 1000:.3f}\n")
        listing.append(f"file '{os.path.join(tmp, f'{len(logical) - 1:05d}.png')}'\n")
        concat = os.path.join(tmp, "frames.txt")
        with open(concat, "w") as f:
            f.write("".join(listing))
        webp = os.path.join(out_dir, "demo-cli.webp")
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat,
             "-r", str(FPS), "-fps_mode", "cfr", "-c:v", "libwebp_anim", "-lossless", "0", "-quality", "82",
             "-compression_level", "6", "-loop", "0", webp],
            check=True,
        )
        total = sum(ms for _, ms in logical) / 1000
        print(f"wrote {webp} ({os.path.getsize(webp) / 1024:.0f} KB, {len(logical)} frames, {total:.1f}s)")
        if want_gif:
            gif = os.path.join(out_dir, "demo-cli.gif")
            subprocess.run(
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat,
                 "-r", str(FPS // 2), "-fps_mode", "cfr",
                 "-vf", "split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=5",
                 "-loop", "0", gif],
                check=True,
            )
            print(f"wrote {gif} ({os.path.getsize(gif) / 1024:.0f} KB)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
