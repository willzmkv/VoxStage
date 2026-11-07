from __future__ import annotations

import logging
import os
import re
import sys
import threading
import unicodedata
from pathlib import Path
from typing import Callable, Dict, Any, Optional, List

# Ensure Windows finds local MSVC C++ runtime and ctranslate2 DLLs
if sys.platform == "win32" and hasattr(os, "add_dll_directory"):
    py_dir = Path(sys.executable).parent
    app_dir = Path(__file__).resolve().parent
    for p in [py_dir, py_dir / "Lib" / "site-packages" / "ctranslate2", app_dir, app_dir.parent]:
        if p.is_dir():
            try:
                os.add_dll_directory(str(p))
            except OSError:
                pass

logger = logging.getLogger("whisper_aligner")

_model = None
_model_name = None
_model_lock = threading.Lock()

PT_STOPWORDS = {
    'que', 'de', 'não', 'nao', 'uma', 'para', 'com', 'voce', 'você', 'ele', 'ela',
    'esta', 'está', 'isso', 'esse', 'essa', 'mais', 'por', 'mas', 'como', 'meu',
    'minha', 'seu', 'sua', 'tudo', 'tem', 'sempre', 'quando', 'onde', 'aqui', 'agora',
    'fazer', 'dizer', 'te', 'me', 'se', 'eu', 'nós', 'sou', 'somos', 'são', 'era',
    'tinha', 'tô', 'tá', 'pra', 'pro', 'olhar', 'amor', 'coração', 'coracao', 'vida',
    'dia', 'noite', 'só', 'so'
}

ES_STOPWORDS = {
    'que', 'de', 'no', 'una', 'para', 'con', 'usted', 'él', 'ella', 'está', 'esto',
    'este', 'esta', 'más', 'por', 'pero', 'como', 'mi', 'tu', 'todo', 'tiene',
    'siempre', 'cuando', 'donde', 'aquí', 'ahora', 'hacer', 'decir', 'los', 'las',
    'del', 'al', 'yo', 'nosotros', 'ellos', 'ellas', 'somos', 'son', 'era', 'tenía',
    'corazón', 'amor', 'vida'
}

EN_STOPWORDS = {
    'the', 'and', 'to', 'of', 'a', 'in', 'that', 'have', 'i', 'it', 'for', 'not',
    'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his', 'by',
    'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an', 'will', 'my', 'one',
    'all', 'would', 'there', 'their', 'what', 'so', 'up', 'out', 'if', 'about',
    'who', 'get', 'which', 'go', 'me', 'when', 'make', 'can', 'like', 'time',
    'no', 'just', 'him', 'know', 'take', 'your', 'come', 'dont', 'cant'
}

CONTRACTIONS = {
    'pra': 'para', 'pro': 'para', 'pras': 'para', 'pros': 'para',
    'ta': 'esta', 'to': 'estou', 'ce': 'voce', 'ces': 'voces',
    'num': 'emum', 'numa': 'emuma', 'dum': 'deum', 'duma': 'deuma',
    'gonna': 'goingto', 'wanna': 'wantto', 'cause': 'because', 'cuz': 'because',
    'dont': 'dont', 'cant': 'cant', 'wont': 'wont', 'aint': 'aint'
}


def detect_lyrics_language(text: str) -> Optional[str]:
    tokens = [w.lower() for w in re.findall(r'\b[a-záàâãéèêíïóôõöúçñ]+\b', text.lower())]
    if not tokens:
        return None
    pt_score = sum(1 for w in tokens if w in PT_STOPWORDS)
    es_score = sum(1 for w in tokens if w in ES_STOPWORDS)
    en_score = sum(1 for w in tokens if w in EN_STOPWORDS)

    if any(c in text for c in 'ãõç'):
        pt_score += 6
    if any(c in text for c in 'ñ¿¡'):
        es_score += 6

    scores = [('pt', pt_score), ('es', es_score), ('en', en_score)]
    scores.sort(key=lambda x: x[1], reverse=True)
    best_lang, best_score = scores[0]
    return best_lang if best_score >= 2 else None


def strip_accents(text: str) -> str:
    text = unicodedata.normalize('NFD', text)
    return ''.join(c for c in text if unicodedata.category(c) != 'Mn')


def clean_word(w: str) -> str:
    return re.sub(r'[^a-z0-9]', '', strip_accents(w).lower())


def normalize_token(w: str) -> str:
    cleaned = clean_word(w)
    return CONTRACTIONS.get(cleaned, cleaned)


