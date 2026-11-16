"""Shared protocol and observation helpers for the local Edge simulator example."""
from collections import Counter
import hashlib
import json
import math
import time

import cv2
import numpy as np


def config_digest(config):
    return hashlib.sha256(json.dumps(config, sort_keys=True, allow_nan=False).encode()).hexdigest()


def segment_intersects(a, b, c, d):
    def cross(p, q, r):
        return (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0])
    def on(p, q, r):
        return abs(cross(p,q,r))<1e-9 and min(p[0],q[0])-1e-9<=r[0]<=max(p[0],q[0])+1e-9 and min(p[1],q[1])-1e-9<=r[1]<=max(p[1],q[1])+1e-9
    return (cross(a,b,c)*cross(a,b,d)<0 and cross(c,d,a)*cross(c,d,b)<0) or on(a,b,c) or on(a,b,d) or on(c,d,a) or on(c,d,b)


def validate_config(config):
    intersection = config.get('intersection_id')
    if not isinstance(intersection, str) or not 1 <= len(intersection) <= 80 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in intersection):
        raise ValueError('Invalid intersection ID')
    names, order, polygons = config['phase_names'], config['phase_order'], config['rois']
    if not isinstance(names, list) or len(names) != 4 or any(not isinstance(name, str) or not 1 <= len(name) <= 80 for name in names) or not isinstance(order, list) or any(type(i) is not int for i in order) or sorted(order) != [0, 1, 2, 3] or not isinstance(polygons, list) or len(polygons) != 4:
        raise ValueError('This example requires four exclusive movements in fixed cyclic order')
    for polygon in polygons:
        if len(polygon) < 3 or any(len(p) != 2 or any(not math.isfinite(x) or not 0 <= x <= 1 for x in p) for p in polygon):
            raise ValueError('ROI coordinates must be finite and normalized')
        if abs(cv2.contourArea(np.array(polygon, np.float32))) < .0001:
            raise ValueError('ROI has no usable area')
        for i, a in enumerate(polygon):
            for j in range(i+1,len(polygon)):
                if j not in ((i+1)%len(polygon),) and i != (j+1)%len(polygon) and segment_intersects(a,polygon[(i+1)%len(polygon)],polygon[j],polygon[(j+1)%len(polygon)]):
                    raise ValueError('Self-intersecting ROI')
    for i, a in enumerate(polygons):
        for b in polygons[i+1:]:
            if any(cv2.pointPolygonTest(np.array(b,np.float32),tuple(p),False)>=0 for p in a) or any(cv2.pointPolygonTest(np.array(a,np.float32),tuple(p),False)>=0 for p in b) or any(segment_intersects(p,a[(j+1)%len(a)],q,b[(k+1)%len(b)]) for j,p in enumerate(a) for k,q in enumerate(b)):
                raise ValueError('Overlapping or touching ROI mapping')
    if any(type(config[key]) not in (int, float) or not math.isfinite(config[key]) for key in ['green_min_s','green_max_s','fallback_green_s','snapshot_max_age_s','seconds_per_equivalent_vehicle']):
        raise ValueError('Control parameters must be finite')
    if not 0 < config['green_min_s'] <= config['fallback_green_s'] <= config['green_max_s']:
        raise ValueError('Invalid green or fallback bounds')
    if not isinstance(config['vehicle_weights'], dict) or any(type(value) not in (int, float) for value in config['vehicle_weights'].values()):
        raise ValueError('Class weights must be numeric')
    weights = {int(k): float(v) for k, v in config['vehicle_weights'].items()}
    if not weights or any(k < 0 or not math.isfinite(v) or v <= 0 for k, v in weights.items()):
        raise ValueError('Invalid class weights')
    if not math.isfinite(config['seconds_per_equivalent_vehicle']) or config['seconds_per_equivalent_vehicle'] < 0:
        raise ValueError('Invalid duration coefficient')
    if not 0 < config['snapshot_max_age_s'] <= 10:
        raise ValueError('Invalid data freshness limit')
    for key, default in [('yellow_s', 3), ('all_red_s', 1)]:
        value = config.get(key, default)
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= 30:
            raise ValueError('Invalid clearance duration')
    return weights


def weighted_presence(config, detections):
    """Unique tracked IDs in this frame only; not cumulative passage counts."""
    weights = {int(k): float(v) for k, v in config['vehicle_weights'].items()}
    polygons = [np.array(p, np.float32) for p in config['rois']]
    classes = [Counter() for _ in polygons]
    seen = set()
    for detection in detections:
        ident, cls, box = detection['id'], detection['class_id'], detection['box']
        if cls not in weights or ident in seen:
            continue
        if len(box) != 4 or any(not math.isfinite(x) or not 0 <= x <= 1 for x in box) or box[0] > box[2] or box[1] > box[3]:
            raise ValueError('Malformed normalized detection')
        point = ((box[0] + box[2]) / 2, box[3])
        zones = [i for i, polygon in enumerate(polygons) if cv2.pointPolygonTest(polygon, point, False) >= 0]
        if len(zones) > 1:
            raise ValueError('Ambiguous ROI mapping; observation unavailable')
        seen.add(ident)
        if zones:
            classes[zones[0]][cls] += 1
    return [{'phase': i, 'vehicles': sum(counts.values()), 'by_class': dict(counts),
             'weighted_presence': sum(weights[cls] * count for cls, count in counts.items())}
            for i, counts in enumerate(classes)]


