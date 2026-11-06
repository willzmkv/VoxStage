from __future__ import annotations

import difflib
import logging
import re
import threading
from pathlib import Path
from typing import Callable, Dict, Any, Optional

logger = logging.getLogger("whisper_aligner")

_model = None
_model_lock = threading.Lock()


def is_whisper_available() -> bool:
    try:
        import av
        import numpy
        import faster_whisper
        return True
    except ImportError:
        return False


def get_whisper_model():
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel
            # 'tiny' int8 model is fast (~7s on CPU), light (~39MB), and highly accurate for alignment
            _model = WhisperModel("tiny", device="cpu", compute_type="int8")
        return _model


def decode_audio_16k(audio_path: str | Path):
    import av
    import numpy as np

    container = av.open(str(audio_path))
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
    samples = []
    for frame in container.decode(audio=0):
        for r_frame in resampler.resample(frame):
            samples.append(r_frame.to_ndarray()[0])
    if not samples:
        raise ValueError("O arquivo de áudio não contém trilha de áudio decodificável.")
    return np.concatenate(samples).astype(np.float32)


def fmt_lrc(sec: float) -> str:
    m = int(sec // 60)
    s = int(sec % 60)
    c = int((sec - int(sec)) * 100)
    return f"[{m:02d}:{s:02d}.{c:02d}]"


def align_song_lyrics(
    audio_path: str | Path,
    plain_lyrics_text: str,
    progress_callback: Optional[Callable[[int, str], None]] = None
) -> Dict[str, Any]:
    if not is_whisper_available():
        raise RuntimeError("As bibliotecas de IA (faster-whisper e av) não estão instaladas neste ambiente.")

    if not Path(audio_path).is_file():
        raise FileNotFoundError(f"Arquivo de áudio não encontrado: {audio_path}")

    raw_lines = [l.strip() for l in plain_lyrics_text.splitlines() if l.strip()]
    lines = []
    # Filter structural markers like [Verse 1], [Chorus], etc.
    for l in raw_lines:
        if re.match(r"^\[(verse|chorus|bridge|outro|intro|hook|solo|pre-chorus|instrumental)[^\]]*\]$", l, re.I):
            continue
        lines.append(l)

    if not lines:
        raise ValueError("Nenhum verso de letra válido foi fornecido para sincronização.")

    def notify(pct: int, msg: str):
        if progress_callback:
            try:
                progress_callback(pct, msg)
            except Exception:
                pass

    notify(10, "Decodificando áudio da faixa vocal...")
    audio = decode_audio_16k(audio_path)

    notify(25, "Carregando modelo Whisper AI...")
    model = get_whisper_model()

    # Create vocabulary prompt from user lyrics to guide Whisper
    prompt = " ".join(re.findall(r"\w+", plain_lyrics_text)[:50])

    notify(40, "Reconhecendo voz e fonemas com Whisper AI...")
    with _model_lock:
        segs, info = model.transcribe(
            audio,
            initial_prompt=prompt,
            beam_size=1,
            word_timestamps=True,
            condition_on_previous_text=False,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500)
        )
        whisper_segments = list(segs)

    notify(80, "Alinhando versos da letra com a melodia...")
    whisper_words = []
    for s in whisper_segments:
        for w in (s.words or []):
            word_str = w.word.strip()
            clean = re.sub(r"[^\w\s]", "", word_str.lower())
            if clean:
                whisper_words.append({
                    "word": word_str,
                    "clean": clean,
                    "start": float(w.start),
                    "end": float(w.end)
                })

    user_tokens = []
    for line_idx, line in enumerate(lines):
        for w_pos, w in enumerate(line.split()):
            clean = re.sub(r"[^\w\s]", "", w.lower())
            if clean:
                user_tokens.append({
                    "line_idx": line_idx,
                    "word_pos": w_pos,
                    "raw": w,
                    "clean": clean
                })

    user_cleans = [t["clean"] for t in user_tokens]
    whisp_cleans = [w["clean"] for w in whisper_words]

    matcher = difflib.SequenceMatcher(None, user_cleans, whisp_cleans)
    matches = matcher.get_matching_blocks()

    line_matches = {i: [] for i in range(len(lines))}
    for m in matches:
        for offset in range(m.size):
            u_idx = m.a + offset
            w_idx = m.b + offset
            l_idx = user_tokens[u_idx]["line_idx"]
            line_matches[l_idx].append((user_tokens[u_idx], whisper_words[w_idx]))

    aligned = []
    last_end = 0.0

    for line_idx, line in enumerate(lines):
        matched_w = [w for (_, w) in line_matches[line_idx]]
        if matched_w:
            start_t = matched_w[0]["start"]
            end_t = matched_w[-1]["end"]
            if start_t < last_end:
                start_t = last_end + 0.05
            if end_t <= start_t:
                end_t = start_t + 1.2
            last_end = end_t
            aligned.append({
                "line": line,
                "start": start_t,
                "end": end_t,
                "matched_words": line_matches[line_idx]
            })
        else:
            aligned.append({
                "line": line,
                "start": None,
                "end": None,
                "matched_words": []
            })

    # Interpolate timestamps for lines not directly recognized
    for i, item in enumerate(aligned):
        if item["start"] is None:
            prev_end = 0.0
            for p in range(i - 1, -1, -1):
                if aligned[p]["end"] is not None:
                    prev_end = aligned[p]["end"]
                    break
            next_start = prev_end + 4.0
            for n in range(i + 1, len(aligned)):
                if aligned[n]["start"] is not None:
                    next_start = aligned[n]["start"]
                    break

            missing_count = 1
            for n in range(i + 1, len(aligned)):
                if aligned[n]["start"] is None:
                    missing_count += 1
                else:
                    break

            available = max(0.5, next_start - prev_end)
            step = available / (missing_count + 1)
            item["start"] = prev_end + step
            item["end"] = item["start"] + step * 0.9

    lrc_lines = []
    word_timings = {}

    for i, item in enumerate(aligned):
        start_ms = int(item["start"] * 1000)
        end_ms = int(item["end"] * 1000)
        lrc_lines.append(f"{fmt_lrc(item['start'])}{item['line']}")

        words = item["line"].split()
        if not words:
            continue
        line_w_timings = []
        matched_dict = {u["word_pos"]: w for (u, w) in item.get("matched_words", [])}

        duration = max(100, end_ms - start_ms)
        step = duration / len(words)

        for w_pos, word in enumerate(words):
            if w_pos in matched_dict:
                mw = matched_dict[w_pos]
                w_start = int(mw["start"] * 1000)
                w_end = int(mw["end"] * 1000)
                if w_end <= w_start:
                    w_end = w_start + 250
            else:
                w_start = int(start_ms + w_pos * step)
                w_end = int(w_start + step * 0.9)

            line_w_timings.append({
                "word": word,
                "startMs": w_start,
                "endMs": w_end
            })
        word_timings[str(start_ms)] = line_w_timings

    notify(100, "Sincronização concluída com sucesso!")

    return {
        "syncedLyrics": "\n".join(lrc_lines),
        "plainLyrics": "\n".join(lines),
        "wordTimings": word_timings,
        "phrasesCount": len(aligned),
        "provider": "VoxStage · Whisper AI Local"
    }
