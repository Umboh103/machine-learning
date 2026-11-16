import copy
import json
from pathlib import Path
import tempfile
import unittest
import sqlite3
import time
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.edge_bridge import make_edge_router
from backend.edge_protocol import build_proposal, weighted_presence
from backend.storage import SessionStore

ROOT = Path(__file__).resolve().parents[1]


class EdgeBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = SessionStore(Path(self.temp.name)/'journal.sqlite3')
        self.now, self.utc = 10., 10000
        self.config = json.loads((ROOT/'examples/edge_density/config.example.json').read_text())
        self.client = self.make_client()
        response = self.client.post('/api/edge/sessions', json={'session_id':'edge-test', 'config':self.config})
        self.assertEqual(response.status_code,201,response.text)
        self.base = '/api/edge/sessions/edge-test'

    def make_client(self):
        app = FastAPI()
        app.include_router(make_edge_router(self.store,monotonic=lambda:self.now,utc_ms=lambda:self.utc))
        return TestClient(app)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def packet(self,seq=1):
        return {**build_proposal(self.config,'edge-test',seq,weighted_presence(self.config,[]),.1,now_ms=self.utc,source_epoch=1), 'frame_id': seq}

    def claim(self):
        response=self.client.post(self.base+'/claim',json={'consumer_id':'browser'})
        self.assertEqual(response.status_code,200,response.text)
        return response.json()['token']

    def test_proposal_is_durable_idempotent_and_receipt_does_not_claim_application(self):
        packet=self.packet()
        first=self.client.post(self.base+'/proposals',json=packet)
        self.assertEqual(first.status_code,200,first.text);self.assertFalse(first.json()['applied'])
        second=self.client.post(self.base+'/proposals',json=packet)
        self.assertTrue(second.json()['duplicate'])
        self.assertEqual(len([e for e in self.store.export('edge-test')['events'] if e['type']=='edge_proposal']),1)
        self.assertEqual(self.client.get(self.base).json()['proposal'],json.loads(json.dumps(packet)))

    def test_rejects_config_replay_epoch_regression_and_expired_packets(self):
        self.assertEqual(self.client.post(self.base+'/proposals',json=self.packet(2)).status_code,200)
        for patch, expected in [({'seq':1},409),({'seq':3,'frame_id':2},409),({'seq':3,'source_epoch':0},409),({'seq':3,'config_sha256':'changed'},422),({'seq':3,'valid_until_utc_ms':self.utc-1},422),({'seq':3,'green_s':[999]*4},422),({'seq':3,'phase_order':[1,0,2,3]},422)]:
            with self.subTest(patch=patch):
                packet={**self.packet(3),**patch}
                self.assertEqual(self.client.post(self.base+'/proposals',json=packet).status_code,expected)

    def test_valid_empty_differs_from_stopped_source(self):
        self.client.post(self.base+'/proposals',json=self.packet())
        self.assertEqual(self.client.get(self.base).json()['proposal']['green_s'],[10]*4)
        stopped=build_proposal(self.config,'edge-test',2,None,float('inf'),now_ms=self.utc,reason='agent-stopped',source_epoch=1)
        self.assertEqual(self.client.post(self.base+'/proposals',json=stopped).status_code,200)
        self.assertIsNone(self.client.get(self.base).json()['proposal']['rows'])

    def test_one_consumer_and_feedback_token_are_enforced(self):
        self.claim()
        self.assertEqual(self.client.post(self.base+'/claim',json={'consumer_id':'second-tab'}).status_code,409)
        self.assertEqual(self.client.post(self.base+'/feedback',json={'token':'wrong'}).status_code,403)

    def test_pause_resume_and_end_are_journaled_and_exportable(self):
        token=self.claim()
        for action, expected in [('pause','paused'),('resume','running'),('end','ended')]:
            response=self.client.post(self.base+'/feedback',json={'token':token,'action':action,'time':1,'events':[{'type':'application_ack','data':{'applied':True,'output_scope':'simulator-only'}}] if action=='end' else [],'snapshot':{'departed':1}})
            self.assertEqual(response.status_code,200,response.text);self.assertEqual(self.store.exists('edge-test')[0],expected)
        exported=self.store.export('edge-test')
        self.assertTrue(any(e['type']=='application_ack' for e in exported['events']))
        self.assertIn('edge-density',json.dumps(exported));self.assertIn('application_ack',self.store.csv('edge-test'))
        self.assertEqual(self.client.post(self.base+'/proposals',json=self.packet(2)).status_code,409)

    def test_missing_consumer_lease_fails_session_instead_of_second_controller(self):
        self.claim();self.now+=5.1
        self.assertEqual(self.client.get(self.base).status_code,409)
        self.assertEqual(self.store.exists('edge-test')[0],'failed')
        self.assertTrue(any(e['data'].get('reason')=='simulator-consumer-timeout' for e in self.store.export('edge-test')['events']))

    def test_backend_restart_never_resurrects_last_valid_proposal(self):
        self.client.post(self.base+'/proposals',json=self.packet())
        restarted=self.make_client()
        self.assertEqual(restarted.get(self.base).status_code,404);self.assertEqual(self.store.exists('edge-test')[0],'failed')
        restarted.close()

    def test_background_watchdog_closes_missing_tab_without_polling_session(self):
        with self.client:
            self.claim();self.now+=6
            until=time.monotonic()+3
            while self.store.exists('edge-test')[0]!='failed' and time.monotonic()<until:
                time.sleep(.05)
            self.assertEqual(self.store.exists('edge-test')[0],'failed')

    def test_invalid_or_ambiguous_configuration_is_rejected(self):
        for patch in [{'intersection_id':''},{'yellow_s':0},{'phase_order':[0,0,1,2]}]:
            response=self.client.post('/api/edge/sessions',json={'config':{**self.config,**patch}})
            self.assertEqual(response.status_code,422,response.text)
        config=copy.deepcopy(self.config);config['rois'][1]=config['rois'][0]
        self.assertEqual(self.client.post('/api/edge/sessions',json={'config':config}).status_code,422)

    def test_feedback_retry_does_not_duplicate_applied_event(self):
        token=self.claim()
        payload={'token':token,'time':1,'event_start':0,'events':[{'type':'application_ack','data':{'applied':True}}]}
        for _ in range(2):self.assertEqual(self.client.post(self.base+'/feedback',json=payload).status_code,200)
        self.assertEqual(sum(e['type']=='application_ack' for e in self.store.export('edge-test')['events']),1)

    def test_journal_failure_cannot_acknowledge_or_forward_unrecorded_proposal(self):
        with patch.object(self.store,'append',side_effect=sqlite3.OperationalError('disk failure')):
            with self.assertRaises(sqlite3.OperationalError):self.client.post(self.base+'/proposals',json=self.packet())
        self.assertIsNone(self.client.get(self.base).json()['proposal'])
        self.assertEqual(self.client.post(self.base+'/proposals',json=self.packet()).status_code,200)


if __name__=='__main__':unittest.main()
