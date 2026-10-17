#!/usr/bin/env python3
"""
YouTube 影音資料庫 — 自動抓取程式
由 GitHub Actions 每兩天執行一次，也可以在本機手動執行：
    YOUTUBE_API_KEY=你的金鑰 python3 scripts/fetch.py

讀取 config/categories.json，依每個分類的「頻道」與「關鍵字」抓影片，
結果寫入 data/videos.json。只用 Python 標準函式庫，不需安裝任何套件。
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config", "categories.json")
VIDEOS_PATH = os.path.join(ROOT, "data", "videos.json")
CHANNEL_CACHE_PATH = os.path.join(ROOT, "data", "channels_cache.json")
API = "https://www.googleapis.com/youtube/v3/"
API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()

NOW = datetime.now(timezone.utc)
LOG = []
quota_used = 0
quota_exhausted = False


def log(msg):
    print(msg)
    LOG.append(msg)


class QuotaExceeded(Exception):
    pass


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def api_get(endpoint, params, cost):
    """呼叫 YouTube Data API v3。cost 是這次呼叫消耗的配額單位。"""
    global quota_used, quota_exhausted
    if quota_exhausted:
        raise QuotaExceeded()
    params = dict(params)
    params["key"] = API_KEY
    url = API + endpoint + "?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            quota_used += cost
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        if e.code == 403 and "quota" in body.lower():
            quota_exhausted = True
            log("⚠️ 今日 API 配額已用完，保留現有資料，下次再更新。")
            raise QuotaExceeded()
        log(f"⚠️ API 錯誤 {e.code}（{endpoint}）：{body[:200]}")
        return None
    except Exception as e:  # 網路問題等
        log(f"⚠️ 連線失敗（{endpoint}）：{e}")
        return None


def parse_duration(iso):
    """把 PT1H2M3S 轉成秒數。"""
    m = re.match(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return 0
    d, h, mi, s = (int(x) if x else 0 for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def region_for(lang):
    return {"ja": "JP", "zh-Hant": "TW", "en": "US"}.get(lang, "TW")


# ---------------- 頻道 ----------------

def resolve_channel(ch, cache):
    """把設定檔裡的頻道（id / handle / 名稱搜尋）轉成頻道 ID 與上傳清單 ID，結果快取。"""
    key = ch.get("id") or ch.get("handle") or ch.get("query") or ch.get("name")
    if key in cache and cache[key].get("uploads"):
        return cache[key]
    if not API_KEY:
        return None
    info = None
    if ch.get("id"):
        res = api_get("channels", {"part": "snippet,contentDetails", "id": ch["id"]}, 1)
        info = res and res.get("items") and res["items"][0]
    elif ch.get("handle"):
        res = api_get("channels", {"part": "snippet,contentDetails",
                                   "forHandle": ch["handle"].lstrip("@")}, 1)
        info = res and res.get("items") and res["items"][0]
    else:
        q = ch.get("query") or ch.get("name")
        res = api_get("search", {"part": "snippet", "type": "channel", "q": q, "maxResults": 1}, 100)
        if res and res.get("items"):
            cid = res["items"][0]["snippet"]["channelId"]
            res2 = api_get("channels", {"part": "snippet,contentDetails", "id": cid}, 1)
            info = res2 and res2.get("items") and res2["items"][0]
    if not info:
        log(f"   ✗ 找不到頻道：{ch.get('name')}")
        cache[key] = {"name": ch.get("name"), "ok": False, "checked": NOW.isoformat()}
        return None
    entry = {
        "name": ch.get("name"),
        "id": info["id"],
        "title": info["snippet"]["title"],
        "thumb": info["snippet"].get("thumbnails", {}).get("default", {}).get("url", ""),
        "uploads": info["contentDetails"]["relatedPlaylists"]["uploads"],
        "ok": True,
        "checked": NOW.isoformat(),
    }
    cache[key] = entry
    log(f"   ✓ 頻道「{ch.get('name')}」→ {entry['title']}")
    return entry


def channel_video_ids(entry, n):
    res = api_get("playlistItems", {"part": "contentDetails", "playlistId": entry["uploads"],
                                    "maxResults": n}, 1)
    if not res:
        return []
    return [it["contentDetails"]["videoId"] for it in res.get("items", [])]


def channel_rss(channel_id, n):
    """沒有 API Key 時的備案：用頻道 RSS（只抓得到有填 id 的頻道）。"""
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            root = ET.fromstring(r.read())
    except Exception as e:
        log(f"   ✗ RSS 失敗 {channel_id}：{e}")
        return []
    ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
          "media": "http://search.yahoo.com/mrss/"}
    out = []
    for e in root.findall("a:entry", ns)[:n]:
        vid = e.findtext("yt:videoId", namespaces=ns)
        out.append({
            "id": vid,
            "title": e.findtext("a:title", namespaces=ns) or "",
            "channel": e.findtext("a:author/a:name", namespaces=ns) or "",
            "channelId": channel_id,
            "publishedAt": e.findtext("a:published", namespaces=ns) or "",
            "duration": 0, "views": 0, "embeddable": True,
            "thumb": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
        })
    return out


# ---------------- 關鍵字搜尋 ----------------

def search_video_ids(keyword, cat, settings):
    params = {
        "part": "snippet", "type": "video", "q": keyword,
        "maxResults": settings.get("searchMaxResults", 15),
        "order": "relevance", "safeSearch": "moderate",
        "relevanceLanguage": cat.get("lang", "zh-Hant"),
        "regionCode": region_for(cat.get("lang")),
    }
    days = cat.get("recentDays", settings.get("defaultRecentDays", 365))
    if days and days > 0:
        params["publishedAfter"] = (NOW - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    res = api_get("search", params, 100)
    if not res:
        return []
    return [it["id"]["videoId"] for it in res.get("items", []) if it.get("id", {}).get("videoId")]


def video_details(ids):
    """一次最多 50 部，取得標題、長度、觀看數、能否嵌入。"""
    out = {}
    ids = list(dict.fromkeys(ids))
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        res = api_get("videos", {"part": "snippet,contentDetails,statistics,status",
                                 "id": ",".join(chunk)}, 1)
        if not res:
            continue
        for v in res.get("items", []):
            sn = v["snippet"]
            th = sn.get("thumbnails", {})
            thumb = (th.get("medium") or th.get("high") or th.get("default") or {}).get("url") \
                or f"https://i.ytimg.com/vi/{v['id']}/mqdefault.jpg"
            out[v["id"]] = {
                "id": v["id"],
                "title": sn.get("title", ""),
                "channel": sn.get("channelTitle", ""),
                "channelId": sn.get("channelId", ""),
                "publishedAt": sn.get("publishedAt", ""),
                "duration": parse_duration(v.get("contentDetails", {}).get("duration")),
                "views": int(v.get("statistics", {}).get("viewCount", 0) or 0),
                "embeddable": bool(v.get("status", {}).get("embeddable", True)),
                "live": sn.get("liveBroadcastContent", "none") != "none",
                "thumb": thumb,
            }
    return out


def keep_video(v, cat, settings):
    if v.get("live"):
        return False
    title = (v.get("title") or "").lower()
    for word in cat.get("exclude", []):
        if word and word.lower() in title:
            return False
    if settings.get("excludeShorts", True):
        if "#shorts" in title or (0 < v.get("duration", 0) <= 60):
            return False
    return True


# ---------------- 主流程 ----------------

def main():
    config = load_json(CONFIG_PATH, None)
    if not config:
        sys.exit("找不到或無法讀取 config/categories.json")
    settings = config.get("settings", {})
    old = load_json(VIDEOS_PATH, {"videos": []})
    cache = load_json(CHANNEL_CACHE_PATH, {})

    videos = {v["id"]: v for v in old.get("videos", [])}
    channel_report = {}
    run_stamp = NOW.isoformat()

    if not API_KEY:
        log("⚠️ 沒有設定 YOUTUBE_API_KEY，只能用 RSS 抓有填 id 的頻道。")

    all_cats = [c for g in config.get("groups", []) for c in g.get("categories", [])]
    valid_cat_ids = {c["id"] for c in all_cats}

    for cat in all_cats:
        cid = cat["id"]
        log(f"▶ {cat.get('name')}（{cid}）")
        found = {}       # videoId -> 來源
        rss_items = []
        channel_report[cid] = []
        try:
            for ch in cat.get("channels", []):
                if API_KEY:
                    entry = resolve_channel(ch, cache)
                    channel_report[cid].append({
                        "name": ch.get("name"),
                        "title": entry.get("title") if entry else None,
                        "id": entry.get("id") if entry else None,
                        "ok": bool(entry),
                    })
                    if entry:
                        for vid in channel_video_ids(entry, settings.get("channelMaxResults", 8)):
                            found[vid] = "channel"
                elif ch.get("id"):
                    rss_items += channel_rss(ch["id"], settings.get("channelMaxResults", 8))
            if API_KEY:
                for kw in cat.get("keywords", []):
                    for vid in search_video_ids(kw, cat, settings):
                        found.setdefault(vid, "search")
        except QuotaExceeded:
            pass

        details = {}
        if found and not quota_exhausted:
            try:
                details = video_details(list(found.keys()))
            except QuotaExceeded:
                details = {}
        for it in rss_items:
            details.setdefault(it["id"], it)
            found.setdefault(it["id"], "channel")

        added = 0
        for vid, d in details.items():
            if not keep_video(d, cat, settings):
                continue
            existing = videos.get(vid)
            if existing:
                existing.update({k: d[k] for k in ("title", "views", "embeddable", "thumb", "duration") if k in d})
                if cid not in existing["cats"]:
                    existing["cats"].append(cid)
                    existing.setdefault("catSeen", {})[cid] = run_stamp
            else:
                d = dict(d)
                d.pop("live", None)
                d["cats"] = [cid]
                d["firstSeen"] = run_stamp
                d["catSeen"] = {cid: run_stamp}
                d["source"] = found.get(vid, "search")
                videos[vid] = d
                added += 1
        log(f"   新增 {added} 部")

    # 移除已刪除分類的標記，並讓每個分類最多保留 maxVideosPerCategory 部
    limit = settings.get("maxVideosPerCategory", 60)
    for v in videos.values():
        v["cats"] = [c for c in v.get("cats", []) if c in valid_cat_ids]
    for cid in valid_cat_ids:
        in_cat = [v for v in videos.values() if cid in v["cats"]]
        in_cat.sort(key=lambda v: (v.get("catSeen", {}).get(cid, v.get("firstSeen", "")),
                                   v.get("publishedAt", "")), reverse=True)
        for v in in_cat[limit:]:
            v["cats"].remove(cid)
    final = [v for v in videos.values() if v["cats"]]
    final.sort(key=lambda v: v.get("publishedAt", ""), reverse=True)

    save_json(VIDEOS_PATH, {
        "updatedAt": run_stamp,
        "quotaUsed": quota_used,
        "total": len(final),
        "channels": channel_report,
        "log": LOG[-200:],
        "videos": final,
    })
    save_json(CHANNEL_CACHE_PATH, cache)
    log(f"✅ 完成：共 {len(final)} 部影片，本次約用 {quota_used} 配額單位。")


if __name__ == "__main__":
    main()
