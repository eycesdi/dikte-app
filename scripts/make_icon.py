"""assets/tray.png (64 px) ve assets/icon.ico (16-256 px) üretir. Saf Python, ek paket gerekmez."""
import struct, zlib, os

def draw(N, SS=4):
    def px(x, y):
        dx = (x - (N - 1) / 2) / (N / 2); dy = (y - (N - 1) / 2) / (N / 2)
        r = (dx * dx + dy * dy) ** 0.5
        if r > 0.96: return (0, 0, 0, 0)
        if r > 0.86: return (235, 235, 240, 255)   # açık halka
        if r > 0.40: return (24, 24, 28, 255)       # koyu zemin
        return (229, 72, 77, 255)                    # kırmızı kayıt noktası
    rows = []
    for y in range(N):
        row = bytearray([0])
        for x in range(N):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    p = px(x + (sx + .5) / SS - .5, y + (sy + .5) / SS - .5)
                    a = p[3]; acc[0] += p[0] * a; acc[1] += p[1] * a; acc[2] += p[2] * a; acc[3] += a
            n = SS * SS
            row += bytes([round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(acc[3] / n)]) if acc[3] else bytes(4)
        rows.append(bytes(row))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b''))

here = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
os.makedirs(here, exist_ok=True)
open(os.path.join(here, 'tray.png'), 'wb').write(draw(64))
sizes = [16, 32, 48, 64, 128, 256]
imgs = [draw(s) for s in sizes]
ico = struct.pack('<HHH', 0, 1, len(sizes))
off = 6 + 16 * len(sizes)
for s, d in zip(sizes, imgs):
    ico += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(d), off); off += len(d)
open(os.path.join(here, 'icon.ico'), 'wb').write(ico + b''.join(imgs))
print('ok', os.path.getsize(os.path.join(here, 'icon.ico')), 'bytes')
