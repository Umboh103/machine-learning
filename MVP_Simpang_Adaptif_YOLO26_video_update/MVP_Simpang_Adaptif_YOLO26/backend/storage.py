"""Append-only, transactionally durable session journal. No browser storage dependency."""
import csv
import io
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


class SessionStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL,
                    payload TEXT NOT NULL, ended_at TEXT, summary TEXT
                );
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
                    client_event_id TEXT, received_at TEXT NOT NULL, payload TEXT NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(id),
                    UNIQUE(session_id, client_event_id)
                );
                CREATE INDEX IF NOT EXISTS session_events ON events(session_id, seq);
                CREATE TABLE IF NOT EXISTS camera_profiles (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
                );
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=FULL")
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def now():
        return datetime.now(timezone.utc).isoformat()

    def create(self, session_id, payload):
        with self.connect() as db:
            db.execute("INSERT INTO sessions(id,created_at,status,payload) VALUES(?,?,?,?)",
                       (session_id, self.now(), "running", encode(payload)))
            db.execute("INSERT INTO events(session_id,received_at,payload) VALUES(?,?,?)",
                       (session_id, self.now(), encode({"type": "lifecycle", "time": 0, "data": {"status": "started"}})))

    def exists(self, session_id):
        with self.connect() as db:
            return db.execute("SELECT status FROM sessions WHERE id=?", (session_id,)).fetchone()

    def configuration(self, session_id):
        with self.connect() as db:
            row = db.execute("SELECT payload FROM sessions WHERE id=?", (session_id,)).fetchone()
        return json.loads(row[0]).get("config", {}) if row else {}

    def profiles(self):
        with self.connect() as db:
            return [{"profile_id": row[0], "name": row[1], "updated_at": row[2]}
                    for row in db.execute("SELECT id,name,updated_at FROM camera_profiles ORDER BY name")]

    def profile(self, profile_id):
        with self.connect() as db:
            row = db.execute("SELECT name,created_at,updated_at,payload FROM camera_profiles WHERE id=?", (profile_id,)).fetchone()
        return {"profile_id": profile_id, "name": row[0], "created_at": row[1], "updated_at": row[2], **json.loads(row[3])} if row else None

    def save_profile(self, profile_id, payload, update=False):
        encoded, now = encode(payload), self.now()
        with self.connect() as db:
            if update:
                return db.execute("UPDATE camera_profiles SET name=?,updated_at=?,payload=? WHERE id=?",
                                  (payload["name"], now, encoded, profile_id)).rowcount > 0
            db.execute("INSERT INTO camera_profiles(id,name,created_at,updated_at,payload) VALUES(?,?,?,?,?)",
                       (profile_id, payload["name"], now, now, encoded))
        return True

    def append(self, session_id, events):
        records = [(session_id, event.get("client_event_id"), self.now(), encode(event)) for event in events]
        with self.connect() as db:
            db.executemany("INSERT OR IGNORE INTO events(session_id,client_event_id,received_at,payload) VALUES(?,?,?,?)", records)
            for event in events:
                status = event.get("data", {}).get("status", event.get("data", {}).get("state"))
                if status == "resumed":
                    status = "running"
                if event.get("type") == "lifecycle" and status in ("running", "paused"):
                    db.execute("UPDATE sessions SET status=? WHERE id=? AND status IN ('running','paused')", (status, session_id))

    def end(self, session_id, summary):
        with self.connect() as db:
            db.execute("UPDATE sessions SET status=?, ended_at=?, summary=? WHERE id=?",
                       (summary.get("status", "ended"), self.now(), encode(summary), session_id))

    def list(self):
        with self.connect() as db:
            return [{"session_id": row[0], "created_at": row[1], "status": row[2], "ended_at": row[3], "event_count": row[4],
                     "source": json.loads(row[5]).get("source"), "source_name": json.loads(row[5]).get("source_name"), "mode": json.loads(row[5]).get("mode")}
                    for row in db.execute("SELECT s.id,s.created_at,s.status,s.ended_at,COUNT(e.seq),s.payload "
                                          "FROM sessions s LEFT JOIN events e ON e.session_id=s.id "
                                          "GROUP BY s.id ORDER BY s.created_at DESC LIMIT 100")]

    def export(self, session_id):
        with self.connect() as db:
            row = db.execute("SELECT created_at,status,payload,ended_at,summary FROM sessions WHERE id=?", (session_id,)).fetchone()
            if not row:
                return None
            events = [{"seq": seq, "received_at": received, **json.loads(payload)}
                      for seq, received, payload in db.execute("SELECT seq,received_at,payload FROM events WHERE session_id=? ORDER BY seq", (session_id,))]
        runtime = next((event.get("data", {}).get("metadata") for event in reversed(events)
                        if event.get("type") == "observation" and event.get("data", {}).get("metadata")), None)
        return {"schema_version": "1.0", "session_id": session_id, "created_at": row[0], "status": row[1],
                **json.loads(row[2]), "ended_at": row[3], "summary": json.loads(row[4]) if row[4] else None,
                "events": events, "model_runtime": runtime,
                "units": {"time": "seconds", "coordinates": "normalized 0-1", "latency": "milliseconds"}}

    def csv(self, session_id):
        session = self.export(session_id)
        if not session:
            return None
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(["session_id", "seq", "type", "time_s", "media_time_s", "direction", "queue_vehicles",
                         "max_wait_s", "mean_wait_s", "valid", "estimated", "data_json"])
        for event in session["events"]:
            data = event.get("data", {})
            rows = data.get("rows", []) if event.get("type") == "snapshot" else []
            if rows:
                for direction, row in enumerate(rows):
                    valid = data.get("valid", True)
                    writer.writerow([session_id, event["seq"], event["type"], event.get("time"), event.get("media_time", data.get("media_time")),
                                     direction, row.get("q") if valid else "", row.get("w") if valid else "", row.get("avg") if valid else "",
                                     valid, row.get("estimated", False), encode(data)])
            else:
                writer.writerow([session_id, event["seq"], event.get("type"), event.get("time"), event.get("media_time"),
                                 "", "", "", "", data.get("valid", ""), "", encode(data)])
        return output.getvalue()
