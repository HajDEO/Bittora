"""
Bittora — qBittorrent API v2 Compatibility Layer
Provides /api/v2/ endpoints for *arr applications (Sonarr, Radarr, Lidarr, Prowlarr).
They use the qBittorrent download client profile and expect these endpoints.
"""

import os
import time
import secrets
import libtorrent as lt
from datetime import datetime
from fastapi import APIRouter, Request, Response, HTTPException, Form, UploadFile, File, Depends
from fastapi.responses import PlainTextResponse, JSONResponse
from typing import Optional

from main import (
    ses, active_handles, _handles_lock, SessionLocal, Setting, User, TorrentRecord,
    Category, Connection, DL_DIR, get_dl_dir, log, bcrypt, check_rate_limit,
    _get_setting_val, _safe_int, fire_webhook, _uploaded_hashes,
)

qbt_router = APIRouter(prefix="/api/v2")

# ─── SID session store ───
_qbt_sessions: dict[str, dict] = {}  # SID → {username, created}
_SID_EXPIRY = 86400  # 24h

# ─── Per-torrent share limits (in-memory, lost on restart — same as qBT) ───
_share_limits: dict[str, dict] = {}  # info_hash_lower → {ratio_limit, seeding_time_limit}


def _cleanup_sessions():
    now = time.time()
    expired = [sid for sid, s in _qbt_sessions.items() if now - s["created"] > _SID_EXPIRY]
    for sid in expired:
        _qbt_sessions.pop(sid, None)


def _qbt_enabled() -> bool:
    db = SessionLocal()
    try:
        return _get_setting_val(db, "qbt_api_enabled") == "true"
    finally:
        db.close()


def _qbt_auth(request: Request):
    """Dependency: validate SID cookie + feature gate."""
    if not _qbt_enabled():
        raise HTTPException(status_code=404, detail="Not Found")
    sid = request.cookies.get("SID")
    if not sid or sid not in _qbt_sessions:
        raise HTTPException(status_code=403, detail="Forbidden")
    s = _qbt_sessions[sid]
    if time.time() - s["created"] > _SID_EXPIRY:
        _qbt_sessions.pop(sid, None)
        raise HTTPException(status_code=403, detail="Forbidden")
    return s


# ═══════════════ AUTH ═══════════════

@qbt_router.post("/auth/login")
async def qbt_login(request: Request, response: Response,
                     username: str = Form(""), password: str = Form("")):
    if not _qbt_enabled():
        raise HTTPException(status_code=404, detail="Not Found")
    ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(ip):
        return PlainTextResponse("Fails.", status_code=429)
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username, User.active == True).first()
        if not user or not bcrypt.checkpw(password.encode(), user.password_hash.encode()):
            return PlainTextResponse("Fails.", status_code=200)
        _cleanup_sessions()
        sid = secrets.token_hex(32)
        _qbt_sessions[sid] = {"username": user.username, "created": time.time()}
        resp = PlainTextResponse("Ok.")
        resp.set_cookie(key="SID", value=sid, path="/", httponly=True)
        return resp
    finally:
        db.close()


@qbt_router.post("/auth/logout")
async def qbt_logout(request: Request, response: Response):
    sid = request.cookies.get("SID")
    if sid:
        _qbt_sessions.pop(sid, None)
    resp = PlainTextResponse("Ok.")
    resp.delete_cookie("SID", path="/")
    return resp


# ═══════════════ APP INFO ═══════════════

@qbt_router.get("/app/webapiVersion")
async def qbt_webapi_version(_=Depends(_qbt_auth)):
    return PlainTextResponse("2.9.3")


@qbt_router.get("/app/version")
async def qbt_app_version(_=Depends(_qbt_auth)):
    return PlainTextResponse("v4.6.7")


@qbt_router.get("/app/buildInfo")
async def qbt_build_info(_=Depends(_qbt_auth)):
    return {"qt": "6.5.3", "libtorrent": lt.version, "boost": "1.83.0", "openssl": "3.1.4", "bitness": 64}


# ═══════════════ PREFERENCES ═══════════════

