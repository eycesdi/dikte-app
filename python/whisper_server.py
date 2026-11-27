"""Yerel Whisper sunucusu (faster-whisper).

Electron ana sürecinden stdin üzerinden JSON satırları alır, stdout'a JSON satırları yazar.

Giriş:
  {"cmd": "start", "lang": "auto" | "tr" | "en"}
  {"cmd": "audio", "data": "<base64 int16 16kHz mono>"}
  {"cmd": "stop"}
Çıkış:
  {"type": "ready", "device": "cuda", "model": "small"}
  {"type": "partial", "text": "..."}   # şu an söylenen cümlenin anlık hali
  {"type": "commit", "text": "..."}    # bitmiş cümle (artık değişmez)
  {"type": "done"}                     # stop sonrası her şey işlendi

Test: python whisper_server.py --test dosya.wav
"""
import base64
import difflib
import json
import os
import queue
import re
import sys
import threading
import time
import wave

import numpy as np

# --- Windows'ta CUDA DLL'lerini (pip ile kurulan cublas/cudnn) bul ---
if sys.platform == "win32":
    _site = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")   # venv ve paketli Python için aynı düzen
    for _pkg in ("cublas", "cudnn"):
        _bin = os.path.abspath(os.path.join(_site, _pkg, "bin"))
        if os.path.isdir(_bin):
            os.add_dll_directory(_bin)
            os.environ["PATH"] = _bin + os.pathsep + os.environ.get("PATH", "")

from faster_whisper import WhisperModel  # noqa: E402
from faster_whisper.vad import VadOptions, get_speech_timestamps  # noqa: E402

SR = 16000
MODEL_FAST = os.environ.get("DIKTE_MODEL_FAST", "medium")      # canlı (anlık) yazı
MODEL_FINAL = os.environ.get("DIKTE_MODEL_FINAL", "medium")  # cümle bitince son hali
MODEL_NAME = MODEL_FINAL
STEP_SEC = 0.8            # anlık yazı güncelleme aralığı
SILENCE_COMMIT_SEC = 0.8  # bu kadar sessizlik = cümle bitti
MAX_SEGMENT_SEC = 20.0    # çok uzarsa zorla bitir
PREROLL_SEC = 0.5         # konuşma yokken tutulan kuyruk
# Karışık TR/EN için hafif yönlendirme (dili sabitlemez)
PROMPT = None  # yönlendirme metni kısa seslerde sızıntı yaptı, kullanılmıyor


def log(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# ---- Kelime düzeltme: modelin benzer ama yanlış yazdığı kelimeleri listedeki doğrusuna çevirir ----
BASE_VOCAB = [
    "pazartesi", "salı", "çarşamba", "perşembe", "cuma", "cumartesi", "pazar",
    "ocak", "şubat", "mart", "nisan", "mayıs", "haziran", "temmuz", "ağustos", "eylül", "ekim", "kasım", "aralık",
]


def tr_lower(w):
    return w.replace("I", "ı").replace("İ", "i").lower()


def load_vocab():
    words = list(BASE_VOCAB)
    f = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vocabulary.txt")
    try:
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                line = line.split("#")[0].strip()
                if line:
                    words.append(line)
    except OSError:
        pass
    return sorted(set(words), key=tr_lower)


VOCAB = load_vocab()
_VOCAB_LOWER = {tr_lower(v): v for v in VOCAB if " " not in v}
_WORD_RE = re.compile(r"[^\W\d_]+")


def _recase(orig, target):
    if orig.isupper() and len(orig) > 1:
        return target.upper()
    if orig[0].isupper():
        return target[0].upper() + target[1:]
    return target


def fix_text(text):
    def repl(m):
        w = m.group(0)
        lw = tr_lower(w)
        if len(lw) < 4 or lw in _VOCAB_LOWER:
            return w
        best, best_r = None, 0.0
        for v in _VOCAB_LOWER:
            if v[0] != lw[0] or abs(len(v) - len(lw)) > 2:
                continue
            if lw.startswith(v) or v.startswith(lw):   # ek almış hal (pazara, salıya...) dokunma
                continue
            r = difflib.SequenceMatcher(None, lw, v).ratio()
            if r > best_r:
                best, best_r = v, r
        return _recase(w, _VOCAB_LOWER[best]) if best and best_r >= 0.86 else w
    return _WORD_RE.sub(repl, text)


def model_ref(name):
    """Paketli sürümde model, uygulamanın içindeki klasörden yüklenir (internet gerekmez)."""
    d = os.environ.get("DIKTE_MODELS_DIR")
    if d and os.path.isdir(os.path.join(d, name)):
        return os.path.join(d, name)
    return name


def load_model(name=None):
    name = model_ref(name or MODEL_NAME)
    try:
        return WhisperModel(name, device="cuda", compute_type="int8_float16"), "cuda"
    except Exception as e:  # CUDA yoksa CPU'ya düş
        sys.stderr.write(f"CUDA açılamadı ({e}); CPU kullanılacak\n")
        return WhisperModel(name, device="cpu", compute_type="int8"), "cpu"


def normalize(audio):
    """Kısık mikrofon sesini Whisper için yükselt."""
    if audio.size == 0:
        return audio
    peak = float(np.max(np.abs(audio)))
    if peak < 1e-4:
        return audio
    gain = min(12.0, 0.6 / peak)
    return audio * gain if gain > 1.0 else audio


def transcribe(model, audio, lang, final):
    segs, _info = model.transcribe(
        normalize(audio),
        language=None if lang == "auto" else lang,
        beam_size=5 if final else 2,
        # son metinde kötü çıktıyı (tekrar/düşük güven) sıcaklık artırıp yeniden dener
        temperature=(0.0, 0.2, 0.4) if final else 0.0,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        condition_on_previous_text=False,
        initial_prompt=PROMPT,
        vad_filter=False,
        no_speech_threshold=0.5,
        without_timestamps=True,
    )
    return fix_text(" ".join(s.text.strip() for s in segs).strip())


def speech_bounds(audio):
    """(konuşma var mı, son konuşmanın bitişinden bu yana geçen sn)"""
    if audio.size < SR // 4:
        return False, 0.0
    ts = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=300, speech_pad_ms=100))
    if not ts:
        return False, 0.0
    return True, (audio.size - ts[-1]["end"]) / SR