def proposed_green(config, demand):
    if not math.isfinite(demand) or demand < 0:
        raise ValueError('Invalid weighted presence')
    raw = config['green_min_s'] + config['seconds_per_equivalent_vehicle'] * demand
    return round(min(config['green_max_s'], max(config['green_min_s'], raw)), 1)


def build_proposal(config, session, seq, rows, age_s, *, now_ms=None, reason=None, source_epoch=0):
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    valid = rows is not None and math.isfinite(age_s) and 0 <= age_s <= config['snapshot_max_age_s'] and not reason
    remaining_ms = max(0, int((config['snapshot_max_age_s'] - age_s) * 1000)) if valid else 0
    return {'schema': 'traffic-plan-proposal-v1', 'intersection_id': config['intersection_id'],
            'session_id': session, 'seq': seq, 'source_epoch': source_epoch,
            'config_sha256': config_digest(config),
            'created_at_utc_ms': now_ms, 'valid_until_utc_ms': now_ms + remaining_ms,
            'timestamp_basis': 'edge_decode_arrival; camera exposure time is not measured',
            'valid': valid, 'reason': None if valid else reason or 'stale-or-unavailable',
            'measurement_kind': 'unique-tracked-ROI-presence; not stopped queue',
            'phase_order': config['phase_order'], 'green_min_s': config['green_min_s'],
            'green_max_s': config['green_max_s'], 'fallback_green_s': config['fallback_green_s'],
            'rows': rows if valid else None,
            'green_s': [proposed_green(config, r['weighted_presence']) for r in rows] if valid else None,
            'apply_at': 'next-green-boundary-after-controller-clearance',
            'output_scope': 'simulator-proposals-only'}


def validate_proposal(config, session_id, packet, now_ms):
    """Validate an immutable session contract before recording/forwarding a plan."""
    if not isinstance(packet, dict):
        raise ValueError('Proposal must be an object')
    if packet.get('schema') != 'traffic-plan-proposal-v1' or packet.get('output_scope') != 'simulator-proposals-only':
        raise ValueError('Unsupported simulator protocol')
    if packet.get('session_id') != session_id or packet.get('intersection_id') != config['intersection_id']:
        raise ValueError('Session or intersection mismatch')
    if packet.get('config_sha256') != config_digest(config):
        raise ValueError('Configuration is locked for this session')
    for key, minimum in [('seq', 1), ('source_epoch', 0)]:
        if type(packet.get(key)) is not int or packet[key] < minimum:
            raise ValueError('Invalid sequence or source epoch')
    if type(packet.get('valid')) is not bool:
        raise ValueError('Validity must be explicit')
    for key in ['created_at_utc_ms', 'valid_until_utc_ms']:
        if type(packet.get(key)) is not int:
            raise ValueError('Invalid UTC timestamp')
    created, deadline = packet['created_at_utc_ms'], packet['valid_until_utc_ms']
    if created > now_ms + 250 or now_ms - created > 10000:
        raise ValueError('Clock offset or packet age exceeds limit')
    if deadline < created or deadline - created > config['snapshot_max_age_s'] * 1000:
        raise ValueError('Invalid observation lifetime')
    if packet.get('phase_order') != config['phase_order']:
        raise ValueError('Phase order is locked')
    for key in ['green_min_s', 'green_max_s', 'fallback_green_s']:
        if packet.get(key) != config[key]:
            raise ValueError('Timing bounds are locked')
    if not packet['valid']:
        if packet.get('rows') is not None or packet.get('green_s') is not None or deadline != created:
            raise ValueError('Invalid observations must not carry usable plans')
        return
    if deadline <= now_ms:
        raise ValueError('Observation has expired')
    if type(packet.get('frame_id')) is not int or packet['frame_id'] < 0:
        raise ValueError('Valid observations require a source frame ID')
    rows, greens = packet.get('rows'), packet.get('green_s')
    if not isinstance(rows, list) or len(rows) != 4 or not isinstance(greens, list) or len(greens) != 4:
        raise ValueError('Four exclusive phase observations are required')
    for i, (row, green) in enumerate(zip(rows, greens)):
        if not isinstance(row, dict) or type(row.get('phase')) is not int or row['phase'] != i:
            raise ValueError('Invalid phase mapping')
        counts = row.get('by_class')
        if not isinstance(counts, dict) or any(str(k) not in config['vehicle_weights'] or type(v) is not int or v < 0 for k, v in counts.items()):
            raise ValueError('Invalid class counts')
        demand = sum(config['vehicle_weights'][str(k)] * count for k, count in counts.items())
        measured = row.get('weighted_presence')
        if type(row.get('vehicles')) is not int or row['vehicles'] != sum(counts.values()) or type(measured) not in (int, float) or not math.isfinite(measured) or abs(measured - demand) > 1e-6:
            raise ValueError('Inconsistent weighted presence')
        if type(green) not in (int, float) or not math.isfinite(green) or abs(green - proposed_green(config, demand)) > 1e-6:
            raise ValueError('Inconsistent proposed duration')