@qbt_router.get("/app/preferences")
async def qbt_preferences(_=Depends(_qbt_auth)):
    db = SessionLocal()
    try:
        rows = {r.key: r.value for r in db.query(Setting).all()}
        target_ratio = float(rows.get("target_ratio", "0") or "0")
        max_seed_time = _safe_int(rows.get("max_seed_time", "0"))
        # Report effective save path based on default_storage setting
        def_storage = rows.get("default_storage", "local") or "local"
        if def_storage in ("smb", "nfs", "custom"):
            effective_path = rows.get("download_dir", "") or ""
            save_path = (effective_path.strip() or DL_DIR).rstrip("/") + "/"
        else:
            save_path = DL_DIR + "/"
        return {
            "save_path": save_path,
            "max_ratio_enabled": target_ratio > 0,
            "max_ratio": target_ratio,
            "max_seeding_time_enabled": max_seed_time > 0,
            "max_seeding_time": max_seed_time,
            "max_inactive_seeding_time_enabled": False,
            "max_inactive_seeding_time": -1,
            "max_ratio_act": 0,
            "queueing_enabled": True,
            "dht": rows.get("dht", "true") == "true",
        }
    finally:
        db.close()


# ═══════════════ STATE MAPPING ═══════════════

def _qbt_state(h: lt.torrent_handle, s, progress_override: float = None) -> str:
    """Map libtorrent status to qBittorrent state string."""
    is_paused = s.paused
    progress = progress_override if progress_override is not None else s.progress
    state = s.state

    if is_paused:
        return "pausedUP" if progress >= 1.0 else "pausedDL"

    if state == lt.torrent_status.checking_files:
        return "checkingUP" if progress >= 1.0 else "checkingDL"
    if state == lt.torrent_status.checking_resume_data:
        return "checkingResumeData"
    if state == lt.torrent_status.downloading_metadata:
        return "metaDL"
    if state in (lt.torrent_status.downloading, lt.torrent_status.allocating):
        return "downloading" if s.download_rate > 0 else "stalledDL"
    if state in (lt.torrent_status.seeding, lt.torrent_status.finished):
        return "uploading" if s.upload_rate > 0 else "stalledUP"

    return "stalledDL" if progress < 1.0 else "stalledUP"


def _torrent_to_qbt(ih: str, h: lt.torrent_handle, rec, now_ts: float) -> dict:
    """Convert a Bittora torrent to qBittorrent API format."""
    s = h.status()
    total_wanted = s.total_wanted or 0
    total_done = s.total_done or 0
    dl_rate = int(s.download_rate)
    ul_rate = int(s.upload_rate)
    all_dl = s.all_time_download or 0
    all_ul = s.all_time_upload or 0
    ratio = round(all_ul / all_dl, 4) if all_dl > 0 else 0.0
    progress = s.progress  # 0.0 - 1.0

    # Fix: when total_wanted=0 (no metadata yet) but data was downloaded,
    # use all_time_download as size estimate and mark as complete
    if total_wanted == 0 and all_dl > 0:
        total_wanted = all_dl
        total_done = all_dl
        progress = 1.0

    amount_left = max(0, total_wanted - total_done)
    eta = int(amount_left / dl_rate) if dl_rate > 0 else 8640000
    save_path = s.save_path or DL_DIR
    if not save_path.endswith("/"):
        save_path += "/"
    name = h.name() or (rec.name if rec else "Unknown")
    content_path = save_path + name

    # Tracker
    tracker = ""
    try:
        trackers = h.trackers()
        if trackers:
            tracker = trackers[0]["url"]
    except Exception:
        pass

    # Timestamps
    added_on = int(rec.added_at.timestamp()) if rec and rec.added_at else int(now_ts)
    completion_on = int(rec.completed_at.timestamp()) if rec and rec.completed_at else -1
    seeding_time = max(0, int(now_ts - completion_on)) if completion_on > 0 else 0
    last_activity = int(now_ts) if (dl_rate > 0 or ul_rate > 0) else added_on

    # Magnet
    magnet = ""
    if rec and rec.magnet_uri:
        magnet = rec.magnet_uri
    else:
        try:
            magnet = lt.make_magnet_uri(h)
        except Exception:
            pass

    # Share limits
    ih_lower = ih.lower()
    limits = _share_limits.get(ih_lower, {})
    ratio_limit = limits.get("ratio_limit", -2)  # -2 = use global
    seeding_time_limit = limits.get("seeding_time_limit", -2)

    return {
        "hash": ih_lower,
        "name": name,
        "size": total_wanted,
        "total_size": total_wanted,
        "progress": progress,
        "dlspeed": dl_rate,
        "upspeed": ul_rate,
        "num_seeds": s.num_seeds,
        "num_leechs": max(0, s.num_peers - s.num_seeds),
        "ratio": ratio,
        "eta": eta,
        "state": _qbt_state(h, s, progress),
        "category": rec.category if rec else "",
        "save_path": save_path,
        "content_path": content_path,
        "added_on": added_on,
        "completion_on": completion_on,
        "ratio_limit": ratio_limit,
        "seeding_time_limit": seeding_time_limit,
        "seeding_time": seeding_time,
        "last_activity": last_activity,
        "downloaded": all_dl,
        "uploaded": all_ul,
        "amount_left": amount_left,
        "tracker": tracker,
        "magnet_uri": magnet,
        "tags": "",
        "auto_tmm": False,
        "force_start": False,
        "seq_dl": False,
        "f_l_piece_prio": False,
        "num_complete": s.num_seeds,
        "num_incomplete": max(0, s.num_peers - s.num_seeds),
        "priority": 0,
        "availability": -1,
        "super_seeding": False,
        "up_limit": -1,
        "dl_limit": -1,
        "time_active": max(0, int(now_ts - added_on)),
        "completed": total_done,
        "seen_complete": int(now_ts) if progress >= 1.0 else 0,
    }