class Dictation:
    def __init__(self, fast, final):
        self.fast = fast
        self.final = final
        self.q = queue.Queue()
        self.lang = "auto"
        self.buf = np.zeros(0, dtype=np.float32)
        self.last_partial = ""
        self.active = False
        self.last_run = 0.0

    def feed(self, msg):
        self.q.put(msg)

    def commit(self, text):
        if text:
            log({"type": "commit", "text": text})
        self.last_partial = ""

    def process(self, final=False):
        has_speech, tail = speech_bounds(self.buf)
        if not has_speech:
            # konuşma yok: sadece kısa bir kuyruk tut, boşuna büyümesin
            keep = int(PREROLL_SEC * SR)
            self.buf = self.buf[-keep:]
            if self.last_partial:
                self.last_partial = ""
                log({"type": "partial", "text": ""})
            return
        ended = tail >= SILENCE_COMMIT_SEC or self.buf.size / SR >= MAX_SEGMENT_SEC or final
        text = transcribe(self.final if ended else self.fast, self.buf, self.lang, final=ended)
        if ended:
            self.commit(text)
            self.buf = np.zeros(0, dtype=np.float32)
            log({"type": "partial", "text": ""})
        elif text != self.last_partial:
            self.last_partial = text
            log({"type": "partial", "text": text})

    def run(self):
        while True:
            try:
                msg = self.q.get(timeout=0.05)
            except queue.Empty:
                msg = None
            while msg is not None:
                c = msg.get("cmd")
                if c == "start":
                    self.lang = msg.get("lang", "auto")
                    self.buf = np.zeros(0, dtype=np.float32)
                    self.last_partial = ""
                    self.active = True
                elif c == "audio" and self.active:
                    pcm = np.frombuffer(base64.b64decode(msg["data"]), dtype=np.int16)
                    self.buf = np.concatenate([self.buf, pcm.astype(np.float32) / 32768.0])
                elif c == "stop" and self.active:
                    self.active = False
                    self.process(final=True)
                    log({"type": "done"})
                try:
                    msg = self.q.get_nowait()
                except queue.Empty:
                    msg = None
            if self.active and time.time() - self.last_run >= STEP_SEC and self.buf.size > SR // 2:
                self.process()
                self.last_run = time.time()


def read_stdin(d):
    for line in sys.stdin:
        line = line.strip()
        if line:
            d.feed(json.loads(line))
    os._exit(0)   # ana uygulama kapandı/çöktü (stdin koptu): artta kalıp ekran kartı belleğini tutma


def test_file(path):
    t0 = time.time()
    model, dev = load_model()
    print(f"model yüklendi: {MODEL_NAME} / {dev} / {time.time() - t0:.1f} sn")
    w = wave.open(path)
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    for lang in ("auto", "tr"):
        t1 = time.time()
        print(f"[{lang}] {transcribe(model, audio, lang, final=True)!r}  ({time.time() - t1:.2f} sn)")


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--test":
        test_file(sys.argv[2])
        sys.exit(0)
    fast, dev = load_model(MODEL_FAST)
    final = fast if MODEL_FINAL == MODEL_FAST else load_model(MODEL_FINAL)[0]   # aynıysa tek model yüklenir
    d = Dictation(fast, final)
    # ısınma: ilk gerçek istekte gecikme olmasın
    for m in ({id(fast): fast, id(final): final}.values()):
        transcribe(m, np.zeros(SR, dtype=np.float32), "auto", final=False)
    log({"type": "ready", "device": dev, "model": MODEL_FAST if fast is final else f"{MODEL_FAST}+{MODEL_FINAL}"})
    threading.Thread(target=read_stdin, args=(d,), daemon=True).start()
    d.run()
