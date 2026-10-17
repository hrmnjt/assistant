"""Generate the application's simple leaf icons without external dependencies."""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def make_icon(size, name):
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            u, v = (x + .5) / size, (y + .5) / size
            # A leaf shape and stem on a full, maskable green background.
            axis = (u - .50 + v - .50) / math.sqrt(2)
            length = (u - .50 - (v - .50)) / math.sqrt(2)
            leaf = (axis / .13) ** 2 + (length / .25) ** 2 < 1
            vein = abs(axis) < .012 and -.29 < length < .20
            color = (237, 242, 223) if leaf or vein else (49, 93, 69)
            pixels.extend(color)
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(pixels))) + chunk(b'IEND', b'')
    (ROOT / 'public' / name).write_bytes(png)


for dimension, filename in [(180, 'apple-touch-icon.png'), (192, 'icon-192.png'), (512, 'icon-512.png')]:
    make_icon(dimension, filename)