def _get_records_map() -> dict:
    """Get all torrent records from DB as {info_hash: record}."""
    db = SessionLocal()
    try:
        recs = db.query(TorrentRecord).all()
        # Detach from session
        result = {}
        for r in recs:
            result[r.info_hash] = type('R', (), {
                'name': r.name, 'category': r.category or '', 'destination': r.destination,
                'save_path': r.save_path, 'added_at': r.added_at, 'completed_at': r.completed_at,
                'magnet_uri': r.magnet_uri, 'info_hash': r.info_hash,
            })()
        return result
    finally:
        db.close()


# ═══════════════ TORRENTS INFO ═══════════════

@qbt_router.get("/torrents/info")
async def qbt_torrents_info(request: Request, _=Depends(_qbt_auth),
                             filter: str = None, category: str = None,
                             sort: str = None, hashes: str = None):
    now_ts = time.time()
    recs = _get_records_map()
    result = []
    hash_filter = set(hashes.lower().split("|")) if hashes else None

    for ih, h in list(active_handles.items()):
        ih_lower = ih.lower()
        if hash_filter and ih_lower not in hash_filter:
            continue
        try:
            rec = recs.get(ih)
            t = _torrent_to_qbt(ih, h, rec, now_ts)
            if category is not None and t["category"] != category:
                continue
            if filter:
                st = t["state"]
                if filter == "downloading" and st not in ("downloading", "stalledDL", "metaDL", "checkingDL"):
                    continue
                if filter == "seeding" and st not in ("uploading", "stalledUP"):
                    continue
                if filter == "completed" and t["progress"] < 1.0:
                    continue
                if filter == "paused" and st not in ("pausedDL", "pausedUP"):
                    continue
                if filter == "active" and t["dlspeed"] == 0 and t["upspeed"] == 0:
                    continue
            result.append(t)
        except Exception as e:
            log.debug(f"qbt_api: skip {ih}: {e}")

    if sort:
        reverse = True
        key = sort
        result.sort(key=lambda x: x.get(key, 0), reverse=reverse)
    return result


@qbt_router.get("/torrents/properties")
async def qbt_torrent_properties(hash: str, _=Depends(_qbt_auth)):
    ih = hash.lower()
    for k, h in list(active_handles.items()):
        if k.lower() == ih:
            recs = _get_records_map()
            return _torrent_to_qbt(k, h, recs.get(k), time.time())
    raise HTTPException(status_code=404, detail="Not Found")


@qbt_router.get("/torrents/trackers")
async def qbt_torrent_trackers(hash: str, _=Depends(_qbt_auth)):
    ih = hash.lower()
    for k, h in list(active_handles.items()):
        if k.lower() == ih:
            try:
                return [{"url": t["url"], "status": 2, "tier": t.get("tier", 0),
                         "num_peers": 0, "num_seeds": 0, "num_leeches": 0, "num_downloaded": 0,
                         "msg": ""} for t in h.trackers()]
            except Exception:
                return []
    return []