def lev_dist(s1: str, s2: str) -> int:
    if len(s1) < len(s2):
        return lev_dist(s2, s1)
    if len(s2) == 0:
        return len(s1)
    prev = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        curr = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = prev[j + 1] + 1
            deletions = curr[j] + 1
            substitutions = prev[j] + (c1 != c2)
            curr.append(min(insertions, deletions, substitutions))
        prev = curr
    return prev[-1]


def word_similarity(u: str, w: str) -> float:
    nu, nw = normalize_token(u), normalize_token(w)
    if not nu or not nw:
        return 0.0
    if nu == nw:
        return 1.0

    # Singing verb apocope check (e.g. chorar <-> chora, cantar <-> canta)
    if (nu.endswith('r') and nu[:-1] == nw) or (nw.endswith('r') and nw[:-1] == nu):
        return 0.95
    # Plural check (e.g. olhos <-> olho)
    if (nu.endswith('s') and nu[:-1] == nw) or (nw.endswith('s') and nw[:-1] == nu):
        return 0.95

    # Prefix / stem match for lengthened singing words
    min_len = min(len(nu), len(nw))
    if min_len >= 3 and (nu.startswith(nw) or nw.startswith(nu)):
        return 0.88

    dist = lev_dist(nu, nw)
    max_len = max(len(nu), len(nw))
    ratio = 1.0 - (dist / max_len)
    return ratio if ratio >= 0.60 else 0.0


