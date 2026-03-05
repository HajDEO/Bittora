"""
Bittora — Backend API Server
FastAPI + libtorrent + SQLite + WebSocket
Security: HttpOnly cookie JWT, rate limiting, security headers, RBAC
"""

import os
import re
import json
import time
import shutil
import socket
import ftplib
import subprocess
import secrets
import asyncio
import logging
import threading
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Annotated

import libtorrent as lt
from fastapi import (FastAPI, WebSocket, WebSocketDisconnect, HTTPException,
                     Depends, UploadFile, File, Form, Request, Response, status)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy import create_engine, Column, Integer, String, Boolean, Float, DateTime, JSON, Text, LargeBinary, event, text as sa_text
from sqlalchemy.orm import sessionmaker, declarative_base, Session
from concurrent.futures import ThreadPoolExecutor
from pydantic import BaseModel
import bcrypt
import jwt as pyjwt
from collections import defaultdict
from starlette.middleware.base import BaseHTTPMiddleware
import netifaces

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("bittora")

# ─── In-memory ring buffer for log viewer ───
from collections import deque

class RingBufferHandler(logging.Handler):
    def __init__(self, capacity=500):
        super().__init__()
        self.buffer = deque(maxlen=capacity)
    def emit(self, record):
        self.buffer.append({
            "ts": datetime.utcfromtimestamp(record.created).isoformat() + "Z",
            "level": record.levelname,
            "msg": self.format(record),
        })
    def get_logs(self):
        return list(self.buffer)

_log_buffer = RingBufferHandler(500)
_log_buffer.setFormatter(logging.Formatter("%(name)s: %(message)s"))
logging.getLogger().addHandler(_log_buffer)
log.addHandler(_log_buffer)

# ─── Config ───
DATA_DIR  = os.environ.get("BITTORA_DATA",      "/var/lib/bittora")
DL_DIR    = os.environ.get("BITTORA_DOWNLOADS", "/srv/bittora/downloads")
PORT      = int(os.environ.get("BITTORA_PORT",  "8080"))
SECRET    = os.environ.get("BITTORA_SECRET",    secrets.token_hex(32))
LANG      = os.environ.get("BITTORA_LANG",      "sk")
DB_PATH   = os.path.join(DATA_DIR, "bittora.db")
COOKIE    = "bittora_session"
SESS_H    = 24  # session hours

# ─── Thread pools for non-blocking I/O ───
_db_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="db")
_io_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="io")

Path(DATA_DIR).mkdir(parents=True, exist_ok=True)
Path(DL_DIR).mkdir(parents=True, exist_ok=True)
Path(os.path.join(DL_DIR, "incomplete")).mkdir(parents=True, exist_ok=True)

# ─── Database ───
Base = declarative_base()
engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False, "timeout": 15},
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=3,
)
SessionLocal = sessionmaker(bind=engine)