@qbt_router.get("/torrents/files")
async def qbt_torrent_files(hash: str, _=Depends(_qbt_auth)):
    ih = hash.lower()
    for k, h in list(active_handles.items()):
        if k.lower() == ih:
            try:
                ti = h.torrent_file()
                if not ti:
                    return []
                fs = ti.files()
                result = []
                for i in range(fs.num_files()):
                    result.append({
                        "index": i,
                        "name": fs.file_path(i),
                        "size": fs.file_size(i),
                        "progress": 1.0,
                        "priority": 1,
                        "is_seed": False,
                        "piece_range": [0, 0],
                        "availability": 1.0,
                    })
                return result
            except Exception:
                return []
    return []


# ═══════════════ TORRENT OPERATIONS ═══════════════

def _resolve_hashes(hashes_str: str) -> list[str]:
    """Resolve pipe-delimited hashes or 'all' to list of info_hash keys."""
    if not hashes_str:
        return []
    if hashes_str.lower() == "all":
        return list(active_handles.keys())
    targets = []
    for h in hashes_str.split("|"):
        h = h.strip().lower()
        if not h:
            continue
        for k in active_handles:
            if k.lower() == h:
                targets.append(k)
                break
    return targets


@qbt_router.post("/torrents/add")
async def qbt_add_torrent(request: Request, _=Depends(_qbt_auth),
                           urls: str = Form(None), category: str = Form(""),
                           savepath: str = Form(None), paused: str = Form(None),
                           torrents: Optional[list[UploadFile]] = File(None)):
    # Respect default_storage setting (same logic as main API)
    db = SessionLocal()
    def_storage = _get_setting_val(db, "default_storage") or "local"
    if savepath:
        save_dir = savepath
    elif def_storage in ("smb", "nfs", "custom"):
        save_dir = get_dl_dir(def_storage)
    else:
        save_dir = os.path.join(DL_DIR, "incomplete")
    os.makedirs(save_dir, exist_ok=True)
    is_paused = paused and paused.lower() in ("true", "1")
    added = 0
    try:
        # Process magnet URLs
        if urls:
            for line in urls.strip().splitlines():
                uri = line.strip()
                if not uri:
                    continue
                try:
                    params = lt.parse_magnet_uri(uri)
                    params.save_path = save_dir
                    h = ses.add_torrent(params)
                    ih = str(h.info_hash())
                    with _handles_lock:
                        active_handles[ih] = h
                    if is_paused:
                        h.pause()
                    if not db.query(TorrentRecord).filter(TorrentRecord.info_hash == ih).first():
                        db.add(TorrentRecord(info_hash=ih, name=h.name() or "Unknown",
                                             save_path=save_dir, destination=def_storage,
                                             category=category, magnet_uri=uri))
                    added += 1
                    fire_webhook("added", {"info_hash": ih, "name": h.name() or "Unknown"})
                except Exception as e:
                    log.warning(f"qbt_api add magnet failed: {e}")

        # Process .torrent files
        if torrents:
            for tf in torrents:
                try:
                    data = await tf.read()
                    info = lt.torrent_info(lt.bdecode(data))
                    h = ses.add_torrent({"ti": info, "save_path": save_dir})
                    ih = str(h.info_hash())
                    with _handles_lock:
                        active_handles[ih] = h
                    if is_paused:
                        h.pause()
                    if not db.query(TorrentRecord).filter(TorrentRecord.info_hash == ih).first():
                        db.add(TorrentRecord(info_hash=ih, name=info.name(),
                                             save_path=save_dir, destination=def_storage,
                                             category=category))
                    added += 1
                    fire_webhook("added", {"info_hash": ih, "name": info.name()})
                except Exception as e:
                    log.warning(f"qbt_api add torrent file failed: {e}")
        db.commit()
    finally:
        db.close()

    if added == 0:
        return PlainTextResponse("Fails.", status_code=415)
    return PlainTextResponse("Ok.")


