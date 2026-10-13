"""Render a captioned architecture/API walkthrough from recorded real events.
Requires Python 3 with opencv-python and Pillow. No simulated browser footage.
"""
import json
from functools import lru_cache
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / 'artifacts'
capture = json.loads((ART / 'walkthrough-events.json').read_text(encoding='utf-8'))
FONT_DIR = Path('C:/Windows/Fonts')
if not FONT_DIR.exists():
    FONT_DIR = Path('/usr/share/fonts/truetype/dejavu')

@lru_cache(maxsize=32)
def font(size, mono=False, bold=False):
    names = ['consola.ttf', 'DejaVuSansMono.ttf'] if mono else (['segoeuib.ttf', 'DejaVuSans-Bold.ttf'] if bold else ['segoeui.ttf', 'DejaVuSans.ttf'])
    for name in names:
        if (FONT_DIR / name).exists(): return ImageFont.truetype(str(FONT_DIR / name), size)
    return ImageFont.load_default()

def draw_text(draw, xy, text, size=26, color='#232738', bold=False, mono=False):
    draw.text(xy, text, font=font(size, mono, bold), fill=color)

def base(kicker, title, subtitle):
    image = Image.new('RGB', (1600, 900), '#f7f8fb')
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((55, 43, 99, 87), 11, fill='#6658d9')
    for x, y, h in [(65, 61, 16), (76, 52, 25), (87, 57, 15)]:
        draw.rectangle((x, y, x+5, y+h), fill='#ffffff')
    draw_text(draw, (113, 45), 'tradeflow.', 29, bold=True)
    draw_text(draw, (55, 139), kicker, 18, '#8b82ac', bold=True)
    draw_text(draw, (55, 178), title, 44, bold=True)
    draw_text(draw, (57, 245), subtitle, 24, '#818697')
    draw.line((55, 825, 1545, 825), fill='#e5e7ef', width=2)
    draw_text(draw, (55, 850), 'BSE TECHNICAL ASSESSMENT  /  ARCHITECTURE & LIVE API WALKTHROUGH', 16, '#9095a6')
    return image, draw

fps = 12
if capture['delayMs'] != 900000 or capture['connectionLimitMs'] != 30000:
    raise RuntimeError('Record the full 15-minute/30-second assessment before rendering the submission video.')
if capture.get('approach') != 'B':
    raise RuntimeError('Record the current Approach B protocol before rendering; prior prototype recordings are not current evidence.')
writer = cv2.VideoWriter(str(ART / 'walkthrough.mp4'), cv2.VideoWriter_fourcc(*'mp4v'), fps, (1600, 900))
if not writer.isOpened(): raise RuntimeError('MP4 video encoder is unavailable')
completed_seconds = capture['completedElapsedMs'] / 1000 + 1
live_length = 74
duration = 12 + live_length + 12
for frame in range(duration * fps):
    at = frame / fps
    if at < 12:
        im, d = base('01 / THE DESIGN', 'A 15-minute pull. A 30-second connection limit.', 'Accept the request, save the result, then push the update.')
        boxes = [(65, 340, 390, 505, 'Dashboard', 'Empty until download'), (470, 340, 795, 505, 'App + SQLite', 'Job ID + ready report'), (880, 340, 1535, 505, 'Mock BSE exchange', 'POST accepts now; report completes after 900s')]
        for x1, y1, x2, y2, heading, caption in boxes:
            d.rounded_rectangle((x1,y1,x2,y2), 16, fill='#ffffff', outline='#e4e4f0', width=2)
            draw_text(d, (x1+22, y1+29), heading, 28, bold=True)
            draw_text(d, (x1+22, y1+92), caption, 20, '#8b8f9f')
        draw_text(d, (402, 395), '->', 28, '#6658d9', mono=True)
        draw_text(d, (811, 395), '->', 28, '#6658d9', mono=True)
        draw_text(d, (75, 567), 'POST 202 -> job subscription -> completed + download_url -> HTTP download', 27, '#6658d9', bold=True)
        draw_text(d, (75, 637), 'Direct GET: actual socket reset at 30s. Background pull: completion after 15 minutes.', 26, '#71778a')
        draw_text(d, (75, 694), 'Recorded real wall time: no shortened demo, no mocked timers, no fabricated timeout.', 24, '#8b8f9f')
        draw_text(d, (75, 747), 'The mock supports an async handshake; a fixed synchronous API needs an upstream change.', 21, '#8b8f9f')
    elif at < 12 + live_length:
        live_at = at - 12
        elapsed = live_at if live_at <= 35 else (completed_seconds if live_at >= 70 else 35 + (live_at - 35) / 35 * (completed_seconds - 35))
        subtitle = 'First 35 seconds shown in real time: the synchronous connection is actually killed.' if live_at <= 35 else 'Remaining 15-minute recording is compressed for playback; timestamps are actual elapsed time.'
        im, d = base('02 / REAL 15-MINUTE RUN + 30-SECOND TIMEOUT', 'The dashboard stays available while the pull runs.', subtitle)
        d.rounded_rectangle((55, 303, 1545, 703), 16, fill='#202536')
        visible = [e for e in capture['events'] if e['seconds'] <= elapsed][-7:]
        for i, e in enumerate(visible):
            y = 328 + i * 50
            draw_text(d, (77, y), f"{e['seconds']:06.2f}s", 17, '#a5a0e7', mono=True)
            draw_text(d, (184, y), e['label'], 20, '#e7e9f5', mono=True)
            draw_text(d, (570, y), e['detail'], 18, '#aeb8ca', mono=True)
        d.rounded_rectangle((55, 737, 1545, 775), 9, fill='#e7e3f4')
        d.rounded_rectangle((55, 737, 55 + int(1490 * min(1, elapsed / 900)), 775), 9, fill='#8b7fd9')
        label = 'Report completed: small WebSocket notification, then one HTTP download of 2,000 trades.' if elapsed >= capture['completedElapsedMs']/1000 else ('30s timeout observed. The durable 15-minute job keeps processing; no partial data.' if elapsed >= capture['directElapsedMs']/1000 + .1 else 'Initial table empty. The job subscription is waiting for completion metadata.')
        draw_text(d, (65, 786), label, 21, '#6c618e', bold=True)
    else:
        im, d = base('03 / RUN & REVIEW', 'One repository. Two HTTP services. Persistent state.', 'Normal startup always uses at least 15 minutes. The 30-second network cap is enforced.')
        for i, line in enumerate(['npm ci', 'npm start            # actual 15-minute pull', 'npm run test:assessment  # full-duration timing proof', 'npm test             # backend + DOM integration checks']):
            draw_text(d, (80, 335 + i*62), line, 28, '#6256b7', mono=True)
        draw_text(d, (80, 625), 'Click Pull latest trades, then Run 30-second timeout test on the dashboard.', 27, '#626b7d')
        draw_text(d, (80, 686), 'Wait for the completed event; the browser then downloads and renders the report.', 25, '#818697')
        draw_text(d, (80, 748), 'README.md: setup   |   docs/ARCHITECTURE.md: design & limitations', 24, '#9498a7')
    writer.write(cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR))
writer.release()
cap = cv2.VideoCapture(str(ART / 'walkthrough.mp4'))
count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)); cap.release()
if count != duration*fps: raise RuntimeError(f'Unexpected frame count: {count}')
print(f'Created {ART / "walkthrough.mp4"}: {duration}s, {count} frames, 1600x900. Captioned API walkthrough; no audio.')