@event.listens_for(engine, "connect")
def _set_sqlite_wal(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.execute("PRAGMA cache_size=-8000")
    cursor.execute("PRAGMA wal_autocheckpoint=1000")
    cursor.close()

class User(Base):
    __tablename__ = "users"
    id            = Column(Integer, primary_key=True)
    username      = Column(String, unique=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role          = Column(String, default="user")
    perms         = Column(JSON, default=dict)
    active        = Column(Boolean, default=True)
    must_change_pw = Column(Boolean, default=False)
    created_at    = Column(DateTime, default=datetime.utcnow)

class TorrentRecord(Base):
    __tablename__ = "torrents"
    id          = Column(Integer, primary_key=True)
    info_hash   = Column(String, unique=True)
    name        = Column(String)
    save_path   = Column(String)
    destination = Column(String, default="local")
    category    = Column(String, default="")
    added_at    = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)
    resume_data = Column(LargeBinary, nullable=True)
    magnet_uri  = Column(Text, nullable=True)

class Setting(Base):
    __tablename__ = "settings"
    id    = Column(Integer, primary_key=True)
    key   = Column(String, unique=True)
    value = Column(Text)

class Category(Base):
    __tablename__ = "categories"
    id    = Column(Integer, primary_key=True)
    name  = Column(String, unique=True)
    color = Column(String, default="#8b5cf6")

class Connection(Base):
    __tablename__ = "connections"
    id          = Column(Integer, primary_key=True)
    type        = Column(String)           # ftp | smb | nfs
    name        = Column(String)
    host        = Column(String)
    port        = Column(Integer, nullable=True)
    user        = Column(String, nullable=True)
    password    = Column(String, nullable=True)
    path        = Column(String, nullable=True)
    last_tested = Column(DateTime, nullable=True)
    online      = Column(Boolean, default=False)

class RssFeed(Base):
    __tablename__ = "rss_feeds"
    id         = Column(Integer, primary_key=True)
    url        = Column(String)
    name       = Column(String)
    auto_dl    = Column(Boolean, default=False)
    filter     = Column(String, default="")
    interval   = Column(Integer, default=30)
    last_check = Column(DateTime, nullable=True)
    matches    = Column(Integer, default=0)

Base.metadata.create_all(engine)

# ─── Auto-migrate new columns ───
def _auto_migrate():
    with engine.connect() as conn:
        # Check existing columns in torrents table
        cols = {row[1] for row in conn.execute(sa_text("PRAGMA table_info(torrents)"))}
        if "resume_data" not in cols:
            conn.execute(sa_text("ALTER TABLE torrents ADD COLUMN resume_data BLOB"))
            log.info("Migrated: added resume_data column")
        if "magnet_uri" not in cols:
            conn.execute(sa_text("ALTER TABLE torrents ADD COLUMN magnet_uri TEXT"))
            log.info("Migrated: added magnet_uri column")
        conn.commit()

_auto_migrate()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ─── Seed defaults ───
def init_defaults():
    db = SessionLocal()
    try:
        if not db.query(User).filter(User.username == "admin").first():
            pw = bcrypt.hashpw(b"admin", bcrypt.gensalt())
            db.add(User(
                username="admin",
                password_hash=pw.decode(),
                role="admin",
                perms={"download": True, "upload": True, "external": True, "webhook": True},
                must_change_pw=True,
            ))

        if not db.query(Category).first():
            for name, color in [("OS", "#8b5cf6"), ("Software", "#6366f1"), ("Media", "#10b981")]:
                db.add(Category(name=name, color=color))

        defaults = {
            "lang": LANG, "dark_mode": "true", "toast_notif": "true", "web_port": str(PORT),
            "sound_notif": "false", "auto_start": "true", "confirm_del": "true",
            "max_dl_speed": "0", "max_ul_speed": "0",
            "max_global_conn": "500", "max_per_torrent": "100",
            "listen_port": "6881", "upnp": "true", "utp": "true",
            "dht": "true", "pex": "true", "lpd": "true", "proxy_type": "none",
            "max_active_dl": "5", "max_active_seed": "5", "max_total": "10",
            "target_ratio": "2.0", "max_seed_time": "0", "auto_seed": "true",
            "seq_dl": "false", "first_last_piece": "true",
            "webhook_enabled": "false", "webhook_url": "", "webhook_secret": "false",
            "webhook_key": "",
            "webhook_events": '{"added":true,"progress":false,"completed":true,"error":true,"removed":false}',
            "sched_enabled": "false", "sched_alt_dl": "500", "sched_alt_ul": "100",
            "session_timeout": "1440", "force_encrypt": "false",
            "anon_mode": "false", "ip_filter": "false", "ip_filter_list": "",
            "net_interface": "",
            "net_bind_ip": "",
            "default_storage": "local",
            "auto_cleanup": "true",
            "download_dir": "",
            "sched_schedule": json.dumps([[False]*7 for _ in range(24)]),
            "qbt_api_enabled": "false",
        }
        for k, v in defaults.items():
            if not db.query(Setting).filter(Setting.key == k).first():
                db.add(Setting(key=k, value=v))
        db.commit()
    finally:
        db.close()

init_defaults()

_dl_dir_cache: dict[str, str] = {}  # B2f: in-memory cache for get_dl_dir

def _invalidate_dl_dir_cache():
    _dl_dir_cache.clear()

def _get_setting_val(db, key: str) -> str | None:
    """Read a single setting value from DB."""
    row = db.query(Setting).filter(Setting.key == key).first()
    return row.value if row else None

def get_dl_dir(destination: str = None) -> str:
    """Return download directory based on destination type.
    'custom'/'smb'/'nfs' → reads download_dir setting (mount point); everything else → DL_DIR."""
    if destination in ("custom", "smb", "nfs"):
        if "custom" in _dl_dir_cache:
            return _dl_dir_cache["custom"]
        db = SessionLocal()
        try:
            row = db.query(Setting).filter(
                Setting.key == "download_dir").first()
            if row and row.value and row.value.strip():
                p = row.value.strip()
                if os.path.isdir(p):
                    _dl_dir_cache["custom"] = p
                    return p
        except Exception:
            pass
        finally:
            db.close()
    return DL_DIR

# ─── libtorrent session ───
ses = lt.session()
active_handles: dict[str, lt.torrent_handle] = {}
_handles_lock = threading.Lock()  # guards active_handles in background threads

# B3: Performance tuning — safe for 4GB RAM (~64MB cache, 8MB write queue)
_perf_settings = {
    "cache_size": 4096,                    # 64 MB (vs 32 MB default)
    "max_queued_disk_bytes": 8 * 1024 * 1024,  # 8 MB (vs 1 MB default)
    "send_buffer_watermark": 1024 * 1024,  # 1 MB (vs 500 KB)
    "send_buffer_watermark_factor": 75,    # 75% (vs 50%)
    "send_buffer_low_watermark": 32 * 1024,  # 32 KB (vs 10 KB)
    "hashing_threads": 2,                  # (vs 1)
    "write_cache_line_size": 32,           # 512 KB writes (vs 256 KB)
    "optimistic_disk_retry": 30,           # 30s (vs 600s default)
}
# B1b: Alert mask — include resume data + performance warnings
try:
    _alert_mask = (
        lt.alert.category_t.error_notification
        | lt.alert.category_t.status_notification
        | lt.alert.category_t.storage_notification
        | lt.alert.category_t.performance_warning
    )
except AttributeError:
    # Older libtorrent versions
    _alert_mask = 0x1 | 0x2 | 0x20 | 0x200
_perf_settings["alert_mask"] = _alert_mask
ses.apply_settings(_perf_settings)
log.info(f"libtorrent perf settings applied: cache=64MB, write_queue=8MB")

def _safe_int(val, default: int = 0) -> int:
    """Convert string/float to int safely, returning default on any error."""
    try:
        return int(float(str(val).strip() or default))
    except (ValueError, TypeError):
        return default

def apply_settings_to_session(data: dict):
    """Apply stored settings dict to the libtorrent session.
    Uses partial settings dict to avoid resetting listen_interfaces
    or other settings that could disrupt active connections."""
    try:
        ss: dict = {}
        # Speed limits: stored KB/s, libtorrent needs bytes/s (0 = unlimited)
        dl = _safe_int(data.get("max_dl_speed", "0"))
        ul = _safe_int(data.get("max_ul_speed", "0"))
        ss["download_rate_limit"] = dl * 1024 if dl > 0 else 0
        ss["upload_rate_limit"]   = ul * 1024 if ul > 0 else 0
        # Connections
        ss["connections_limit"] = _safe_int(data.get("max_global_conn", "500"), 500)
        # Per-torrent connection limit (applied to active handles)
        per_torrent = _safe_int(data.get("max_per_torrent", "100"), 100)
        if per_torrent > 0:
            for h in list(active_handles.values()):
                try: h.set_max_connections(per_torrent)
                except: pass
        # Protocol toggles
        ss["enable_dht"]    = data.get("dht",  "true") == "true"
        ss["enable_lsd"]    = data.get("lpd",  "true") == "true"
        ss["enable_upnp"]   = data.get("upnp", "true") == "true"
        ss["enable_natpmp"] = data.get("upnp", "true") == "true"
        for key in ("enable_incoming_utp", "enable_outgoing_utp"):
            try: ss[key] = data.get("utp", "true") == "true"
            except: pass
        # Active torrent limits
        ss["active_downloads"] = _safe_int(data.get("max_active_dl",   "5"), 5)
        ss["active_seeds"]     = _safe_int(data.get("max_active_seed", "5"), 5)
        ss["active_limit"]     = _safe_int(data.get("max_total",       "10"), 10)
        # Security
        try: ss["anonymous_mode"] = data.get("anon_mode", "false") == "true"
        except: pass
        enc = 0 if data.get("force_encrypt", "false") == "true" else 1
        try: ss["out_enc_policy"] = enc; ss["in_enc_policy"] = enc
        except: pass
        # Listen port + network interface binding
        try:
            port = _safe_int(data.get("listen_port", "6881"), 6881)
            iface = (data.get("net_interface") or "").strip()
            bind_ip = (data.get("net_bind_ip") or "").strip()
            # Validate bind_ip
            if bind_ip:
                try:
                    socket.inet_pton(socket.AF_INET, bind_ip)
                except Exception:
                    try:
                        socket.inet_pton(socket.AF_INET6, bind_ip)
                    except Exception:
                        bind_ip = ""
            # listen_interfaces
            if bind_ip:
                if ":" in bind_ip:
                    new_listen = f"[{bind_ip}]:{port}"
                else:
                    new_listen = f"{bind_ip}:{port}"
            elif iface:
                new_listen = f"{iface}:{port}"
            else:
                new_listen = f"0.0.0.0:{port},[::]:{port}"
            cur = ses.get_settings().get("listen_interfaces", "")
            if new_listen != cur:
                ss["listen_interfaces"] = new_listen
            # outgoing_interfaces
            if iface:
                ss["outgoing_interfaces"] = iface
            elif bind_ip:
                ss["outgoing_interfaces"] = bind_ip
            else:
                ss["outgoing_interfaces"] = ""
        except Exception:
            pass
        ses.apply_settings(ss)
        log.info("libtorrent settings applied from DB")
    except Exception as e:
        log.error(f"apply_settings_to_session error: {e}")

def load_and_apply_settings():
    db = SessionLocal()
    try:
        rows = {r.key: r.value for r in db.query(Setting).all()}
        apply_settings_to_session(rows)
    finally:
        db.close()

load_and_apply_settings()

# ─── Simple in-memory rate limiter ───
_login_attempts: dict[str, list] = defaultdict(list)

def check_rate_limit(ip: str, max_attempts: int = 10, window: int = 60) -> bool:
    """Returns True if allowed, False if rate limited."""
    now = datetime.utcnow().timestamp()
    attempts = [t for t in _login_attempts[ip] if now - t < window]
    _login_attempts[ip] = attempts
    if len(attempts) >= max_attempts:
        return False
    _login_attempts[ip].append(now)
    return True

# ─── FastAPI app ───
app = FastAPI(title="Bittora", version="1.01-beta", docs_url=None, redoc_url=None)

# Security headers
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        resp = await call_next(request)
        resp.headers["X-Content-Type-Options"]  = "nosniff"
        resp.headers["X-Frame-Options"]          = "DENY"
        resp.headers["X-XSS-Protection"]         = "1; mode=block"
        resp.headers["Referrer-Policy"]          = "strict-origin-when-cross-origin"
        resp.headers["Permissions-Policy"]       = "geolocation=(), microphone=(), camera=()"
        return resp

app.add_middleware(SecurityHeadersMiddleware)

# CORS — only needed when Vite dev server is used (different port)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://localhost:{PORT}",
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        f"http://127.0.0.1:{PORT}",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Auth helpers ───
def create_token(username: str, role: str) -> str:
    exp = datetime.utcnow() + timedelta(hours=SESS_H)
    return pyjwt.encode({"sub": username, "role": role, "exp": exp}, SECRET, algorithm="HS256")

def verify_token(token: str) -> Optional[dict]:
    try:
        return pyjwt.decode(token, SECRET, algorithms=["HS256"])
    except Exception:
        return None

def set_session_cookie(response: Response, token: str):
    response.set_cookie(
        key=COOKIE, value=token,
        httponly=True, samesite="lax",
        secure=False,  # set True in HTTPS production
        max_age=SESS_H * 3600, path="/",
    )

def clear_session_cookie(response: Response):
    response.delete_cookie(key=COOKIE, path="/", samesite="lax")

def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = verify_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Session expired")
    user = db.query(User).filter(User.username == payload["sub"], User.active == True).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin required")
    return user

CurrentUser = Annotated[User, Depends(get_current_user)]
AdminUser   = Annotated[User, Depends(require_admin)]

# ─── Pydantic schemas ───
class LoginForm(BaseModel):
    username: str
    password: str

class ChangePasswordForm(BaseModel):
    current_password: str
    new_password: str

class CreateUserForm(BaseModel):
    username: str
    password: str
    perms: dict = {}

class UpdateUserForm(BaseModel):
    role:   Optional[str]  = None
    perms:  Optional[dict] = None
    active: Optional[bool] = None

class CategoryForm(BaseModel):
    name:  str
    color: str = "#8b5cf6"

class ConnectionForm(BaseModel):
    type:     str
    name:     str
    host:     str
    port:     Optional[int]  = None
    user:     Optional[str]  = None
    password: Optional[str]  = None
    path:     Optional[str]  = None

class RssFeedForm(BaseModel):
    url:      str
    name:     str
    auto_dl:  bool = False
    filter:   str  = ""
    interval: int  = 30

class SettingsForm(BaseModel):
    data: dict

class TorrentLimitsForm(BaseModel):
    download_limit: int = 0  # KB/s; 0 = remove per-torrent limit (use session)
    upload_limit:   int = 0

# ─── Torrent state helper ───
def torrent_state(h: lt.torrent_handle) -> str:
    s = h.status()
    if s.paused:
        return "paused"
    state_map = {
        lt.torrent_status.downloading:         "downloading",
        lt.torrent_status.seeding:             "completed",
        lt.torrent_status.finished:            "completed",
        lt.torrent_status.checking_files:      "queued",
        lt.torrent_status.downloading_metadata:"queued",
        lt.torrent_status.allocating:          "queued",
        lt.torrent_status.checking_resume_data:"queued",
    }
    st = state_map.get(s.state, "queued")
    if s.progress >= 1.0:
        st = "completed"
    return st

def _resolve_destination(rec) -> str:
    """Resolve 'custom' destination to smb/nfs based on save_path or active mounts."""
    d = rec.destination or "local"
    if d != "custom":
        return d
    sp = rec.save_path or ""
    if sp.startswith(MOUNT_BASE + "/"):
        # Check /proc/mounts for the actual filesystem type
        try:
            with open("/proc/mounts", "r") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) >= 3 and parts[1] == sp.rstrip("/"):
                        return "smb" if parts[2] == "cifs" else "nfs" if parts[2] == "nfs" else d
                    # Also check parent path
                    if len(parts) >= 3 and sp.startswith(parts[1] + "/"):
                        return "smb" if parts[2] == "cifs" else "nfs" if parts[2] == "nfs" else d
        except Exception:
            pass
    return d