def align_tokens_dp(user_tokens: List[Dict[str, Any]], whisper_words: List[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
    n = len(user_tokens)
    m = len(whisper_words)
    if n == 0 or m == 0:
        return {}

    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    back = [[0] * (m + 1) for _ in range(n + 1)]

    for i in range(1, n + 1):
        dp[i][0] = dp[i - 1][0] - 0.75
        back[i][0] = 2
    for j in range(1, m + 1):
        dp[0][j] = dp[0][j - 1] - 0.35
        back[0][j] = 3

    for i in range(1, n + 1):
        u_w = user_tokens[i - 1]['clean']
        for j in range(1, m + 1):
            w_w = whisper_words[j - 1]['clean']
            sim = word_similarity(u_w, w_w)
            match_score = (3.5 * sim) if sim >= 0.60 else -2.2

            score_diag = dp[i - 1][j - 1] + match_score
            score_up = dp[i - 1][j] - 0.75
            score_left = dp[i][j - 1] - 0.35

            best = score_diag
            b_dir = 1
            if score_up > best:
                best = score_up
                b_dir = 2
            if score_left > best:
                best = score_left
                b_dir = 3

            dp[i][j] = best
            back[i][j] = b_dir

    matches: Dict[int, Dict[str, Any]] = {}
    i, j = n, m
    while i > 0 and j > 0:
        b_dir = back[i][j]
        if b_dir == 1:
            u_idx = i - 1
            w_idx = j - 1
            sim = word_similarity(user_tokens[u_idx]['clean'], whisper_words[w_idx]['clean'])
            if sim >= 0.60:
                matches[u_idx] = whisper_words[w_idx]
            i -= 1
            j -= 1
        elif b_dir == 2:
            i -= 1
        else:
            j -= 1

    return matches


def refine_onset(audio, rough_start_s: float, sr: int = 16000, search_before_s: float = 0.6, search_after_s: float = 0.15) -> float:
    if audio is None or len(audio) == 0 or rough_start_s <= 0.2:
        return max(0.0, rough_start_s)

    import numpy as np

    start_sample = max(0, int((rough_start_s - search_before_s) * sr))
    end_sample = min(len(audio), int((rough_start_s + search_after_s) * sr))

    if end_sample <= start_sample + 320:
        return rough_start_s

    chunk = audio[start_sample:end_sample]
    frame_len = int(sr * 0.02)  # 20ms
    hop = int(sr * 0.01)        # 10ms

    num_frames = (len(chunk) - frame_len) // hop
    if num_frames < 5:
        return rough_start_s

    rms = np.zeros(num_frames)
    for i in range(num_frames):
        f = chunk[i * hop: i * hop + frame_len]
        rms[i] = np.sqrt(np.mean(f**2))

    pre_frames = max(1, int((search_before_s * 0.45) / 0.01))
    baseline = np.median(rms[:pre_frames])
    peak = np.max(rms)

    if peak <= baseline * 1.6 or peak < 0.008:
        return rough_start_s

    thresh = baseline + (peak - baseline) * 0.22
    rough_frame = min(num_frames - 1, int(search_before_s / 0.01))

    onset_frame = rough_frame
    for i in range(rough_frame, -1, -1):
        if rms[i] < thresh:
            onset_frame = i + 1
            break

    detected_time = (start_sample + onset_frame * hop) / sr
    return round(float(np.clip(detected_time, rough_start_s - search_before_s, rough_start_s + 0.05)), 3)


def estimate_syllables(word: str) -> int:
    clean = re.sub(r'[^a-záàâãéèêíïóôõöúçñ]', '', word.lower())
    if not clean:
        return 1
    matches = re.findall(r'[aeiouyáéíóúãõâêîôûàèìòùäëïöü]+', clean)
    return max(1, len(matches))


def get_whisper_availability_error() -> Optional[str]:
    try:
        import av
    except Exception as e:
        return f"Falha ao carregar biblioteca de áudio 'av': {e}"
    try:
        import numpy
    except Exception as e:
        return f"Falha ao carregar 'numpy': {e}"
    try:
        import ctranslate2
    except Exception as e:
        return f"Falha ao carregar motor de IA 'ctranslate2': {e}"
    try:
        import faster_whisper
    except Exception as e:
        return f"Falha ao carregar 'faster_whisper': {e}"
    return None


def is_whisper_available() -> bool:
    return get_whisper_availability_error() is None


def get_whisper_model():
    global _model, _model_name
    with _model_lock:
        if _model is not None:
            return _model

        avail_err = get_whisper_availability_error()
        if avail_err:
            raise RuntimeError(avail_err)

        from faster_whisper import WhisperModel
        models_dir = Path(__file__).resolve().parent / "models"
        local_base = models_dir / "whisper-base"
        local_tiny = models_dir / "whisper-tiny"

        candidates = []
        if local_base.is_dir() and (local_base / "model.bin").is_file():
            candidates.append((str(local_base), "base (embutido)"))
        if local_tiny.is_dir() and (local_tiny / "model.bin").is_file():
            candidates.append((str(local_tiny), "tiny (embutido)"))

        # On CPU, try compute_type: int8 (fastest & lowest RAM), float32, default
        compute_types = ["int8", "float32", "default"]
        last_error = None

        for path, label in candidates:
            for c_type in compute_types:
                try:
                    logger.info("Tentando carregar Whisper %s [compute_type=%s]...", label, c_type)
                    _model = WhisperModel(
                        path,
                        device="cpu",
                        compute_type=c_type,
                        local_files_only=True
                    )
                    _model_name = f"{label} [{c_type}]"
                    logger.info("Whisper inicializado com sucesso: %s", _model_name)
                    return _model
                except Exception as e:
                    logger.warning("Falha ao inicializar %s (%s): %s", label, c_type, e)
                    last_error = e

        # If bundled folders were not found, try system cache
        if not candidates:
            for size in ["base", "tiny"]:
                for c_type in compute_types:
                    try:
                        _model = WhisperModel(size, device="cpu", compute_type=c_type)
                        _model_name = f"{size} ({c_type})"
                        return _model
                    except Exception as e:
                        last_error = e

        raise RuntimeError(f"Não foi possível inicializar o modelo Whisper: {last_error or 'modelo não encontrado'}")


def decode_audio_16k(audio_path: str | Path):
    import av
    import numpy as np

    container = av.open(str(audio_path))
    try:
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
        samples = []
        for frame in container.decode(audio=0):
            for r_frame in resampler.resample(frame):
                samples.append(r_frame.to_ndarray()[0])
        if not samples:
            raise ValueError("O arquivo de áudio não contém trilha de áudio decodificável.")
        return np.concatenate(samples).astype(np.float32)
    finally:
        container.close()


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
    avail_err = get_whisper_availability_error()
    if avail_err:
        raise RuntimeError(f"Whisper AI indisponível: {avail_err}")

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

    # Detect language from user lyrics to prevent wrong language hallucination on instrumental intros
    detected_lang = detect_lyrics_language(plain_lyrics_text)
    logger.info("Idioma detectado para a letra: %s", detected_lang or "automático")

    # Build rich vocabulary prompt from the first 120 words of the song
    all_words = plain_lyrics_text.split()
    prompt = "Música vocal: " + " ".join(all_words[:120])

    # Extract unique vocabulary for Whisper hotwords
    seen_hotwords = set()
    hotwords_list = []
    for w in all_words:
        cw = clean_word(w)
        if cw and len(cw) >= 3 and cw not in seen_hotwords and cw not in PT_STOPWORDS and cw not in EN_STOPWORDS:
            seen_hotwords.add(cw)
            hotwords_list.append(cw)
            if len(hotwords_list) >= 80:
                break
    hotwords_str = " ".join(hotwords_list) if hotwords_list else None

    notify(40, "Reconhecendo voz e fonemas com Whisper AI...")
    transcribe_kwargs: Dict[str, Any] = {
        "beam_size": 1,
        "word_timestamps": True,
        "condition_on_previous_text": False,
        "vad_filter": True,
        "vad_parameters": dict(
            threshold=0.30,
            min_speech_duration_ms=100,
            min_silence_duration_ms=400,
            speech_pad_ms=400
        ),
        "initial_prompt": prompt
    }
    if detected_lang:
        transcribe_kwargs["language"] = detected_lang
    if hotwords_str:
        transcribe_kwargs["hotwords"] = hotwords_str

    with _model_lock:
        segs, info = model.transcribe(audio, **transcribe_kwargs)
        whisper_segments = list(segs)

    notify(80, "Alinhando versos e palavras com a melodia...")
    whisper_words = []
    for s in whisper_segments:
        for w in (s.words or []):
            word_str = w.word.strip()
            clean = clean_word(word_str)
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
            clean = clean_word(w)
            if clean:
                user_tokens.append({
                    "line_idx": line_idx,
                    "word_pos": w_pos,
                    "raw": w,
                    "clean": clean
                })

    # Global Monotonic Dynamic Programming Alignment (soft phonetic match)
    token_matches = align_tokens_dp(user_tokens, whisper_words)

    line_matches: Dict[int, Dict[int, Dict[str, Any]]] = {i: {} for i in range(len(lines))}
    for u_idx, w_word in token_matches.items():
        l_idx = user_tokens[u_idx]["line_idx"]
        w_pos = user_tokens[u_idx]["word_pos"]
        line_matches[l_idx][w_pos] = w_word

    aligned_lines = []
    last_end = 0.0

    for line_idx, line in enumerate(lines):
        matched_dict = line_matches[line_idx]
        words_in_line = line.split()

        if matched_dict:
            # Find earliest and latest matched words in this line
            sorted_pos = sorted(matched_dict.keys())
            first_pos = sorted_pos[0]
            last_pos = sorted_pos[-1]

            first_w_start = matched_dict[first_pos]["start"]
            last_w_end = matched_dict[last_pos]["end"]

            # If word 0 was missing, back-propagate line start based on missing words count
            if first_pos > 0:
                missing_before = first_pos
                est_start = max(last_end + 0.05, first_w_start - missing_before * 0.38)
                start_t = refine_onset(audio, est_start, search_before_s=0.5, search_after_s=0.15)
            else:
                # Refine acoustic vocal onset for word 0
                start_t = refine_onset(audio, first_w_start, search_before_s=0.5, search_after_s=0.15)

            # If last word in line had missing words after it, forward-propagate line end
            if last_pos < len(words_in_line) - 1:
                missing_after = len(words_in_line) - 1 - last_pos
                end_t = last_w_end + missing_after * 0.38
            else:
                end_t = last_w_end

            if start_t < last_end:
                start_t = last_end + 0.04
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

    # Interpolate timestamps for any line not recognized by Whisper
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

        # Smooth syllable-weighted interpolation for all words in line
        word_syllables = [estimate_syllables(w) for w in words]
        total_syllables = sum(word_syllables)

        prev_w_end = start_s
        for w_pos, w_text in enumerate(words):
            if w_pos in matched_dict:
                w_start = matched_dict[w_pos]["start"]
                w_end = matched_dict[w_pos]["end"]
                # For first word, ensure start snaps to line start onset
                if w_pos == 0:
                    w_start = start_s
                if w_start < prev_w_end:
                    w_start = prev_w_end
                if w_end <= w_start:
                    w_end = w_start + max(0.2, word_syllables[w_pos] * 0.18)
            else:
                next_w_start = end_s
                for n_pos in range(w_pos + 1, len(words)):
                    if n_pos in matched_dict:
                        next_w_start = matched_dict[n_pos]["start"]
                        break

                rem_syllables = sum(word_syllables[k] for k in range(w_pos, len(words)) if k not in matched_dict)
                rem_syllables = max(1, rem_syllables)
                available_time = max(0.2, next_w_start - prev_w_end)
                duration_slice = available_time * (word_syllables[w_pos] / rem_syllables)

                w_start = prev_w_end
                w_end = min(end_s, w_start + duration_slice)
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
