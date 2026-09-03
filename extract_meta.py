import sys
import json
import urllib.request
import urllib.parse
import re
import datetime
import yt_dlp

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def extract_tiktok_id(url):
    # Follow redirects for vt.tiktok.com or vm.tiktok.com
    clean_url = url
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        with urllib.request.urlopen(req, timeout=6) as resp:
            clean_url = resp.geturl()
    except Exception:
        pass
    
    m = re.search(r'video/(\d+)', clean_url) or re.search(r'(\d{16,22})', clean_url)
    vid_id = m.group(1) if m else None
    return vid_id, clean_url

def extract_tiktok_date_from_id(vid_id):
    if not vid_id:
        return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
    try:
        unix_ts = int(vid_id) >> 32
        dt = datetime.datetime.fromtimestamp(unix_ts, datetime.timezone.utc)
        return dt.strftime('%Y-%m-%d')
    except Exception:
        return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')

def extract_tiktok(url):
    vid_id, clean_url = extract_tiktok_id(url)
    publish_date = extract_tiktok_date_from_id(vid_id)
    
    # 1. Extract with TikWM API
    try:
        api_url = f"https://tikwm.com/api/?url={urllib.parse.quote(clean_url)}"
        req = urllib.request.Request(
            api_url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            }
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode())
            if data.get('code') == 0:
                d = data.get('data', {})
                return {
                    "title": d.get('title') or f"TikTok de {d.get('author', {}).get('nickname', 'Jonpeek')}",
                    "views": int(d.get('play_count') or 0),
                    "likes": int(d.get('diggCount') or d.get('digg_count') or 0),
                    "author": d.get('author', {}).get('nickname') or d.get('author', {}).get('unique_id') or "",
                    "thumbnail": d.get('cover') or "",
                    "publishDate": publish_date,
                    "platform": "tiktok",
                    "success": True
                }
    except Exception:
        pass

    # 2. Fallback: Googlebot SEO Scraper
    try:
        req = urllib.request.Request(
            clean_url,
            headers={
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        )
        with urllib.request.urlopen(req, timeout=6) as r:
            html = r.read().decode('utf-8', errors='ignore')
            schema_match = re.search(r'<script type="application/ld\+json"[^>]*>(.*?)</script>', html, re.DOTALL)
            if schema_match:
                schema = json.loads(schema_match.group(1))
                views = 0
                for stat in schema.get('interactionStatistic', []):
                    if stat.get('interactionType', {}).get('@type') == 'http://schema.org/WatchAction':
                        views = stat.get('userInteractionCount') or 0
                
                upload_date = schema.get('uploadDate')
                if upload_date and len(upload_date) >= 10:
                    publish_date = upload_date[:10]

                return {
                    "title": schema.get('name', ''),
                    "views": int(views),
                    "author": schema.get('creator', {}).get('name', ''),
                    "thumbnail": schema.get('thumbnailUrl', [''])[0] if isinstance(schema.get('thumbnailUrl'), list) else schema.get('thumbnailUrl', ''),
                    "publishDate": publish_date,
                    "platform": "tiktok",
                    "success": True
                }
    except Exception:
        pass

    # 3. Default fallback
    return {
        "title": "Clip de TikTok",
        "views": 0,
        "publishDate": publish_date,
        "platform": "tiktok",
        "success": True
    }

def extract_facebook(url):
    ydl_opts = {
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
        'extract_flat': False,
        'socket_timeout': 10
    }

    title = ""
    views = 0
    author = ""
    thumbnail = ""
    publish_date = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if info:
                title = info.get('title') or ""
                views = int(info.get('view_count') or 0)
                author = info.get('uploader') or ""
                thumbnail = info.get('thumbnail') or ""
                upload_date = info.get('upload_date')
                if upload_date and len(upload_date) == 8:
                    publish_date = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}"
    except Exception:
        pass

    # Fallback to direct HTML scrape if views is still 0 or low
    try:
        req = urllib.request.Request(
            url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        )
        with urllib.request.urlopen(req, timeout=6) as r:
            html = r.read().decode('utf-8', errors='ignore')
            
            # Find title if empty
            if not title:
                t_match = re.search(r'<meta property="og:title" content="(.*?)"', html) or re.search(r'<title>(.*?)</title>', html)
                if t_match:
                    title = t_match.group(1).replace('Facebook', '').replace('Reels', '').strip()

            # Find video_view_count / play_count / watch_count in JSON
            play_matches = re.findall(r'"video_view_count":(\d+)', html) or re.findall(r'"play_count":(\d+)', html) or re.findall(r'"video_watch_count":(\d+)', html)
            if play_matches:
                found_views = int(play_matches[0])
                if found_views > views:
                    views = found_views

            # Date fallback
            date_match = re.search(r'"publish_time":(\d+)', html) or re.search(r'"creation_time":(\d+)', html)
            if date_match:
                ts = int(date_match.group(1))
                publish_date = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime('%Y-%m-%d')
    except Exception:
        pass

    return {
        "title": title or "Reel de Facebook",
        "views": views,
        "author": author or "Facebook",
        "thumbnail": thumbnail,
        "publishDate": publish_date,
        "platform": "facebook",
        "success": True
    }

def extract_general(url):
    ydl_opts = {
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
        'extract_flat': False,
        'socket_timeout': 10
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                return {"error": "No se pudo extraer información"}

            title = info.get('title') or ""
            views = info.get('view_count') or 0
            author = info.get('uploader') or info.get('channel') or info.get('creator') or ""
            thumbnail = info.get('thumbnail') or ""
            upload_date = info.get('upload_date')
            formatted_date = None
            if upload_date and len(upload_date) == 8:
                formatted_date = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}"

            return {
                "title": title,
                "views": int(views),
                "author": author,
                "thumbnail": thumbnail,
                "publishDate": formatted_date or datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d'),
                "extractor": info.get('extractor_key'),
                "success": True
            }
    except Exception as e:
        return {"error": str(e), "success": False}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided", "success": False}))
        sys.exit(1)

    url = sys.argv[1].strip()
    u_lower = url.lower()

    if "tiktok.com" in u_lower:
        result = extract_tiktok(url)
    elif "facebook.com" in u_lower or "fb.watch" in u_lower or "fb.com" in u_lower:
        result = extract_facebook(url)
    else:
        result = extract_general(url)

    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
