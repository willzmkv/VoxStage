from __future__ import annotations

import difflib
import logging
import re
import threading
from pathlib import Path
from typing import Callable, Dict, Any, Optional, List

logger = logging.getLogger("whisper_aligner")

_model = None
_model_name = None
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
    global _model, _model_name
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel
            models_dir = Path(__file__).resolve().parent / "models"
            local_base = models_dir / "whisper-base"
            local_tiny = models_dir / "whisper-tiny"

            if local_base.is_dir() and (local_base / "model.bin").is_file():
                _model = WhisperModel(str(local_base), device="cpu", compute_type="int8", local_files_only=True)
                _model_name = "base (bundled)"
            elif local_tiny.is_dir() and (local_tiny / "model.bin").is_file():
                _model = WhisperModel(str(local_tiny), device="cpu", compute_type="int8", local_files_only=True)
                _model_name = "tiny (bundled)"
            else:
                # Try 'base' for superior word boundary resolution; fallback to 'tiny'
                try:
                    _model = WhisperModel("base", device="cpu", compute_type="int8")
                    _model_name = "base"
                except Exception:
                    _model = WhisperModel("tiny", device="cpu", compute_type="int8")
                    _model_name = "tiny"
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
    prompt = " ".join(re.findall(r"\w+", plain_lyrics_text)[:60])

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

    notify(80, "Alinhando versos e palavras com a melodia...")
    whisper_words = []
    for s in whisper_segments:
        for w in (s.words or []):
            word_str = w.word.strip()
            clean = re.sub(r"[^\w\s]", "", word_str.lower())
            if clean and w.end > w.start:
                whisper_words.append({
                    "word": word_str,
                    "clean": clean,
                    "start": round(float(w.start), 3),
                    "end": round(float(w.end), 3)
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

    line_matches = {i: {} for i in range(len(lines))}
    for m in matches:
        for offset in range(m.size):
            u_idx = m.a + offset
            w_idx = m.b + offset
            l_idx = user_tokens[u_idx]["line_idx"]
            w_pos = user_tokens[u_idx]["word_pos"]
            line_matches[l_idx][w_pos] = whisper_words[w_idx]

    aligned_lines = []
    last_end = 0.0

    for line_idx, line in enumerate(lines):
        matched_dict = line_matches[line_idx]
        words_in_line = line.split()
        matched_list = sorted(matched_dict.values(), key=lambda x: x["start"])

        if matched_list:
            start_t = matched_list[0]["start"]
            end_t = matched_list[-1]["end"]
            if start_t < last_end:
                start_t = last_end + 0.05
            if end_t <= start_t:
                end_t = start_t + max(1.0, len(words_in_line) * 0.35)
            last_end = end_t
            aligned_lines.append({
                "line": line,
                "start": start_t,
                "end": end_t,
                "words": words_in_line,
                "matched_dict": matched_dict
            })
        else:
            aligned_lines.append({
                "line": line,
                "start": None,
                "end": None,
                "words": words_in_line,
                "matched_dict": {}
            })

    # Interpolate timestamps for lines not directly recognized
    for i, item in enumerate(aligned_lines):
        if item["start"] is None:
            prev_end = 0.0
            for p in range(i - 1, -1, -1):
                if aligned_lines[p]["end"] is not None:
                    prev_end = aligned_lines[p]["end"]
                    break
            next_start = prev_end + 4.0
            for n in range(i + 1, len(aligned_lines)):
                if aligned_lines[n]["start"] is not None:
                    next_start = aligned_lines[n]["start"]
                    break

            missing_count = 1
            for n in range(i + 1, len(aligned_lines)):
                if aligned_lines[n]["start"] is None:
                    missing_count += 1
                else:
                    break

            available = max(0.5, next_start - prev_end)
            step = available / (missing_count + 1)
            item["start"] = prev_end + step
            item["end"] = item["start"] + step * 0.9

    word_timings_array: List[Dict[str, Any]] = []
    lyric_line_ends: List[int] = []
    lrc_lines: List[str] = []
    lead_voice_rows: List[Dict[str, Any]] = []

    for line_idx, item in enumerate(aligned_lines):
        start_s = item["start"]
        end_s = item["end"]
        start_ms = int(start_s * 1000)
        end_ms = int(end_s * 1000)
        lyric_line_ends.append(end_ms)
        lrc_lines.append(f"{fmt_lrc(start_s)}{item['line']}")

        words = item["words"]
        matched_dict = item["matched_dict"]
        line_word_cues = []

        prev_w_end = start_s
        for w_pos, w_text in enumerate(words):
            if w_pos in matched_dict:
                w_start = matched_dict[w_pos]["start"]
                w_end = matched_dict[w_pos]["end"]
                if w_start < prev_w_end:
                    w_start = prev_w_end
                if w_end <= w_start:
                    w_end = w_start + 0.25
            else:
                next_w_start = end_s
                for n_pos in range(w_pos + 1, len(words)):
                    if n_pos in matched_dict:
                        next_w_start = matched_dict[n_pos]["start"]
                        break

                rem_words = 1
                for n_pos in range(w_pos + 1, len(words)):
                    if n_pos not in matched_dict:
                        rem_words += 1
                    else:
                        break

                duration_slice = max(0.2, (next_w_start - prev_w_end) / rem_words)
                w_start = prev_w_end
                w_end = min(end_s, w_start + duration_slice * 0.95)
                if w_end <= w_start:
                    w_end = w_start + 0.2

            prev_w_end = w_end
            line_word_cues.append({
                "word": w_text,
                "start": round(w_start, 3),
                "end": round(w_end, 3),
                "index": w_pos
            })

        word_timings_array.append({
            "lineIndex": line_idx,
            "words": line_word_cues
        })

        lead_voice_rows.append({
            "id": f"lead-{line_idx}",
            "text": item["line"],
            "time": start_ms,
            "end": end_ms,
            "words": line_word_cues
        })

    notify(100, "Sincronização concluída com sucesso!")

    return {
        "syncedLyrics": "\n".join(lrc_lines),
        "plainLyrics": "\n".join(lines),
        "wordTimings": word_timings_array,
        "lyricLineEnds": lyric_line_ends,
        "lyricVoices": {
            "version": 1,
            "lead": lead_voice_rows,
            "parallel": [],
            "backing": []
        },
        "phrasesCount": len(aligned_lines),
        "provider": "VoxStage · Whisper AI Local"
    }