@qbt_router.post("/torrents/delete")
async def qbt_delete_torrents(_=Depends(_qbt_auth),
                               hashes: str = Form(""), deleteFiles: str = Form("false")):
    targets = _resolve_hashes(hashes)
    delete_files = deleteFiles.lower() in ("true", "1")
    db = SessionLocal()
    try:
        for ih in targets:
            try:
                h = active_handles.get(ih)
                torrent_name = h.name() if h else ih
                if h:
                    ses.remove_torrent(h, int(delete_files))
                    with _handles_lock:
                        active_handles.pop(ih, None)
                rec = db.query(TorrentRecord).filter(TorrentRecord.info_hash == ih).first()
                _uploaded_hashes.discard(ih)
                if rec:
                    torrent_name = rec.name or torrent_name
                    db.delete(rec)
                fire_webhook("removed", {"info_hash": ih, "name": torrent_name})
            except Exception as e:
                log.warning(f"qbt_api delete {ih}: {e}")
        db.commit()
    finally:
        db.close()
    return PlainTextResponse("Ok." if targets else "Fails.")


@qbt_router.post("/torrents/pause")
async def qbt_pause_torrents(_=Depends(_qbt_auth), hashes: str = Form("")):
    targets = _resolve_hashes(hashes)
    for ih in targets:
        h = active_handles.get(ih)
        if h:
            try:
                h.pause()
            except Exception:
                pass
    return PlainTextResponse("Ok.")


@qbt_router.post("/torrents/resume")
async def qbt_resume_torrents(_=Depends(_qbt_auth), hashes: str = Form("")):
    targets = _resolve_hashes(hashes)
    for ih in targets:
        h = active_handles.get(ih)
        if h:
            try:
                h.resume()
            except Exception:
                pass
    return PlainTextResponse("Ok.")


@qbt_router.post("/torrents/setCategory")
async def qbt_set_category(_=Depends(_qbt_auth),
                            hashes: str = Form(""), category: str = Form("")):
    targets = _resolve_hashes(hashes)
    db = SessionLocal()
    try:
        for ih in targets:
            rec = db.query(TorrentRecord).filter(TorrentRecord.info_hash == ih).first()
            if rec:
                rec.category = category
        db.commit()
    finally:
        db.close()
    return PlainTextResponse("Ok.")


@qbt_router.post("/torrents/setShareLimits")
async def qbt_set_share_limits(_=Depends(_qbt_auth),
                                hashes: str = Form(""),
                                ratioLimit: float = Form(-2),
                                seedingTimeLimit: int = Form(-2)):
    targets = _resolve_hashes(hashes)
    for ih in targets:
        _share_limits[ih.lower()] = {
            "ratio_limit": ratioLimit,
            "seeding_time_limit": seedingTimeLimit,
        }
    return PlainTextResponse("Ok.")


@qbt_router.post("/torrents/topPrio")
async def qbt_top_prio(_=Depends(_qbt_auth), hashes: str = Form("")):
    return PlainTextResponse("Ok.")


@qbt_router.post("/torrents/bottomPrio")
async def qbt_bottom_prio(_=Depends(_qbt_auth), hashes: str = Form("")):
    return PlainTextResponse("Ok.")


@qbt_router.post("/torrents/setForceStart")
async def qbt_set_force_start(_=Depends(_qbt_auth),
                                hashes: str = Form(""), value: str = Form("false")):
    if value.lower() in ("true", "1"):
        targets = _resolve_hashes(hashes)
        for ih in targets:
            h = active_handles.get(ih)
            if h:
                try:
                    h.resume()
                    h.set_flags(h.flags() & ~lt.torrent_flags.auto_managed)
                except Exception:
                    try:
                        h.resume()
                    except Exception:
                        pass
    return PlainTextResponse("Ok.")


@qbt_router.post("/torrents/recheck")
async def qbt_recheck(_=Depends(_qbt_auth), hashes: str = Form("")):
    targets = _resolve_hashes(hashes)
    for ih in targets:
        h = active_handles.get(ih)
        if h:
            try:
                h.force_recheck()
            except Exception:
                pass
    return PlainTextResponse("Ok.")


@qbt_router.post("/torrents/reannounce")
async def qbt_reannounce(_=Depends(_qbt_auth), hashes: str = Form("")):
    targets = _resolve_hashes(hashes)
    for ih in targets:
        h = active_handles.get(ih)
        if h:
            try:
                h.force_reannounce()
            except Exception:
                pass
    return PlainTextResponse("Ok.")


