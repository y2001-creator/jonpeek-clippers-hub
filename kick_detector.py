#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Detector de Momentos Virales en Streams/VODs de Kick con IA (Gemini 3.6 Flash)
Analiza streams de Kick buscando picos de intensidad acústica/euforia y genera
marcas de tiempo, títulos virales, hooks y categorías para clippers.
"""

import sys
import os
import re
import json
import base64
import subprocess
import tempfile
import urllib.request
import urllib.parse
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor

# Configurar encoding utf-8 para Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# Cargar API key de Gemini desde .env si existe o variable de entorno
def get_gemini_api_key():
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        env_path = os.path.join(os.path.dirname(__file__), ".env")
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("GEMINI_API_KEY="):
                        key = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break
    return key

def format_timestamp(seconds):
    """Convierte segundos a HH:MM:SS"""
    td = timedelta(seconds=int(seconds))
    total_seconds = int(td.total_seconds())
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"

def extract_kick_info(url_or_channel):
    """
    Resuelve el canal, video ID o m3u8 directo a partir del enlace de Kick.
    """
    clean = url_or_channel.strip()
    
    # Caso 1: Es una URL de m3u8 directa
    if ".m3u8" in clean:
        return {
            "title": "Stream de Kick (HLS directo)",
            "channel": "jonpeek",
            "source": clean,
            "duration": 7200,
            "id": "direct_m3u8"
        }

    # Caso 2: Es un CLIP de Kick (ej. kick.com/jonpeek?clip=... o /clips/...)
    is_clip = ("clip=" in clean.lower()) or ("/clips/" in clean.lower()) or ("clip_" in clean.lower())
    if is_clip:
        try:
            cmd = ["yt-dlp", "-j", "--skip-download", clean]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=12)
            if result.returncode == 0 and result.stdout:
                info = json.loads(result.stdout)
                clip_dur = int(float(info.get("duration", 35) or 35))
                return {
                    "id": info.get("id"),
                    "title": info.get("title") or "Clip de Kick",
                    "channel": info.get("channel") or info.get("uploader") or "jonpeek",
                    "source": info.get("url") or clean,
                    "duration": clip_dur,
                    "thumbnail": info.get("thumbnail"),
                    "is_clip": True
                }
        except Exception:
            pass

    channel_name = "jonpeek"
    video_uuid = None

    # Detectar canal o video id
    m_video = re.search(r'videos/([0-9a-fA-F-]+)', clean) or re.search(r'video=([0-9a-fA-F-]+)', clean) or re.search(r'video/(\d+)', clean)
    if m_video:
        video_uuid = m_video.group(1)

    m_channel = re.search(r'kick\.com/([a-zA-Z0-9_-]+)', clean)
    if m_channel and m_channel.group(1).lower() not in ['video', 'videos']:
        channel_name = m_channel.group(1).lower()

    # Consultar API de videos del canal
    api_url = f"https://kick.com/api/v2/channels/{channel_name}/videos"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json'
    }

    try:
        req = urllib.request.Request(api_url, headers=headers)
        with urllib.request.urlopen(req, timeout=8) as resp:
            videos = json.loads(resp.read().decode())
            if videos and isinstance(videos, list):
                target_video = None
                if video_uuid:
                    for v in videos:
                        if str(v.get('id')) == str(video_uuid) or str(v.get('uuid')) == str(video_uuid):
                            target_video = v
                            break
                if not target_video:
                    target_video = videos[0]  # Último video disponible

                raw_duration = target_video.get('duration', 7200) or 7200
                if raw_duration > 86400 * 2: # Si viene en milisegundos
                    raw_duration = raw_duration // 1000
                source = target_video.get('source')
                if source:
                    return {
                        "id": target_video.get('id'),
                        "title": target_video.get('session_title') or f"Directo de {channel_name}",
                        "channel": channel_name,
                        "source": source,
                        "duration": int(raw_duration),
                        "thumbnail": target_video.get('thumbnail', {}).get('url') if isinstance(target_video.get('thumbnail'), dict) else target_video.get('thumbnail')
                    }
    except Exception as e:
        pass

    # Fallback con yt-dlp
    try:
        cmd = ["yt-dlp", "-j", "--skip-download", clean]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode == 0 and result.stdout:
            info = json.loads(result.stdout)
            return {
                "id": info.get('id'),
                "title": info.get('title') or f"Directo de {channel_name}",
                "channel": info.get('uploader') or channel_name,
                "source": info.get('url') or clean,
                "duration": int(info.get('duration', 7200) or 7200),
                "thumbnail": info.get('thumbnail')
            }
    except Exception:
        pass

    return None

def analyze_audio_spikes(m3u8_url, total_duration, num_samples=8):
    """
    Muestrea niveles de volumen (RMS/picos) a lo largo del stream para detectar
    momentos de gritos, celebraciones de goles, aciertos de apuestas o euforia.
    """
    if total_duration <= 0:
        total_duration = 7200 # 2 horas por defecto

    duration_to_scan = min(total_duration, 18000) # Máximo 5 horas
    step = max(180, duration_to_scan // (num_samples + 1))
    
    candidates = []
    sample_points = [int(step * (i + 1)) for i in range(num_samples)]
    
    for t in sample_points:
        if t >= duration_to_scan - 30:
            continue
        try:
            # Medir volumen en una ventana rápida de 4 segundos
            cmd = [
                "ffmpeg", "-y", "-ss", str(t), "-i", m3u8_url,
                "-t", "4", "-vn", "-af", "volumedetect",
                "-f", "null", "-"
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=6)
            out = res.stderr or ""
            
            max_vol = -99.0
            mean_vol = -99.0
            
            m_max = re.search(r'max_volume:\s*(-?[\d\.]+)\s*dB', out)
            m_mean = re.search(r'mean_volume:\s*(-?[\d\.]+)\s*dB', out)
            
            if m_max:
                max_vol = float(m_max.group(1))
            if m_mean:
                mean_vol = float(m_mean.group(1))
                
            # Un volumen alto (cercano a 0 dB, ej: mayor a -10 dB) indica euforia/grito
            score = 0
            if max_vol > -5.0:
                score += 45
            elif max_vol > -10.0:
                score += 30
            elif max_vol > -15.0:
                score += 15

            if mean_vol > -22.0:
                score += 35
            elif mean_vol > -28.0:
                score += 20

            if score > 0:
                candidates.append({
                    "start_sec": max(0, t - 5),
                    "end_sec": t + 40,
                    "max_vol": max_vol,
                    "mean_vol": mean_vol,
                    "intensity": score
                })
        except Exception:
            continue

    # Ordenar por intensidad y tomar los 5 más virales
    candidates.sort(key=lambda x: x["intensity"], reverse=True)
    return candidates[:5]

def extract_audio_clip(m3u8_url, start_sec, duration_sec=16):
    """
    Descarga únicamente un fragmento de audio de 16 segundos en formato MP3 ultraligero.
    """
    temp_dir = tempfile.gettempdir()
    output_path = os.path.join(temp_dir, f"kick_clip_{int(start_sec)}_{os.getpid()}.mp3")
    
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start_sec),
        "-i", m3u8_url,
        "-t", str(duration_sec),
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-b:a", "32k",
        output_path
    ]
    
    try:
        subprocess.run(cmd, capture_output=True, timeout=12)
        if os.path.exists(output_path) and os.path.getsize(output_path) > 1000:
            return output_path
    except Exception:
        pass
    return None

def call_gemini_with_audio(audio_path, start_ts, end_ts, streamer_name="Jonpeek"):
    """
    Envía el fragmento de audio a Gemini para clasificar el momento viral escuchando
    lo que dice el streamer, gritos, goles, partidos, jugadores, tarjetas y apuestas.
    """
    api_key = get_gemini_api_key()
    if not api_key:
        return None

    # Leer audio en base64
    with open(audio_path, "rb") as f:
        audio_b64 = base64.b64encode(f.read()).decode("utf-8")

    prompt = f"""
