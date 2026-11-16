"""Local-only simulator relay. No electrical lamp outputs or MQTT subscription."""
import json
import asyncio
from contextlib import asynccontextmanager, suppress
import logging
import math
import re
import secrets
import sqlite3
import threading
import time
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .edge_protocol import config_digest, validate_config, validate_proposal
from .storage import encode


class StartEdge(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    session_id: str | None = None
    config: dict
    source_name: str = Field(default='recording', max_length=160)
    metadata: dict = Field(default_factory=dict)


class ClaimEdge(BaseModel):
    consumer_id: str = Field(min_length=1, max_length=100)


class FeedbackEdge(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    token: str
    action: str = 'heartbeat'
    time: float = Field(default=0, ge=0)
    events: list[dict] = Field(default_factory=list, max_length=100)
    event_start: int = Field(default=0, ge=0)
    snapshot: dict | None = None


def make_edge_router(store, *, monotonic=time.monotonic, utc_ms=lambda: int(time.time()*1000)):
    lock, channels = threading.RLock(), {}

    def expire_consumers():
        with lock:
            for sid, ch in list(channels.items()):
                if ch['token'] and monotonic() >= ch['lease_until']:
                    try:
                        channel(sid)
                    except HTTPException:
                        pass

    @asynccontextmanager
    async def lifespan(_app):
        async def sweep():
            while True:
                await asyncio.sleep(1)
                try:
                    await asyncio.to_thread(expire_consumers)
                except sqlite3.Error:
                    logging.getLogger(__name__).exception('Cannot persist simulator timeout; retrying')
        task = asyncio.create_task(sweep())
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    router = APIRouter(prefix='/api/edge', lifespan=lifespan)
    # A browser consumer and its clock cannot survive a backend restart.
    with store.connect() as db:
        unfinished = [(sid, json.loads(payload)) for sid, payload in db.execute("SELECT id,payload FROM sessions WHERE status IN ('running','paused')")]
    for sid, payload in unfinished:
        if payload.get('source') == 'edge-density':
            store.append(sid, [{'type': 'fault', 'time': 0, 'data': {'reason': 'edge-bridge-restarted'}}])
            store.end(sid, {'status': 'failed', 'reason': 'edge-bridge-restarted'})

    def channel(sid):
        if sid not in channels:
            raise HTTPException(404, 'Sesi Edge tidak tersedia; mulai sesi baru setelah restart backend')
        ch = channels[sid]
        state = store.exists(sid)[0]
        if state not in ('running', 'paused'):
            raise HTTPException(409, 'Sesi sudah berakhir')
        if ch['token'] and monotonic() >= ch['lease_until']:
            store.append(sid, [{'type': 'fault', 'time': ch['time'], 'data': {'reason': 'simulator-consumer-timeout'}}])
            store.end(sid, {'status': 'failed', 'time': ch['time'], 'reason': 'simulator-consumer-timeout'})
            ch['token'] = None
            raise HTTPException(409, 'Koneksi simulator kedaluwarsa; mulai sesi baru')
        return ch

    @router.post('/sessions', status_code=201)
    def start(body: StartEdge):
        try:
            validate_config(body.config)
            encode(body.config)
            encode(body.metadata)
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc
        sid = body.session_id or str(uuid.uuid4())
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', sid):
            raise HTTPException(422, 'Session ID tidak valid')
        with lock:
            if store.exists(sid):
                raise HTTPException(409, 'Session ID sudah dipakai')
            store.create(sid, {'config': body.config, 'config_sha256': config_digest(body.config),
                              'source': 'edge-density', 'source_name': body.source_name,
                              'metadata': body.metadata,
                              'mode': 'weighted-presence-example', 'output': 'foreground-browser-simulator'})
            channels[sid] = {'config': json.loads(encode(body.config)), 'latest': None, 'seq': 0, 'epoch': 0,
                             'created': 0, 'last_frame': -1, 'token': None, 'consumer_id': None, 'lease_until': 0, 'time': 0, 'feedback_seq': 0}
        return {'session_id': sid, 'config_sha256': config_digest(body.config), 'output_scope': 'simulator-proposals-only'}

    @router.get('/sessions')
    def listing():
        return {'sessions': [item for item in store.list() if item.get('source') == 'edge-density']}

    @router.get('/sessions/{sid}')
    def latest(sid: str):
        with lock:
            ch = channel(sid)
            return {'session_id': sid, 'config': ch['config'], 'config_sha256': config_digest(ch['config']),
                    'proposal': ch['latest'], 'server_utc_ms': utc_ms(), 'status': store.exists(sid)[0]}

    @router.post('/sessions/{sid}/proposals')
    def proposal(sid: str, packet: dict):
        with lock:
            ch = channel(sid)
            try:
                validate_proposal(ch['config'], sid, packet, utc_ms())
            except (TypeError, KeyError, ValueError) as exc:
                raise HTTPException(422, str(exc)) from exc
            canonical = encode(packet)
            if packet['seq'] == ch['seq'] and ch['latest'] is not None and canonical == encode(ch['latest']):
                return {'accepted': True, 'duplicate': True, 'seq': ch['seq'], 'applied': False}
            if packet['seq'] <= ch['seq'] or packet['source_epoch'] < ch['epoch'] or packet['created_at_utc_ms'] < ch['created']:
                raise HTTPException(409, 'Replay atau urutan sumber mundur')
            if packet['valid'] and packet['source_epoch'] == ch['epoch'] and packet['frame_id'] <= ch['last_frame']:
                raise HTTPException(409, 'Frame yang sama tidak boleh memperbarui kesegaran pengamatan')
            store.append(sid, [{'client_event_id': f"edge-proposal-{packet['seq']}", 'type': 'edge_proposal',
                                'time': ch['time'], 'data': packet}])
            last_frame = packet['frame_id'] if packet['valid'] else -1 if packet['source_epoch'] != ch['epoch'] else ch['last_frame']
            ch.update(latest=json.loads(canonical), seq=packet['seq'], epoch=packet['source_epoch'], created=packet['created_at_utc_ms'], last_frame=last_frame)
            return {'accepted': True, 'seq': ch['seq'], 'applied': False}

    @router.post('/sessions/{sid}/claim')
    def claim(sid: str, body: ClaimEdge):
        with lock:
            ch = channel(sid)
            if ch['token'] is not None:
                raise HTTPException(409, 'Sesi sudah dimiliki satu simulator; jangan membuka tab pengendali kedua')
            token = secrets.token_urlsafe(32)
            store.append(sid, [{'type': 'simulator_attached', 'time': 0, 'data': {'consumer_id': body.consumer_id}}])
            ch.update(token=token, consumer_id=body.consumer_id, lease_until=monotonic()+5)
            return {'token': token, 'lease_seconds': 5}

    @router.post('/sessions/{sid}/feedback')
    def feedback(sid: str, body: FeedbackEdge):
        with lock:
            ch = channel(sid)
            if ch['token'] is None or not secrets.compare_digest(body.token.encode(), ch['token'].encode()):
                raise HTTPException(403, 'Token simulator tidak cocok')
            if body.time < ch['time'] or not math.isfinite(body.time):
                raise HTTPException(409, 'Jam simulator mundur')
            if body.action not in ('heartbeat', 'pause', 'resume', 'end', 'fail'):
                raise HTTPException(422, 'Aksi simulator tidak dikenal')
            ch['feedback_seq'] += 1
            events = []
            for i, item in enumerate(body.events):
                if item.get('type') not in ('decision', 'transition', 'fault', 'application_ack') or not isinstance(item.get('data'), dict):
                    raise HTTPException(422, 'Event simulator tidak valid')
                events.append({'client_event_id': f"edge-consumer-event-{body.event_start+i}", 'type': item['type'], 'time': body.time, 'data': item['data']})
            if body.snapshot is not None:
                events.append({'type': 'simulator_output', 'time': body.time, 'data': body.snapshot})
            if body.action != 'heartbeat':
                state = {'pause': 'paused', 'resume': 'resumed', 'end': 'ended', 'fail': 'failed'}[body.action]
                events.append({'type': 'lifecycle', 'time': body.time, 'data': {'state': state}})
            store.append(sid, events)
            if body.action in ('end', 'fail'):
                store.end(sid, {'status': 'ended' if body.action == 'end' else 'failed', 'time': body.time, 'reason': 'edge-simulator-'+body.action})
                ch['token'] = None
            ch.update(time=body.time, lease_until=monotonic()+5)
            return {'saved': len(events), 'durable': True, 'lease_seconds': 5}

    return router