# ═══════════════ CATEGORIES ═══════════════

@qbt_router.get("/torrents/categories")
async def qbt_categories(_=Depends(_qbt_auth)):
    db = SessionLocal()
    try:
        cats = db.query(Category).all()
        return {c.name: {"name": c.name, "savePath": ""} for c in cats}
    finally:
        db.close()


@qbt_router.post("/torrents/createCategory")
async def qbt_create_category(_=Depends(_qbt_auth),
                               category: str = Form(""), savePath: str = Form("")):
    if not category.strip():
        return PlainTextResponse("Fails.")
    db = SessionLocal()
    try:
        existing = db.query(Category).filter(Category.name == category.strip()).first()
        if not existing:
            db.add(Category(name=category.strip(), color="#8b5cf6"))
            db.commit()
            log.info(f"qbt_api: created category '{category.strip()}'")
    finally:
        db.close()
    return PlainTextResponse("Ok.")


@qbt_router.post("/torrents/editCategory")
async def qbt_edit_category(_=Depends(_qbt_auth),
                             category: str = Form(""), savePath: str = Form("")):
    return PlainTextResponse("Ok.")


@qbt_router.post("/torrents/removeCategories")
async def qbt_remove_categories(_=Depends(_qbt_auth),
                                 categories: str = Form("")):
    return PlainTextResponse("Ok.")


# ═══════════════ TAGS (stubs) ═══════════════

@qbt_router.get("/torrents/tags")
async def qbt_tags(_=Depends(_qbt_auth)):
    return []


@qbt_router.post("/torrents/addTags")
async def qbt_add_tags(_=Depends(_qbt_auth)):
    return PlainTextResponse("Ok.")


@qbt_router.post("/torrents/removeTags")
async def qbt_remove_tags(_=Depends(_qbt_auth)):
    return PlainTextResponse("Ok.")


# ═══════════════ TRANSFER INFO ═══════════════

@qbt_router.get("/transfer/info")
async def qbt_transfer_info(_=Depends(_qbt_auth)):
    ss = ses.status()
    return {
        "dl_info_speed": int(ss.download_rate),
        "dl_info_data": int(ss.total_download),
        "up_info_speed": int(ss.upload_rate),
        "up_info_data": int(ss.total_upload),
        "dl_rate_limit": ses.get_settings().get("download_rate_limit", 0),
        "up_rate_limit": ses.get_settings().get("upload_rate_limit", 0),
        "dht_nodes": ss.dht_nodes,
        "connection_status": "connected",
    }


# ═══════════════ SYNC (Sonarr uses this) ═══════════════

@qbt_router.get("/sync/maindata")
async def qbt_sync_maindata(request: Request, _=Depends(_qbt_auth), rid: int = 0):
    """Simplified sync/maindata — returns full state each time (no delta)."""
    now_ts = time.time()
    recs = _get_records_map()
    torrents = {}
    for ih, h in list(active_handles.items()):
        try:
            rec = recs.get(ih)
            torrents[ih.lower()] = _torrent_to_qbt(ih, h, rec, now_ts)
        except Exception:
            pass

    db = SessionLocal()
    try:
        cats = db.query(Category).all()
        categories = {c.name: {"name": c.name, "savePath": ""} for c in cats}
    finally:
        db.close()

    ss = ses.status()
    return {
        "rid": rid + 1,
        "full_update": True,
        "torrents": torrents,
        "torrents_removed": [],
        "categories": categories,
        "tags": [],
        "server_state": {
            "dl_info_speed": int(ss.download_rate),
            "dl_info_data": int(ss.total_download),
            "up_info_speed": int(ss.upload_rate),
            "up_info_data": int(ss.total_upload),
            "dl_rate_limit": ses.get_settings().get("download_rate_limit", 0),
            "up_rate_limit": ses.get_settings().get("upload_rate_limit", 0),
            "dht_nodes": ss.dht_nodes,
            "connection_status": "connected",
            "free_space_on_disk": 0,
            "alltime_dl": int(ss.total_download),
            "alltime_ul": int(ss.total_upload),
        },
    }