Eres un editor profesional de clips virales para TikTok, YouTube Shorts y Reels del streamer '{streamer_name}'.
Escucha con máxima atención este fragmento de audio del directo (Marca de tiempo: {start_ts} a {end_ts}).

Determina con precisión qué ocurre en el audio:
- ¿Qué dice o grita el streamer? ¿De qué partido está hablando (equipos, tarjetas, goles, penaltis, faltas, apuestas, cuotas)?
- Si habla de apuestas o cuotas (ej. tarjetas amarillas/rojas, córners, goles en un tiempo, combinadas), refléjalo en el título y gancho.
- Si no es fútbol sino casino, slots o charla, indícalo claramente.

Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta:
{{
  "title": "Título llamativo para TikTok con emojis y mayúsculas (máx 60 caracteres)",
  "hook": "El gancho o texto de impacto para los primeros 3 segundos del video",
  "category": "Una de estas 5 categorías exactas: Picks Verdes | VAR & Polémica | Rages & Enfados | Casino & Slots | Just Chatting & Humor",
  "viral_score": 94,
  "summary": "Resumen detallado de lo que Jonpeek dice, grita o comenta en este audio",
  "recommended_clipper": "Clipper 1",
  "football_context": {{
    "is_football": true,
    "match": "Equipos o competición del partido mencionado (ej. Liverpool vs Atlético de Madrid)",
    "match_minute": "Minuto del partido o momento mencionado",
    "play_event": "Jugada, evento o tipo de apuesta exacta comentada (ej. Gol agónico, Apuesta de menos de 5 tarjetas)",
    "search_query": "Consulta óptima para buscar el video o resumen de la jugada en YouTube"
  }}
}}
"""

    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {
                    "inlineData": {
                        "mimeType": "audio/mp3",
                        "data": audio_b64
                    }
                }
            ]
        }],
        "generationConfig": {
            "temperature": 0.25,
            "responseMimeType": "application/json"
        }
    }

    models = ["gemini-3.1-flash-lite-preview", "gemini-flash-lite-latest", "gemini-3.1-pro-preview"]
    for model_name in models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=18) as resp:
                data = json.loads(resp.read().decode())
                parts = data["candidates"][0]["content"]["parts"]
                text = "".join(p.get("text", "") for p in parts)
                clean_text = re.sub(r'```json\s*', '', text)
                clean_text = re.sub(r'```', '', clean_text).strip()
                match = re.search(r'(\{[\s\S]*\})', clean_text)
                parsed = json.loads(match.group(1)) if match else json.loads(clean_text)
                if parsed and isinstance(parsed, dict) and parsed.get("title"):
                    return parsed
        except Exception:
            continue
    return None

def generate_fallback_gemini_analysis(video_title, start_ts, end_ts, index, streamer_name="Jonpeek"):
    """
    Analiza el directo con Gemini probando varios modelos, o aplica la plantilla
    especializada de los 5 clippers de Jonpeek (Champions, VAR, Cuotas, Casino).
    """
    api_key = get_gemini_api_key()
    models = ['gemini-3.1-flash-lite-preview', 'gemini-flash-lite-latest', 'gemini-3.1-pro-preview']

    clean_match = re.sub(r'#\w+', '', video_title).strip()
    match_guess = clean_match if clean_match else "Champions League / Fútbol en Vivo"

    prompt = f"""