def torrent_dict(ih: str, h: lt.torrent_handle, rec=None) -> dict:
    s = h.status()
    dl  = round(s.download_rate / 1024 / 1024, 2)
    ul  = round(s.upload_rate  / 1024 / 1024, 2)
    eta = int((s.total_wanted - s.total_done) / s.download_rate) if s.download_rate > 0 else -1
    ratio = round(s.all_time_upload / s.all_time_download, 2) if s.all_time_download > 0 else 0
    return {
        "info_hash":     ih,
        "name":          h.name() or (rec.name if rec else "Unknown"),
        "progress":      round(s.progress * 100, 2),
        "download_rate": dl,
        "upload_rate":   ul,
        "num_seeds":     s.num_seeds,
        "num_peers":     s.num_peers,
        "state":         torrent_state(h),
        "total_size":    s.total_wanted,
        "total_done":    s.total_done,
        "eta":           eta,
        "ratio":         ratio,
        "destination":   _resolve_destination(rec) if rec else "local",
        "category":      rec.category    if rec else "",
        "added_at":      rec.added_at.isoformat() if rec else None,
        "download_limit": max(h.download_limit(), 0) // 1024,  # KB/s; -1→0
        "upload_limit":   max(h.upload_limit(),   0) // 1024,
    }

# ═══════════════════════════ AUTH ═══════════════════════════

@app.post("/api/auth/login")
async def login(request: Request, response: Response, form: LoginForm,
                db: Session = Depends(get_db)):
    ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(ip):
        raise HTTPException(status_code=429, detail="Too many login attempts. Try again later.")
    user = db.query(User).filter(User.username == form.username,
                                  User.active == True).first()
    if not user or not bcrypt.checkpw(form.password.encode(),
                                       user.password_hash.encode()):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_token(user.username, user.role)
    set_session_cookie(response, token)
    return {
        "username":      user.username,
        "role":          user.role,
        "perms":         user.perms,
        "must_change_pw": user.must_change_pw,
    }

@app.post("/api/auth/logout")
async def logout(response: Response):
    clear_session_cookie(response)
    return {"ok": True}

@app.get("/api/auth/status")
async def auth_status(db: Session = Depends(get_db)):
    """Public endpoint: returns whether default admin (must_change_pw) still exists."""
    has_default = db.query(User).filter(
        User.username == "admin", User.must_change_pw == True
    ).first() is not None
    return {"show_default_creds": has_default}

@app.get("/api/auth/me")
async def me(user: CurrentUser):
    return {
        "username":      user.username,
        "role":          user.role,
        "perms":         user.perms,
        "must_change_pw": user.must_change_pw,
    }