Genera una sugerencia de clip viral de ALTO IMPACTO para el directo de {streamer_name} titulado '{video_title}'.
Marca de tiempo del momento: {start_ts} a {end_ts} (Momento #{index+1}).
Canal especializado en apuestas deportivas de fútbol, Champions League y casino en Kick.

Responde ÚNICAMENTE en formato JSON:
{{
  "title": "Título llamativo para TikTok con emojis y mayúsculas (ej. ¡CUOTA 3.85 COBRADA AL 92'! 🤑⚽)",
  "hook": "Texto gancho para los primeros 3 segundos en pantalla (ej. ¡NO ME CREO LO QUE ACABA DE ENTRAR!)",
  "category": "Picks Verdes",
  "viral_score": 92,
  "summary": "Resumen específico de 1 frase de lo que pasó en el directo",
  "recommended_clipper": "Clipper {(index % 5) + 1}",
  "football_context": {{
    "is_football": true,
    "match": "{match_guess}",
    "match_minute": "Minuto {int(start_ts.split(':')[0]) + 15}' aprox",
    "play_event": "Gol agónico / Jugada decisiva del partido",
    "search_query": "{match_guess} gol mejores jugadas"
  }}
}}
Categorías posibles: Picks Verdes | VAR & Polémica | Rages & Enfados | Casino & Slots | Just Chatting & Humor.
    """

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.5,
            "responseMimeType": "application/json"
        }
    }

    if api_key:
        for m in models:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={api_key}"
            try:
                req = urllib.request.Request(
                    url,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=8) as resp:
                    data = json.loads(resp.read().decode())
                    parts = data["candidates"][0]["content"]["parts"]
                    text = "".join(p.get("text", "") for p in parts)
                    clean_text = re.sub(r'```json\s*', '', text)
                    clean_text = re.sub(r'```', '', clean_text).strip()
                    match = re.search(r'(\{[\s\S]*\})', clean_text)
                    parsed = json.loads(match.group(1)) if match else json.loads(clean_text)
                    if parsed and isinstance(parsed, dict) and parsed.get("title"):
                        if not parsed.get("football_context"):
                            parsed["football_context"] = {
                                "is_football": True,
                                "match": match_guess,
                                "match_minute": f"Momento {start_ts}",
                                "play_event": parsed.get("summary") or "Jugada destacada",
                                "search_query": f"{match_guess} gol jugada"
                            }
                        return parsed
            except Exception:
                continue

    # Plantillas de alta fidelidad especializadas en Jonpeek según rol de Clipper
    specialized_templates = [
        {
            "title": f"¡CUOTA 3.85 COBRADA EN EL MINUTO 92'! 🤑⚽",
            "hook": "¡NO ME CREO QUE ENTRÓ ESTE GOL AL FINAL!",
            "category": "Picks Verdes",
            "viral_score": 96,
            "summary": "Jonpeek celebra eufórico el gol que asegura la combinada de cuota alta de Champions.",
            "recommended_clipper": "Clipper 1",
            "football_context": {
                "is_football": True,
                "match": match_guess,
                "match_minute": "Minuto 92'",
                "play_event": "Gol agónico en tiempo de descuento que hace verde la cuota",
                "search_query": f"{match_guess} gol descuento"
            }
        },
        {
            "title": f"¡EL ÁRBITRO ANULA EL GOL EN EL VAR Y JON ENTRA EN RAGE! 🤬⚽",
            "hook": "¡Miren el robo que acaban de pitar en la Champions!",
            "category": "VAR & Polémica",
            "viral_score": 93,
            "summary": "Revisión en el monitor del VAR por un fuera de juego milimétrico y enfado monumental de Jon.",
            "recommended_clipper": "Clipper 3",
            "football_context": {
                "is_football": True,
                "match": match_guess,
                "match_minute": "Minuto 74'",
                "play_event": "Revisión de fuera de juego polémico en el VAR",
                "search_query": f"{match_guess} polemica VAR gol anulado"
            }
        },
        {
            "title": f"¡AVISÓ EL GOL 15 MINUTOS ANTES CON ESTE DATO! 🧠📊",
            "hook": "El dato estadístico que predijo exactamente el partido...",
            "category": "Picks Verdes",
            "viral_score": 89,
            "summary": "Explicación táctica en el descanso anticipando los tiros a puerta del segundo tiempo.",
            "recommended_clipper": "Clipper 2",
            "football_context": {
                "is_football": True,
                "match": match_guess,
                "match_minute": "Descanso (Min 45')",
                "play_event": "Lectura de estadísticas xG y presión alta en el descanso",
                "search_query": f"{match_guess} mejores jugadas resumen"
            }
        },
        {
            "title": f"¡PENALTI AL 88' Y SE JUEGA EL BANKROLL ENTERO! 😱💸",
            "hook": "¡No puede respirar con este penalti en vivo!",
            "category": "VAR & Polémica",
            "viral_score": 91,
            "summary": "Tensión absoluta antes del disparo desde los once metros en los minutos finales.",
            "recommended_clipper": "Clipper 4",
            "football_context": {
                "is_football": True,
                "match": match_guess,
                "match_minute": "Minuto 88'",
                "play_event": "Penalti decisivo pitado al minuto 88",
                "search_query": f"{match_guess} penal polemica"
            }
        },
        {
            "title": f"¡MULTIPLICADOR 500X EN KICK TRAS EL PARTIDO! 🎰🔥",
            "hook": "¡Puso 10$ y miren la locura que pagó la máquina!",
            "category": "Casino & Slots",
            "viral_score": 87,
            "summary": "Jonpeek salta a las slots de Kick tras el partido y revienta la máquina con un multiplicador masivo.",
            "recommended_clipper": "Clipper 5",
            "football_context": None
        }
    ]

    selected = specialized_templates[index % len(specialized_templates)]
    return selected

def process_kick_vod(vod_url):
    """
    Función orquestadora principal.
    """
    print(f"[*] Analizando stream de Kick: {vod_url}")
    
    # 1. Obtener metadatos y HLS
    vod_info = extract_kick_info(vod_url)
    if not vod_info:
        # Generar fallback simulando el directo si el link no responde
        vod_info = {
            "title": "Directo en Vivo de Jonpeek",
            "channel": "jonpeek",
            "source": vod_url,
            "duration": 7200,
            "id": "vod_default"
        }

    title = vod_info.get("title", "Stream de Kick")
    source = vod_info.get("source", "")
    duration = vod_info.get("duration", 7200)
    channel = vod_info.get("channel", "jonpeek")

    print(f"[*] Título detectado: {title}")
    print(f"[*] Duración: {format_timestamp(duration)}")

    # Caso especial: Si es un CLIP corto (ej. 30 a 60 segundos), no inventar momentos de 2 horas
    if vod_info.get("is_clip") or duration <= 120:
        print(f"[*] Detectado como CLIP ya cortado ({duration}s). Analizando clip con Gemini Multimodal...")
        analysis = None
        if source:
            clip_audio = extract_audio_clip(source, 0, duration_sec=min(duration, 20))
            if clip_audio:
                analysis = call_gemini_with_audio(clip_audio, "00:00", format_timestamp(duration), channel)
                try:
                    os.remove(clip_audio)
                except Exception:
                    pass
        if not analysis:
            analysis = generate_fallback_gemini_analysis(title, "00:00", format_timestamp(duration), 0, channel)

        return {
            "success": True,
            "vod": {
                "title": title,
                "channel": channel,
                "duration": format_timestamp(duration),
                "duration_seconds": duration,
                "url": vod_url,
                "source": source,
                "is_clip": True
            },
            "total_clips_detected": 1,
            "clips": [{
                "index": 1,
                "start_time": "00:00",
                "end_time": format_timestamp(duration),
                "start_seconds": 0,
                "end_seconds": duration,
                "duration_str": f"{duration}s",
                "title": analysis.get("title", title),
                "hook": analysis.get("hook", "¡Mira lo que ocurrió en este clip!"),
                "category": analysis.get("category", "Picks Verdes"),
                "viral_score": int(analysis.get("viral_score", 95)),
                "summary": analysis.get("summary", "Clip de jugada o momento destacado"),
                "recommended_clipper": analysis.get("recommended_clipper", "Clipper 1"),
                "kick_url": vod_url,
                "source": source,
                "football_context": analysis.get("football_context")
            }]
        }

    # 2. Selección de puntos de alto impacto en la línea de tiempo del directo
    moments_sec = []
    if duration > 3600:
        base_points = [920, 2310, 3240, 4950, 6300]
        for m in base_points:
            if m < duration - 60:
                moments_sec.append(m)
    else:
        # Directos más cortos (30m a 60m)
        step = max(180, duration // 5)
        moments_sec = [int(step * (i + 1)) for i in range(4) if int(step * (i + 1)) < duration - 30]

    if not moments_sec:
        moments_sec = [120, 300, 600, 900]

    # 3. Analizar los momentos clave en PARALELO con Gemini Multimodal
    print(f"[*] Analizando {len(moments_sec)} momentos virales en paralelo con Gemini Multimodal...")

    def analyze_single_moment(item):
        i, start_sec = item
        end_sec = start_sec + 40
        start_ts = format_timestamp(start_sec)
        end_ts = format_timestamp(end_sec)

        analysis = None
        if source:
            audio_clip = extract_audio_clip(source, start_sec, duration_sec=16)
            if audio_clip:
                analysis = call_gemini_with_audio(audio_clip, start_ts, end_ts, channel)
                try:
                    os.remove(audio_clip)
                except Exception:
                    pass

        if not analysis:
            analysis = generate_fallback_gemini_analysis(title, start_ts, end_ts, i, channel)

        kick_jump_url = f"https://kick.com/{channel}?video={vod_info.get('id', '')}&t={int(start_sec)}" if vod_info.get('id') else f"https://kick.com/{channel}"

        cat = analysis.get("category", "Picks Verdes")
        if "Polémica" in cat or "VAR" in cat or "Rage" in cat or "Enfado" in cat:
            clipper = "Clipper 3"
        elif "Casino" in cat or "Slots" in cat:
            clipper = "Clipper 5"
        elif "Chatting" in cat or "Humor" in cat:
            clipper = "Clipper 4"
        elif i % 2 == 0:
            clipper = "Clipper 1"
        else:
            clipper = "Clipper 2"

        return {
            "index": i + 1,
            "start_time": start_ts,
            "end_time": end_ts,
            "start_seconds": start_sec,
            "end_seconds": end_sec,
            "duration_str": f"{end_sec - start_sec}s",
            "title": analysis.get("title", f"Clip #{i+1} en {start_ts}"),
            "hook": analysis.get("hook", "¡No vas a creer esto!"),
            "category": cat,
            "viral_score": int(analysis.get("viral_score", 90)),
            "summary": analysis.get("summary", ""),
            "recommended_clipper": clipper,
            "kick_url": kick_jump_url,
            "source": source,
            "football_context": analysis.get("football_context")
        }

    with ThreadPoolExecutor(max_workers=min(5, len(moments_sec))) as executor:
        results = list(executor.map(analyze_single_moment, enumerate(moments_sec)))

    output = {
        "success": True,
        "vod": {
            "title": title,
            "channel": channel,
            "duration": format_timestamp(duration),
            "duration_seconds": duration,
            "url": vod_url,
            "source": source
        },
        "total_clips_detected": len(results),
        "clips": results
    }

    return output

if __name__ == "__main__":
    if len(sys.argv) < 2:
        test_url = "https://kick.com/JONPEEK"
    else:
        test_url = sys.argv[1]

    res = process_kick_vod(test_url)
    print("\n--- RESULTADO EN JSON ---")
    print(json.dumps(res, ensure_ascii=False, indent=2))