@app.post("/api/auth/change-password")
async def change_password(form: ChangePasswordForm, user: CurrentUser,
                          response: Response, db: Session = Depends(get_db)):
    if not user.must_change_pw:
        if not bcrypt.checkpw(form.current_password.encode(),
                               user.password_hash.encode()):
            raise HTTPException(status_code=400, detail="Current password is incorrect")
    if len(form.new_password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters")
    db_user = db.query(User).filter(User.id == user.id).first()
    db_user.password_hash = bcrypt.hashpw(form.new_password.encode(),
                                           bcrypt.gensalt()).decode()
    db_user.must_change_pw = False
    db.commit()
    token = create_token(user.username, user.role)
    set_session_cookie(response, token)
    return {"ok": True}

# ═══════════════════════════ WEBHOOKS ═══════════════════════════

def _send_webhook_bg(url: str, key: str, payload: dict):
    """Send outgoing webhook in a background thread."""
    def _send():
        try:
            body = json.dumps(payload).encode()
            req = urllib.request.Request(url, data=body, method="POST")
            req.add_header("Content-Type", "application/json")
            req.add_header("User-Agent", "Bittora/1.0")
            if key:
                req.add_header("X-API-Key", key)
            with urllib.request.urlopen(req, timeout=10) as r:
                log.info(f"Webhook → {url}: {r.status}")
        except Exception as e:
            log.warning(f"Webhook failed ({url}): {e}")
    threading.Thread(target=_send, daemon=True).start()

def fire_webhook(event: str, data: dict):
    """Fire outgoing webhook if enabled and event is subscribed.
    Entire DB read + HTTP send runs in a daemon thread (B2d)."""
    def _fire():
        db = SessionLocal()
        try:
            rows = {r.key: r.value for r in db.query(Setting).all()}
            if rows.get("webhook_enabled") != "true":
                return
            url = rows.get("webhook_url", "")
            if not url:
                return
            try:
                events = json.loads(rows.get("webhook_events", "{}"))
            except Exception:
                events = {}
            if not events.get(event, False):
                return
            use_key = rows.get("webhook_secret") == "true"
            key = rows.get("webhook_key", "") if use_key else ""
            payload = {"event": event, "timestamp": datetime.utcnow().isoformat(), **data}
            _send_webhook_bg(url, key, payload)
        finally:
            db.close()
    threading.Thread(target=_fire, daemon=True).start()

# ═══════════════════════════ FTP/SMB UPLOAD ON COMPLETION ═══════

_uploaded_hashes: set[str] = set()   # already-uploaded info hashes

def _ftp_mkd_recursive(ftp, path):
    """Create remote directory tree, creating missing dirs as needed."""
    dirs = path.strip("/").split("/")
    for d in dirs:
        if not d:
            continue
        try:
            ftp.cwd(d)
        except ftplib.all_errors:
            ftp.mkd(d)
            ftp.cwd(d)

def _upload_to_ftp_blocking(host, port, user, password, remote_path, local_path):
    """Upload a file or directory tree to FTP. Runs in executor."""
    ftp = ftplib.FTP()
    try:
        ftp.connect(host, port or 21, timeout=30)
        if user:
            ftp.login(user, password or "")
        else:
            ftp.login()
        if remote_path:
            _ftp_mkd_recursive(ftp, remote_path)

        if os.path.isfile(local_path):
            fname = os.path.basename(local_path)
            with open(local_path, "rb") as f:
                ftp.storbinary(f"STOR {fname}", f)
        elif os.path.isdir(local_path):
            start_dir = ftp.pwd()
            base = os.path.basename(local_path)
            for root, dirs, files in os.walk(local_path):
                rel = os.path.relpath(root, local_path)
                # navigate to correct remote subdir
                ftp.cwd(start_dir)
                target = base if rel == "." else f"{base}/{rel}"
                _ftp_mkd_recursive(ftp, target)
                for fname in files:
                    local_file = os.path.join(root, fname)
                    with open(local_file, "rb") as f:
                        ftp.storbinary(f"STOR {fname}", f)
        ftp.quit()
        return True, None
    except Exception as e:
        err = str(e)
        if "550" in err or "553" in err:
            err = (f"Permission denied on FTP server ({err}). "
                   f"Check that user has write access to '{remote_path or '/'}'.")
        return False, err
    finally:
        try:
            ftp.close()
        except Exception:
            pass

def _delete_from_ftp_blocking(host, port, user, password, remote_path, name):
    """Delete a file or directory from FTP. Runs in executor."""
    ftp = ftplib.FTP()
    try:
        ftp.connect(host, port or 21, timeout=15)
        if user:
            ftp.login(user, password or "")
        else:
            ftp.login()
        if remote_path:
            ftp.cwd(remote_path)
        # try to delete as file first
        try:
            ftp.delete(name)
            ftp.quit()
            return True, None
        except ftplib.all_errors:
            pass
        # must be a directory — recursive delete
        def _rmd_recursive(ftp_conn, path):
            items = []
            ftp_conn.dir(path, items.append)
            for item in items:
                parts = item.split(None, 8)
                if len(parts) < 9:
                    continue
                fname = parts[8]
                if fname in (".", ".."):
                    continue
                full = f"{path}/{fname}"
                if item.startswith("d"):
                    _rmd_recursive(ftp_conn, full)
                else:
                    ftp_conn.delete(full)
            ftp_conn.rmd(path)
        _rmd_recursive(ftp, name)
        ftp.quit()
        return True, None
    except Exception as e:
        return False, str(e)
    finally:
        try:
            ftp.close()
        except Exception:
            pass

def _completion_check_blocking(completed_items: list[tuple[str, str]]):
    """Process completed torrents: DB update, FTP upload, cleanup. Runs in thread (B2c)."""
    for ih, torrent_name in completed_items:
        if ih in _uploaded_hashes:
            continue
        db = SessionLocal()
        try:
            rec = db.query(TorrentRecord).filter(
                TorrentRecord.info_hash == ih).first()
            if not rec or rec.destination in ("local", "custom"):
                _uploaded_hashes.add(ih)
                if rec and not rec.completed_at:
                    rec.completed_at = datetime.utcnow()
                    db.commit()
                    fire_webhook("completed", {
                        "info_hash": ih, "name": rec.name})
                continue
            if rec.completed_at:
                _uploaded_hashes.add(ih)
                continue
            conn = db.query(Connection).filter(
                Connection.type == rec.destination).first()
            if not conn:
                log.warning(f"No {rec.destination} connection for "
                            f"torrent {rec.name}, skipping upload")
                _uploaded_hashes.add(ih)
                rec.completed_at = datetime.utcnow()
                db.commit()
                fire_webhook("completed", {
                    "info_hash": ih, "name": rec.name})
                continue
            local_path = os.path.join(
                rec.save_path, torrent_name) if torrent_name else rec.save_path
            if not os.path.exists(local_path):
                local_path = rec.save_path
            if conn.type == "ftp" and not (conn.path and conn.path.strip()):
                log.error(
                    f"FTP upload skipped for '{rec.name}': "
                    f"no remote path on connection '{conn.name}'. "
                    f"Set a writable path in Settings > Storage.")
                fire_webhook("error", {
                    "info_hash": ih, "name": rec.name,
                    "error": f"FTP '{conn.name}' has no remote path"})
                _uploaded_hashes.add(ih)
                rec.completed_at = datetime.utcnow()
                db.commit()
                continue
            log.info(f"Uploading '{rec.name}' to "
                     f"{conn.type}://{conn.host}{conn.path or ''} ...")
            ok, err = False, None
            if conn.type == "ftp":
                ok, err = _upload_to_ftp_blocking(
                    conn.host, conn.port, conn.user,
                    conn.password, conn.path, local_path)
                if ok:
                    log.info(f"FTP upload done: {rec.name}")
                else:
                    log.error(f"FTP upload failed for {rec.name}: {err}")
                    fire_webhook("error", {
                        "info_hash": ih, "name": rec.name,
                        "error": f"FTP upload failed: {err}"})
            _uploaded_hashes.add(ih)
            rec.completed_at = datetime.utcnow()
            db.commit()
            fire_webhook("completed", {
                "info_hash": ih, "name": rec.name})
            if ok:
                try:
                    ac = db.query(Setting).filter(
                        Setting.key == "auto_cleanup").first()
                    if ac and ac.value == "true":
                        with _handles_lock:
                            if ih in active_handles:
                                ses.remove_torrent(active_handles[ih], 0)
                                del active_handles[ih]
                        if os.path.isdir(local_path):
                            shutil.rmtree(local_path, ignore_errors=True)
                        elif os.path.isfile(local_path):
                            os.unlink(local_path)
                        log.info(f"Auto-cleanup: removed "
                                 f"'{rec.name}' from local disk")
                except Exception as ce:
                    log.error(f"Auto-cleanup error for '{rec.name}': {ce}")
        finally:
            db.close()


async def _completion_monitor():
    """Check for completed torrents and upload to FTP/SMB if needed."""
    while True:
        try:
            # Collect completed items on the event loop (fast, no I/O)
            completed = []
            for ih, h in list(active_handles.items()):
                if ih in _uploaded_hashes:
                    continue
                try:
                    s = h.status()
                    if s.progress >= 1.0 and s.state in (
                            lt.torrent_status.seeding, lt.torrent_status.finished):
                        completed.append((ih, h.name() or ""))
                except Exception:
                    pass
            # B2c: Run blocking DB + file I/O in thread
            if completed:
                await asyncio.to_thread(_completion_check_blocking, completed)
        except Exception as e:
            log.error(f"Completion monitor error: {e}")
        await asyncio.sleep(5)


# ═══════════════════════════ TORRENTS ═══════════════════════════

def _apply_trackers(h: lt.torrent_handle, trackers_str: str):
    """Add extra tracker URLs (newline-separated) to a torrent handle."""
    if not trackers_str:
        return
    for tier, url in enumerate(u.strip() for u in trackers_str.split("\n") if u.strip()):
        h.add_tracker({"url": url, "tier": tier})

_MIN_DISK_SPACE = 500 * 1024 * 1024  # C2: 500 MB minimum

def _check_disk_space(path: str) -> bool:
    """Return True if path has at least 500 MB free."""
    try:
        u = shutil.disk_usage(path)
        return u.free >= _MIN_DISK_SPACE
    except Exception:
        return True  # allow if we can't check

@app.post("/api/torrents/add")
async def add_torrent(user: CurrentUser, db: Session = Depends(get_db),
                      magnet: str = Form(None), file: UploadFile = File(None),
                      destination: str = Form("local"), category: str = Form(""),
                      trackers: str = Form("")):
    if not (user.role == "admin" or user.perms.get("upload")):
        raise HTTPException(status_code=403, detail="No upload permission")
    added = []
    dl_base = get_dl_dir(destination)
    # C2: Disk space guard
    if not _check_disk_space(dl_base):
        raise HTTPException(status_code=507, detail="Insufficient disk space (< 500 MB free)")
    # External mounts (smb/nfs/custom): save directly to root; local: use incomplete subdir
    if destination in ("smb", "nfs", "custom"):
        save_dir = dl_base
    else:
        save_dir = os.path.join(dl_base, "incomplete")
    os.makedirs(save_dir, exist_ok=True)
    if magnet:
        for m in [x.strip() for x in magnet.split("\n") if x.strip().startswith("magnet:")]:
            try:
                params = lt.parse_magnet_uri(m)
                params.save_path = save_dir
                h = ses.add_torrent(params)
                ih = str(h.info_hash())
                active_handles[ih] = h
                _apply_trackers(h, trackers)
                if not db.query(TorrentRecord).filter(TorrentRecord.info_hash == ih).first():
                    db.add(TorrentRecord(info_hash=ih, name=h.name() or "Unknown",
                                         save_path=save_dir,
                                         destination=destination, category=category,
                                         magnet_uri=m))
                added.append({"info_hash": ih, "name": h.name()})
                fire_webhook("added", {"info_hash": ih, "name": h.name() or "Unknown"})
            except Exception as e:
                log.error(f"Magnet error: {e}")
        db.commit()
    elif file:
        content = await file.read()
        try:
            info = lt.torrent_info(lt.bdecode(content))
            h = ses.add_torrent({"ti": info, "save_path": save_dir})
            ih = str(h.info_hash())
            active_handles[ih] = h
            _apply_trackers(h, trackers)
            if not db.query(TorrentRecord).filter(TorrentRecord.info_hash == ih).first():
                db.add(TorrentRecord(info_hash=ih, name=info.name(),
                                     save_path=save_dir,
                                     destination=destination, category=category))
                db.commit()
            added.append({"info_hash": ih, "name": info.name()})
            fire_webhook("added", {"info_hash": ih, "name": info.name()})
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid torrent: {e}")
    else:
        raise HTTPException(status_code=400, detail="Provide magnet or file")
    return added

@app.get("/api/torrents")
async def list_torrents(user: CurrentUser, db: Session = Depends(get_db)):
    recs = {r.info_hash: r for r in db.query(TorrentRecord).all()}
    return [torrent_dict(ih, h, recs.get(ih)) for ih, h in active_handles.items()]

@app.post("/api/torrents/{info_hash}/pause")
async def pause_torrent(info_hash: str, user: CurrentUser):
    if info_hash in active_handles:
        h = active_handles[info_hash]
        try:
            h.unset_flags(lt.torrent_flags.auto_managed)
        except AttributeError:
            pass
        h.pause()
    return {"ok": True}

@app.post("/api/torrents/{info_hash}/resume")
async def resume_torrent(info_hash: str, user: CurrentUser):
    if info_hash in active_handles:
        h = active_handles[info_hash]
        try:
            h.set_flags(lt.torrent_flags.auto_managed)
        except AttributeError:
            pass
        h.resume()
    return {"ok": True}

@app.delete("/api/torrents/{info_hash}")
async def remove_torrent(info_hash: str, user: CurrentUser,
                          delete_files: bool = False,
                          db: Session = Depends(get_db)):
    rec = db.query(TorrentRecord).filter(TorrentRecord.info_hash == info_hash).first()
    torrent_name = rec.name if rec else info_hash
    torrent_dest = rec.destination if rec else "local"
    h = active_handles.get(info_hash)
    t_name = h.name() if h else torrent_name
    if h:
        ses.remove_torrent(h, int(delete_files))
        del active_handles[info_hash]
    # also delete from remote storage
    if delete_files and torrent_dest in ("ftp", "smb") and t_name:
        conn = db.query(Connection).filter(
            Connection.type == torrent_dest).first()
        if conn and conn.type == "ftp" and conn.path and conn.path.strip():
            loop = asyncio.get_event_loop()
            ok, err = await loop.run_in_executor(
                None, _delete_from_ftp_blocking,
                conn.host, conn.port, conn.user,
                conn.password, conn.path, t_name)
            if ok:
                log.info(f"Deleted '{t_name}' from FTP {conn.host}")
            else:
                log.warning(f"FTP delete failed for '{t_name}': {err}")
    _uploaded_hashes.discard(info_hash)
    if rec:
        db.delete(rec)
        db.commit()
    fire_webhook("removed", {"info_hash": info_hash, "name": torrent_name})
    return {"ok": True}

@app.post("/api/torrents/{info_hash}/limits")
async def set_torrent_limits(info_hash: str, form: TorrentLimitsForm,
                              user: CurrentUser):
    if info_hash not in active_handles:
        raise HTTPException(status_code=404, detail="Torrent not found")
    h = active_handles[info_hash]
    # -1 = use session limit; >0 = per-torrent limit in bytes/s
    h.set_download_limit(form.download_limit * 1024 if form.download_limit > 0 else -1)
    h.set_upload_limit(form.upload_limit   * 1024 if form.upload_limit   > 0 else -1)
    return {"ok": True}

# ═══════════════════════════ USERS (admin) ═══════════════════════════

@app.get("/api/users")
async def list_users(user: AdminUser, db: Session = Depends(get_db)):
    users = db.query(User).all()
    return [{
        "id": u.id, "username": u.username, "role": u.role,
        "perms": u.perms, "active": u.active,
        "created_at": u.created_at.isoformat() if u.created_at else None,
    } for u in users]

@app.post("/api/users")
async def create_user(form: CreateUserForm, user: AdminUser,
                       db: Session = Depends(get_db)):
    if db.query(User).filter(User.username == form.username).first():
        raise HTTPException(status_code=409, detail="User already exists")
    if len(form.password) < 4:
        raise HTTPException(status_code=400, detail="Password too short")
    pw = bcrypt.hashpw(form.password.encode(), bcrypt.gensalt())
    perms = form.perms or {"download": True, "upload": False, "external": False, "webhook": False}
    u = User(username=form.username, password_hash=pw.decode(),
              role="user", perms=perms, must_change_pw=True)
    db.add(u)
    db.commit()
    return {"id": u.id, "username": u.username, "role": u.role}

@app.put("/api/users/{user_id}")
async def update_user(user_id: int, form: UpdateUserForm,
                       user: AdminUser, db: Session = Depends(get_db)):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.username == "admin" and form.role == "user":
        raise HTTPException(status_code=400, detail="Cannot demote admin user")
    if form.role   is not None: target.role   = form.role
    if form.perms  is not None: target.perms  = form.perms
    if form.active is not None: target.active = form.active
    db.commit()
    return {"ok": True}

@app.delete("/api/users/{user_id}")
async def delete_user(user_id: int, user: AdminUser,
                       db: Session = Depends(get_db)):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.username == "admin":
        raise HTTPException(status_code=400, detail="Cannot delete admin")
    db.delete(target)
    db.commit()
    return {"ok": True}

# ═══════════════════════════ NETWORK INTERFACES ═══════════════════════════

def _list_interfaces():
    result = []
    for name in netifaces.interfaces():
        addrs = netifaces.ifaddresses(name)
        ipv4 = [a["addr"] for a in addrs.get(netifaces.AF_INET, [])]
        ipv6 = [a["addr"].split("%")[0] for a in addrs.get(netifaces.AF_INET6, [])]
        result.append({"name": name, "ipv4": ipv4, "ipv6": ipv6})
    return result

@app.get("/api/network/interfaces")
async def get_network_interfaces(user: CurrentUser):
    return await asyncio.to_thread(_list_interfaces)

# ═══════════════════════════ SETTINGS ═══════════════════════════

@app.get("/api/settings")
async def get_settings(user: CurrentUser, db: Session = Depends(get_db)):
    rows = db.query(Setting).all()
    return {r.key: r.value for r in rows}

@app.post("/api/settings")
async def save_settings(form: SettingsForm, user: AdminUser,
                         db: Session = Depends(get_db)):
    try:
        for k, v in form.data.items():
            val = str(v).strip() if v is not None else ""
            row = db.query(Setting).filter(Setting.key == k).first()
            if row:
                row.value = val
            else:
                db.add(Setting(key=k, value=val))
        db.commit()
    except Exception as e:
        db.rollback()
        log.error(f"save_settings DB error: {e}")
        raise HTTPException(500, detail=f"DB error: {e}")
    _invalidate_dl_dir_cache()
    try:
        all_rows = {r.key: r.value for r in db.query(Setting).all()}
        apply_settings_to_session(all_rows)
    except Exception as e:
        log.error(f"save_settings apply error: {e}")
    return {"ok": True}

def _test_path_blocking(path: str) -> dict:
    """Test if path exists and is writable (B2e). Runs in thread."""
    exists = os.path.isdir(path)
    writable = False
    if exists:
        test_file = os.path.join(path, ".bittora_write_test")
        try:
            with open(test_file, "w") as f:
                f.write("test")
            os.unlink(test_file)
            writable = True
        except Exception as e:
            return {"ok": False, "exists": True, "writable": False,
                    "error": str(e)}
    return {"ok": exists and writable, "exists": exists, "writable": writable}

@app.post("/api/settings/test-path")
async def test_path(user: AdminUser, data: dict):
    path = (data.get("path") or "").strip()
    if not path:
        return {"ok": False, "exists": False, "writable": False,
                "error": "Empty path"}
    return await asyncio.to_thread(_test_path_blocking, path)

@app.post("/api/settings/restart")
async def restart_service(user: AdminUser, db: Session = Depends(get_db)):
    """Restart the Bittora systemd service (requires sudoers rule)."""
    # Sync DB settings → config.json before restart
    try:
        cfg_path = "/opt/bittora/config.json"
        with open(cfg_path, "r") as f:
            cfg = json.load(f)
        rows = {r.key: r.value for r in db.query(Setting).all()}
        if rows.get("web_port"):
            cfg["port"] = int(rows["web_port"])
        if rows.get("lang"):
            cfg["lang"] = rows["lang"]
        # Write in-place (truncate) to avoid needing dir write permission
        with open(cfg_path, "r+") as f:
            f.seek(0)
            json.dump(cfg, f, indent=4)
            f.truncate()
        log.info(f"config.json synced: port={cfg.get('port')}")
    except Exception as e:
        log.warning(f"Failed to sync config.json: {e}")
    # Fire-and-forget: respond first, restart after short delay
    def _delayed_restart():
        import time
        time.sleep(0.5)
        subprocess.Popen(["sudo", "systemctl", "restart", "bittora"])
    threading.Thread(target=_delayed_restart, daemon=True).start()
    return {"ok": True}

MOUNT_BASE = "/mnt/bittora"

def _mount_blocking(conn_type, conn_host, conn_user, conn_password, conn_path, conn_id, conn_name):
    """Blocking mount operation (B2e). Runs in thread."""
    slug = re.sub(r'[^a-zA-Z0-9]', '-', conn_name).lower().strip('-') or f"conn-{conn_id}"
    mount_path = os.path.join(MOUNT_BASE, slug)
    try:
        r = subprocess.run(["sudo", "mkdir", "-p", mount_path],
                           capture_output=True, text=True, timeout=10)
        if r.returncode != 0:
            return {"ok": False, "error": f"mkdir failed: {r.stderr.strip()}"}
        if conn_type == "smb":
            share = conn_path or "share"
            opts = f"username={conn_user or 'guest'},password={conn_password or ''},uid=bittora,gid=bittora,file_mode=0775,dir_mode=0775"
            cmd = ["sudo", "mount", "-t", "cifs",
                   f"//{conn_host}/{share}", mount_path, "-o", opts]
        else:
            export = conn_path or "/export"
            cmd = ["sudo", "mount", "-t", "nfs",
                   f"{conn_host}:{export}", mount_path]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            return {"ok": False, "error": r.stderr.strip() or "Mount failed"}
        return {"ok": True, "mount_path": mount_path}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Mount timed out"}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.post("/api/settings/mount")
async def mount_connection(user: AdminUser, data: dict, db: Session = Depends(get_db)):
    """Mount an SMB/NFS connection via sudo mount."""
    conn_id = data.get("connection_id")
    if not conn_id:
        raise HTTPException(400, "connection_id required")
    conn = db.query(Connection).filter(Connection.id == conn_id).first()
    if not conn:
        raise HTTPException(404, "Connection not found")
    if conn.type not in ("smb", "nfs"):
        raise HTTPException(400, "Only SMB/NFS connections can be mounted")
    result = await asyncio.to_thread(
        _mount_blocking, conn.type, conn.host, conn.user,
        conn.password, conn.path, conn.id, conn.name)
    if result.get("ok"):
        mount_path = result["mount_path"]
        _invalidate_dl_dir_cache()
        for key, val in [("download_dir", mount_path), ("default_storage", "custom")]:
            row = db.query(Setting).filter(Setting.key == key).first()
            if row:
                row.value = val
            else:
                db.add(Setting(key=key, value=val))
        db.commit()
    return result

def _unmount_blocking(path: str) -> dict:
    """Blocking unmount (B2e). Runs in thread."""
    try:
        r = subprocess.run(["sudo", "umount", path],
                           capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            return {"ok": False, "error": r.stderr.strip() or "Unmount failed"}
        return {"ok": True}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Unmount timed out"}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.post("/api/settings/unmount")
async def unmount_path(user: AdminUser, data: dict, db: Session = Depends(get_db)):
    """Unmount a path under /mnt/bittora/."""
    path = (data.get("path") or "").strip()
    if not path or not path.startswith(MOUNT_BASE + "/"):
        raise HTTPException(400, "Invalid mount path")
    result = await asyncio.to_thread(_unmount_blocking, path)
    if result.get("ok"):
        _invalidate_dl_dir_cache()
        for key, val in [("download_dir", ""), ("default_storage", "local")]:
            row = db.query(Setting).filter(Setting.key == key).first()
            if row:
                row.value = val
        db.commit()
    return result

def _get_mounts_info():
    """Get disk usage for all mounts under /mnt/bittora/."""
    mounts = []
    if not os.path.isdir(MOUNT_BASE):
        return mounts
    # Parse /proc/mounts for reliable mount detection
    mounted = {}  # path -> (source, fstype)
    try:
        with open("/proc/mounts", "r") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 3 and parts[1].startswith(MOUNT_BASE + "/"):
                    mounted[parts[1]] = (parts[0], parts[2])
    except Exception:
        pass
    for path, (source, fstype) in mounted.items():
        try:
            u = shutil.disk_usage(path)
            mounts.append({
                "name": os.path.basename(path),
                "path": path,
                "source": source,
                "fstype": fstype,
                "total": u.total,
                "used": u.used,
                "free": u.free,
                "percent": round(u.used / u.total * 100, 1) if u.total else 0,
            })
        except Exception:
            pass
    return mounts

@app.get("/api/disk/mounts")
async def disk_mounts(user: CurrentUser):
    return _get_mounts_info()

@app.get("/api/webhook")
async def webhook_info(db: Session = Depends(get_db)):
    """Returns webhook info — prevents SPA from loading on GET /api/webhook."""
    rows = {r.key: r.value for r in db.query(Setting).all()}
    return {
        "endpoint": "/api/webhook",
        "method": "POST",
        "content_type": "application/json",
        "enabled": rows.get("webhook_enabled") == "true",
        "auth_required": rows.get("webhook_secret") == "true",
    }

@app.post("/api/webhook")
async def inbound_webhook(request: Request, db: Session = Depends(get_db)):
    """Inbound webhook — accepts commands from Home Assistant, Node-RED, etc.

    Supported actions (JSON body):
      {"action": "pause",   "info_hash": "<hash>"}
      {"action": "resume",  "info_hash": "<hash>"}
      {"action": "remove",  "info_hash": "<hash>", "delete_files": false}
      {"action": "add",     "magnet": "magnet:?...", "name": "optional"}
      {"action": "set_speed","download_limit": 512, "upload_limit": 256}  (KB/s)
      {"action": "status"}  → returns active torrent count + list
      (no action / unknown) → logged and acknowledged
    """
    rows = {r.key: r.value for r in db.query(Setting).all()}
    if rows.get("webhook_secret") == "true":
        expected = rows.get("webhook_key", "")
        received = request.headers.get("X-API-Key", "")
        if not expected or received != expected:
            raise HTTPException(status_code=403, detail="Invalid API key")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    action = (body.get("action") or "").strip().lower()
    log.info(f"Inbound webhook action={action!r} body={body}")

    if action == "pause":
        ih = body.get("info_hash", "")
        if ih in active_handles:
            h = active_handles[ih]
            try: h.unset_flags(lt.torrent_flags.auto_managed)
            except AttributeError: pass
            h.pause()
            return {"ok": True, "action": "pause", "info_hash": ih}
        raise HTTPException(status_code=404, detail="Torrent not found")

    if action == "resume":
        ih = body.get("info_hash", "")
        if ih in active_handles:
            h = active_handles[ih]
            try: h.set_flags(lt.torrent_flags.auto_managed)
            except AttributeError: pass
            h.resume()
            return {"ok": True, "action": "resume", "info_hash": ih}
        raise HTTPException(status_code=404, detail="Torrent not found")

    if action == "remove":
        ih = body.get("info_hash", "")
        delete_files = bool(body.get("delete_files", False))
        if ih in active_handles:
            ses.remove_torrent(active_handles[ih], int(delete_files))
            del active_handles[ih]
            rec = db.query(TorrentRecord).filter(TorrentRecord.info_hash == ih).first()
            if rec:
                db.delete(rec)
                db.commit()
            fire_webhook("removed", {"info_hash": ih, "name": ""})
            return {"ok": True, "action": "remove", "info_hash": ih}
        raise HTTPException(status_code=404, detail="Torrent not found")

    if action == "add":
        magnet = (body.get("magnet") or "").strip()
        if not magnet.startswith("magnet:"):
            raise HTTPException(status_code=400, detail="Missing or invalid magnet link")
        try:
            # Use default storage setting
            def_storage = _get_setting_val(db, "default_storage") or "local"
            wh_save_dir = get_dl_dir(def_storage)
            params = lt.parse_magnet_uri(magnet)
            params.save_path = wh_save_dir
            h = ses.add_torrent(params)
            ih = str(h.info_hash())
            active_handles[ih] = h
            name = body.get("name") or h.name() or "Unknown"
            if not db.query(TorrentRecord).filter(TorrentRecord.info_hash == ih).first():
                db.add(TorrentRecord(info_hash=ih, name=name, save_path=wh_save_dir,
                                     destination=def_storage))
                db.commit()
            fire_webhook("added", {"info_hash": ih, "name": name})
            return {"ok": True, "action": "add", "info_hash": ih, "name": name}
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to add torrent: {e}")

    if action == "set_speed":
        ss = ses.get_settings()
        if "download_limit" in body:
            dl = _safe_int(body["download_limit"])
            ss["download_rate_limit"] = dl * 1024 if dl > 0 else 0
        if "upload_limit" in body:
            ul = _safe_int(body["upload_limit"])
            ss["upload_rate_limit"] = ul * 1024 if ul > 0 else 0
        ses.apply_settings(ss)
        return {"ok": True, "action": "set_speed"}

    if action == "status":
        recs = {r.info_hash: r for r in db.query(TorrentRecord).all()}
        return {
            "ok": True,
            "active": len(active_handles),
            "torrents": [
                {"info_hash": ih, "name": h.name() or (recs[ih].name if ih in recs else ""),
                 "progress": round(h.status().progress * 100, 1)}
                for ih, h in active_handles.items()
            ],
        }

    # Unknown or empty action — just acknowledge
    return {"ok": True, "action": action or "logged"}

# ═══════════════════════════ CATEGORIES ═══════════════════════════

@app.get("/api/categories")
async def list_categories(user: CurrentUser, db: Session = Depends(get_db)):
    return [{"id": c.id, "name": c.name, "color": c.color}
            for c in db.query(Category).all()]

@app.post("/api/categories")
async def create_category(form: CategoryForm, user: AdminUser,
                           db: Session = Depends(get_db)):
    if db.query(Category).filter(Category.name == form.name).first():
        raise HTTPException(status_code=409, detail="Category exists")
    cat = Category(name=form.name, color=form.color)
    db.add(cat)
    db.commit()
    return {"id": cat.id, "name": cat.name, "color": cat.color}

@app.delete("/api/categories/{cat_id}")
async def delete_category(cat_id: int, user: AdminUser,
                           db: Session = Depends(get_db)):
    cat = db.query(Category).filter(Category.id == cat_id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(cat)
    db.commit()
    return {"ok": True}

# ═══════════════════════════ CONNECTIONS ═══════════════════════════

@app.get("/api/connections")
async def list_connections(user: CurrentUser, db: Session = Depends(get_db)):
    return [{
        "id": c.id, "type": c.type, "name": c.name, "host": c.host,
        "port": c.port, "user": c.user, "path": c.path,
        "online": c.online,
        "last_tested": c.last_tested.isoformat() if c.last_tested else None,
    } for c in db.query(Connection).all()]

@app.post("/api/connections")
async def create_connection(form: ConnectionForm, user: AdminUser,
                             db: Session = Depends(get_db)):
    conn = Connection(type=form.type, name=form.name, host=form.host,
                      port=form.port, user=form.user,
                      password=form.password, path=form.path)
    db.add(conn)
    db.commit()
    return {
        "id": conn.id, "type": conn.type, "name": conn.name,
        "host": conn.host, "port": conn.port, "user": conn.user,
        "path": conn.path, "online": conn.online, "last_tested": None,
    }

def _test_ftp_blocking(host, port, user, password, path):
    """Blocking FTP test — must run in executor, not on event loop."""
    ftp = ftplib.FTP()
    try:
        ftp.connect(host, port, timeout=10)
        if user:
            ftp.login(user, password or "")
        else:
            ftp.login()
        if path:
            ftp.cwd(path)
        # verify write permission with a tiny test file
        import io
        try:
            ftp.storbinary("STOR .bittora_write_test", io.BytesIO(b"ok"))
            ftp.delete(".bittora_write_test")
        except ftplib.all_errors as we:
            ftp.quit()
            return False, f"Connected OK but no write permission: {we}"
        ftp.quit()
        return True, None
    except Exception as e:
        return False, str(e)
    finally:
        try:
            ftp.close()
        except Exception:
            pass

def _test_smb_blocking(host, port, user=None, password=None, path=None):
    """Blocking SMB2/3 test with real authentication via smbprotocol."""
    import uuid
    from smbprotocol.connection import Connection as SmbConn
    from smbprotocol.session import Session
    from smbprotocol.tree import TreeConnect
    conn = None
    try:
        conn = SmbConn(uuid.uuid4(), host, port or 445)
        conn.connect(timeout=10)
        session = Session(conn, user or "guest", password or "")
        session.connect()
        if path and path.strip():
            tree = TreeConnect(session, f"\\\\{host}\\{path.strip()}")
            tree.connect()
            tree.disconnect()
        session.disconnect()
        return True, None
    except Exception as e:
        msg = str(e)
        if "STATUS_LOGON_FAILURE" in msg:
            return False, "Authentication failed — wrong username or password"
        if "STATUS_BAD_NETWORK_NAME" in msg:
            return False, f"Share '{path}' not found on server"
        if "STATUS_ACCESS_DENIED" in msg:
            return False, "Access denied"
        return False, msg
    finally:
        try:
            if conn:
                conn.disconnect()
        except Exception:
            pass


def _test_nfs_blocking(host, port=None, path=None):
    """Blocking NFS test — uses showmount, falls back to TCP port 2049."""
    try:
        cmd = ["showmount", "-e", host]
        result = subprocess.run(cmd, capture_output=True, text=True,
                                timeout=10)
        if result.returncode == 0:
            if path and path.strip():
                # verify the export exists
                exports = result.stdout
                if path.strip() in exports:
                    return True, None
                return False, f"Export '{path}' not found on {host}"
            return True, None
        return False, (result.stderr.strip() or "NFS not available")
    except FileNotFoundError:
        # showmount not installed — TCP port check
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.settimeout(10)
            s.connect((host, port or 2049))
            return True, "TCP OK (install nfs-common for full test)"
        except Exception as e:
            return False, str(e)
        finally:
            s.close()
    except subprocess.TimeoutExpired:
        return False, "Connection timed out"
    except Exception as e:
        return False, str(e)

@app.post("/api/connections/test-params")
async def test_connection_params(user: AdminUser, data: dict):
    """Test connection without saving — accepts {type, host, port, user, password, path}."""
    ctype = data.get("type", "ftp")
    host = data.get("host", "")
    def_port = 21 if ctype == "ftp" else (2049 if ctype == "nfs" else 445)
    port = int(data.get("port") or def_port)
    cuser = data.get("user") or None
    cpass = data.get("password") or None
    cpath = data.get("path") or None
    if not host:
        raise HTTPException(status_code=400, detail="Host required")
    loop = asyncio.get_event_loop()
    if ctype == "ftp":
        online, error_msg = await loop.run_in_executor(
            None, _test_ftp_blocking, host, port, cuser, cpass, cpath)
    elif ctype == "nfs":
        online, error_msg = await loop.run_in_executor(
            None, _test_nfs_blocking, host, port, cpath)
    else:
        online, error_msg = await loop.run_in_executor(
            None, _test_smb_blocking, host, port, cuser, cpass, cpath)
    return {"ok": online, "online": online, "error": error_msg}

@app.post("/api/connections/{conn_id}/test")
async def test_connection(conn_id: int, user: AdminUser,
                           db: Session = Depends(get_db)):
    conn = db.query(Connection).filter(Connection.id == conn_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Not found")
    loop = asyncio.get_event_loop()
    if conn.type == "ftp":
        online, error_msg = await loop.run_in_executor(
            None, _test_ftp_blocking, conn.host, conn.port or 21,
            conn.user, conn.password, conn.path)
    elif conn.type == "nfs":
        online, error_msg = await loop.run_in_executor(
            None, _test_nfs_blocking, conn.host, conn.port or 2049,
            conn.path)
    else:
        online, error_msg = await loop.run_in_executor(
            None, _test_smb_blocking, conn.host, conn.port or 445,
            conn.user, conn.password, conn.path)
    conn.online = online
    conn.last_tested = datetime.utcnow()
    db.commit()
    return {
        "ok": conn.online,
        "online": conn.online,
        "last_tested": conn.last_tested.isoformat(),
        "error": error_msg,
    }

@app.put("/api/connections/{conn_id}")
async def update_connection(conn_id: int, form: ConnectionForm,
                             user: AdminUser, db: Session = Depends(get_db)):
    conn = db.query(Connection).filter(Connection.id == conn_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Not found")
    conn.type = form.type
    conn.name = form.name
    conn.host = form.host
    conn.port = form.port
    conn.user = form.user
    conn.password = form.password
    conn.path = form.path
    db.commit()
    return {
        "id": conn.id, "type": conn.type, "name": conn.name,
        "host": conn.host, "port": conn.port, "user": conn.user,
        "path": conn.path, "online": conn.online,
        "last_tested": conn.last_tested.isoformat() if conn.last_tested else None,
    }

@app.delete("/api/connections/{conn_id}")
async def delete_connection(conn_id: int, user: AdminUser,
                             db: Session = Depends(get_db)):
    conn = db.query(Connection).filter(Connection.id == conn_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(conn)
    db.commit()
    return {"ok": True}

# ═══════════════════════════ RSS ═══════════════════════════

@app.get("/api/rss")
async def list_rss(user: CurrentUser, db: Session = Depends(get_db)):
    return [{
        "id": f.id, "url": f.url, "name": f.name, "auto_dl": f.auto_dl,
        "filter": f.filter, "interval": f.interval, "matches": f.matches,
        "last_check": f.last_check.isoformat() if f.last_check else None,
    } for f in db.query(RssFeed).all()]

@app.post("/api/rss")
async def create_rss(form: RssFeedForm, user: AdminUser,
                     db: Session = Depends(get_db)):
    feed = RssFeed(url=form.url, name=form.name, auto_dl=form.auto_dl,
                   filter=form.filter, interval=form.interval)
    db.add(feed)
    db.commit()
    return {"id": feed.id}

@app.delete("/api/rss/{feed_id}")
async def delete_rss(feed_id: int, user: AdminUser,
                     db: Session = Depends(get_db)):
    feed = db.query(RssFeed).filter(RssFeed.id == feed_id).first()
    if not feed:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(feed)
    db.commit()
    return {"ok": True}

# ═══════════════════════════ DISK ═══════════════════════════

def _disk_info_blocking() -> dict:
    """Collect disk usage info (B2e). Runs in thread."""
    try:
        u = shutil.disk_usage(DL_DIR)
        result = {
            "total":   u.total,
            "used":    u.used,
            "free":    u.free,
            "percent": round(u.used / u.total * 100, 1),
        }
    except Exception:
        result = {"total": 0, "used": 0, "free": 0, "percent": 0}
    result["mounts"] = _get_mounts_info()
    return result

@app.get("/api/disk")
async def disk_info(user: CurrentUser, db: Session = Depends(get_db)):
    return await asyncio.to_thread(_disk_info_blocking)

# ═══════════════════════════ LOGS ═══════════════════════════

@app.get("/api/logs")
async def get_logs(user: AdminUser):
    return _log_buffer.get_logs()

# ═══════════════════════════ BACKGROUND TASKS ═══════════════════════════

def _process_rss_feed(feed_id: int):
    """Fetch one RSS feed and auto-download matching torrents (runs in thread)."""
    db = SessionLocal()
    try:
        feed = db.query(RssFeed).filter(RssFeed.id == feed_id).first()
        if not feed:
            return
        try:
            req = urllib.request.Request(
                feed.url, headers={"User-Agent": "Bittora/1.0 RSS-Reader"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read()
        except Exception as e:
            log.warning(f"RSS fetch error ({feed.url}): {e}")
            feed.last_check = datetime.utcnow()
            db.commit()
            return
        try:
            root = ET.fromstring(raw)
        except ET.ParseError as e:
            log.warning(f"RSS parse error ({feed.url}): {e}")
            feed.last_check = datetime.utcnow()
            db.commit()
            return

        ns = {"atom": "http://www.w3.org/2005/Atom"}
        items = root.findall(".//item")
        if not items:
            items = root.findall(".//atom:entry", ns)

        filt_pat = None
        if feed.filter:
            try:
                filt_pat = re.compile(feed.filter, re.IGNORECASE)
            except re.error:
                pass

        new_matches = 0
        for item in items:
            title_el = item.find("title")
            title = (title_el.text or "").strip() if title_el is not None else ""
            if filt_pat and not filt_pat.search(title):
                continue
            new_matches += 1
            if not feed.auto_dl:
                continue

            # Find magnet link or .torrent URL in the item
            magnet = None
            link_el = item.find("link")
            enclosure_el = item.find("enclosure")
            if link_el is not None and link_el.text and link_el.text.strip().startswith("magnet:"):
                magnet = link_el.text.strip()
            if magnet is None and enclosure_el is not None:
                url = enclosure_el.get("url", "")
                if url.startswith("magnet:"):
                    magnet = url
            if magnet is None:
                for child in item:
                    if child.text and child.text.strip().startswith("magnet:"):
                        magnet = child.text.strip()
                        break
            if not magnet:
                continue

            # Check if already added
            inner_db = SessionLocal()
            try:
                try:
                    # Use default storage setting for RSS auto-downloads
                    def_storage = _get_setting_val(inner_db, "default_storage") or "local"
                    rss_save_dir = get_dl_dir(def_storage)
                    params = lt.parse_magnet_uri(magnet)
                    params.save_path = rss_save_dir
                    h = ses.add_torrent(params)
                    ih = str(h.info_hash())
                    active_handles[ih] = h
                    if not inner_db.query(TorrentRecord).filter(
                            TorrentRecord.info_hash == ih).first():
                        inner_db.add(TorrentRecord(
                            info_hash=ih, name=title, save_path=rss_save_dir,
                            destination=def_storage))
                        inner_db.commit()
                    log.info(f"RSS auto-dl: {title}")
                except Exception as e:
                    log.warning(f"RSS auto-dl failed ({title}): {e}")
            finally:
                inner_db.close()

        feed.last_check = datetime.utcnow()
        feed.matches = (feed.matches or 0) + new_matches
        db.commit()
    finally:
        db.close()


async def _rss_poller():
    """Background: poll RSS feeds at their configured intervals."""
    await asyncio.sleep(15)
    while True:
        try:
            db = SessionLocal()
            try:
                now = datetime.utcnow()
                feeds = db.query(RssFeed).all()
                due_ids = []
                for f in feeds:
                    elapsed = (now - f.last_check).total_seconds() if f.last_check else 9999
                    if elapsed >= (f.interval or 30) * 60:
                        due_ids.append(f.id)
            finally:
                db.close()
            loop = asyncio.get_event_loop()
            for fid in due_ids:
                await loop.run_in_executor(None, _process_rss_feed, fid)
        except Exception as e:
            log.error(f"RSS poller error: {e}")
        await asyncio.sleep(60)


def _apply_scheduler():
    """Apply speed limits based on current schedule (runs in thread)."""
    db = SessionLocal()
    try:
        rows = {r.key: r.value for r in db.query(Setting).all()}
        if rows.get("sched_enabled") != "true":
            return
        try:
            schedule = json.loads(rows.get("sched_schedule", "[]"))
        except Exception:
            return
        if not schedule or len(schedule) < 24:
            return
        now = datetime.utcnow()
        hour = now.hour
        weekday = now.weekday()  # 0=Mon, 6=Sun
        row = schedule[hour] if hour < len(schedule) else []
        is_limited = bool(row[weekday]) if weekday < len(row) else False
        ss: dict = {}
        if is_limited:
            alt_dl = _safe_int(rows.get("sched_alt_dl", "500"), 500)
            alt_ul = _safe_int(rows.get("sched_alt_ul", "100"), 100)
            ss["download_rate_limit"] = alt_dl * 1024
            ss["upload_rate_limit"]   = alt_ul * 1024
        else:
            dl = _safe_int(rows.get("max_dl_speed", "0"))
            ul = _safe_int(rows.get("max_ul_speed", "0"))
            ss["download_rate_limit"] = dl * 1024 if dl > 0 else 0
            ss["upload_rate_limit"]   = ul * 1024 if ul > 0 else 0
        ses.apply_settings(ss)
    finally:
        db.close()


async def _scheduler_task():
    """Background: check schedule every minute and apply limits."""
    await asyncio.sleep(30)
    while True:
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, _apply_scheduler)
        except Exception as e:
            log.error(f"Scheduler error: {e}")
        await asyncio.sleep(60)


_ws_clients: set[WebSocket] = set()


# ─── B1c: Periodic resume data save ───

def _save_resume_data_blocking():
    """Request save_resume_data for all handles, then process alerts."""
    pending = 0
    with _handles_lock:
        for ih, h in list(active_handles.items()):
            try:
                if h.is_valid():
                    h.save_resume_data()
                    pending += 1
            except Exception:
                pass
    if pending == 0:
        return
    # Process alerts (up to 30s)
    deadline = time.monotonic() + 30
    saved = 0
    while pending > 0 and time.monotonic() < deadline:
        alerts = ses.pop_alerts()
        for a in alerts:
            if isinstance(a, lt.save_resume_data_alert):
                try:
                    buf = lt.write_resume_data_buf(a.params)
                    ih = str(a.handle.info_hash())
                    db = SessionLocal()
                    try:
                        rec = db.query(TorrentRecord).filter(
                            TorrentRecord.info_hash == ih).first()
                        if rec:
                            rec.resume_data = bytes(buf)
                            db.commit()
                            saved += 1
                    finally:
                        db.close()
                except Exception as e:
                    log.warning(f"Save resume data error: {e}")
                pending -= 1
            elif isinstance(a, lt.save_resume_data_failed_alert):
                pending -= 1
        if pending > 0:
            time.sleep(0.1)
    if saved > 0:
        log.info(f"Resume data saved for {saved} torrents")


async def _save_resume_data():
    """Background: save resume data every 5 minutes."""
    await asyncio.sleep(60)
    while True:
        try:
            await asyncio.to_thread(_save_resume_data_blocking)
        except Exception as e:
            log.error(f"Resume data save error: {e}")
        await asyncio.sleep(300)


# ─── B1g: Alert processor (resume data + performance warnings) ───

async def _alert_processor():
    """Background: process libtorrent alerts every 2s."""
    while True:
        try:
            alerts = ses.pop_alerts()
            for a in alerts:
                if isinstance(a, lt.save_resume_data_alert):
                    try:
                        buf = lt.write_resume_data_buf(a.params)
                        ih = str(a.handle.info_hash())
                        db = SessionLocal()
                        try:
                            rec = db.query(TorrentRecord).filter(
                                TorrentRecord.info_hash == ih).first()
                            if rec:
                                rec.resume_data = bytes(buf)
                                db.commit()
                        finally:
                            db.close()
                    except Exception:
                        pass
                elif hasattr(a, 'category') and 'performance' in str(type(a).__name__).lower():
                    log.warning(f"libtorrent perf warning: {a.message()}")
        except Exception as e:
            log.error(f"Alert processor error: {e}")
        await asyncio.sleep(2)


# ─── B1d: Reload torrents from DB at startup ───

def _reload_torrents_from_db():
    """Reload active (non-completed) torrents from DB using resume data or magnet."""
    db = SessionLocal()
    try:
        recs = db.query(TorrentRecord).filter(
            TorrentRecord.completed_at == None  # noqa: E711
        ).all()
        loaded = 0
        for rec in recs:
            ih = rec.info_hash
            if ih in active_handles:
                continue
            # Auto-fix save_path for smb/nfs torrents that were saved to local dir
            if rec.destination in ("smb", "nfs", "custom"):
                correct_dir = get_dl_dir(rec.destination)
                if rec.save_path != correct_dir:
                    log.info(f"Fixing save_path for {rec.name}: {rec.save_path} → {correct_dir}")
                    rec.save_path = correct_dir
                    db.commit()
            try:
                h = None
                save_path = rec.save_path or DL_DIR
                # Priority 1: resume data
                if rec.resume_data:
                    try:
                        params = lt.read_resume_data(rec.resume_data)
                        params.save_path = save_path
                        h = ses.add_torrent(params)
                    except Exception as e:
                        log.warning(f"Resume data load failed for {rec.name}: {e}")
                        h = None
                # Priority 2: magnet URI
                if h is None and rec.magnet_uri:
                    try:
                        params = lt.parse_magnet_uri(rec.magnet_uri)
                        params.save_path = save_path
                        h = ses.add_torrent(params)
                    except Exception as e:
                        log.warning(f"Magnet reload failed for {rec.name}: {e}")
                        h = None
                # Priority 3: info_hash fallback (metadata-less, but tries DHT)
                if h is None and ih:
                    try:
                        magnet = f"magnet:?xt=urn:btih:{ih}"
                        params = lt.parse_magnet_uri(magnet)
                        params.save_path = save_path
                        h = ses.add_torrent(params)
                    except Exception as e:
                        log.warning(f"Hash fallback failed for {rec.name}: {e}")
                        continue
                if h:
                    with _handles_lock:
                        active_handles[str(h.info_hash())] = h
                    loaded += 1
            except Exception as e:
                log.error(f"Reload error for {rec.name}: {e}")
        if loaded > 0:
            log.info(f"Reloaded {loaded} torrents from DB")
    finally:
        db.close()


# ─── B2b: WS broadcast with DB in thread + C3: backpressure ───

def _build_ws_payload() -> dict:
    """Build WS broadcast payload (runs in thread to avoid blocking loop)."""
    db = SessionLocal()
    try:
        recs = {r.info_hash: r for r in db.query(TorrentRecord).all()}
    finally:
        db.close()
    torrents = []
    for ih, h in list(active_handles.items()):
        try:
            torrents.append(torrent_dict(ih, h, recs.get(ih)))
        except Exception:
            pass
    return {"type": "update", "torrents": torrents}


async def _ws_broadcast_loop():
    """Single loop broadcasting torrent state to all connected clients.
    One DB query per 2-second cycle regardless of client count."""
    while True:
        if _ws_clients:
            try:
                msg = await asyncio.to_thread(_build_ws_payload)
                dead: set[WebSocket] = set()
                for ws in list(_ws_clients):
                    try:
                        # C3: backpressure — disconnect slow clients after 5s
                        await asyncio.wait_for(ws.send_json(msg), timeout=5.0)
                    except Exception:
                        dead.add(ws)
                _ws_clients.difference_update(dead)
            except Exception as e:
                log.error(f"WS broadcast error: {e}")
        await asyncio.sleep(2)


# ─── B1f: Graceful shutdown ───

@app.on_event("shutdown")
async def shutdown_handler():
    """Save resume data for all active torrents before exit."""
    log.info("Shutdown: saving resume data...")
    try:
        await asyncio.to_thread(_save_resume_data_blocking)
    except Exception as e:
        log.error(f"Shutdown save error: {e}")
    log.info("Shutdown complete")


@app.on_event("startup")
async def startup_background_tasks():
    # B1d: Reload torrents from DB
    _reload_torrents_from_db()
    # Background tasks
    asyncio.create_task(_rss_poller())
    asyncio.create_task(_scheduler_task())
    asyncio.create_task(_ws_broadcast_loop())
    asyncio.create_task(_completion_monitor())
    asyncio.create_task(_save_resume_data())
    asyncio.create_task(_alert_processor())


# ═══════════════════════════ WEBSOCKET ═══════════════════════════

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    token = ws.cookies.get(COOKIE)
    if not token or not verify_token(token):
        await ws.close(code=4001)
        return
    await ws.accept()
    _ws_clients.add(ws)
    try:
        while True:
            # Wait for client message (ping) or disconnect
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _ws_clients.discard(ws)

# ═══════════════════════════ qBittorrent API v2 ═══════════════════════════

try:
    from qbt_api import qbt_router
    app.include_router(qbt_router)
    log.info("qBittorrent API v2 compatibility loaded")
except ImportError:
    log.warning("qbt_api.py not found, qBittorrent API disabled")
except Exception as e:
    log.warning(f"qBittorrent API failed to load: {e}")

# ═══════════════════════════ FRONTEND ═══════════════════════════

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend", "dist")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIR, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        fp = os.path.join(FRONTEND_DIR, full_path)
        if os.path.isfile(fp):
            return FileResponse(fp)
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
