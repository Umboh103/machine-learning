import copy
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
import unittest

from examples.edge_density.edge_agent import validate_config, weighted_presence, proposed_green, build_proposal, Publisher

ROOT=Path(__file__).resolve().parents[1]


class EdgeExampleTests(unittest.TestCase):
    def setUp(self):
        self.config=json.loads((ROOT/'examples/edge_density/config.example.json').read_text(encoding='utf-8'))

    def test_class_weights_unique_ids_and_bottom_center_roi(self):
        validate_config(self.config)
        car={'id':1,'class_id':2,'box':[.39,.05,.41,.10]}
        rows=weighted_presence(self.config,[car,car,{'id':2,'class_id':3,'box':[.39,.05,.41,.10]}, {'id':3,'class_id':5,'box':[.79,.35,.81,.4]}, {'id':4,'class_id':7,'box':[.59,.7,.61,.8]}, {'id':5,'class_id':0,'box':[.39,.05,.41,.1]}])
        self.assertEqual([r['vehicles'] for r in rows],[2,1,1,0])
        self.assertEqual([r['weighted_presence'] for r in rows],[1.25,1.8,2.,0.])

    def test_empty_valid_observation_is_distinct_from_unknown_and_expired(self):
        rows=weighted_presence(self.config,[])
        good=build_proposal(self.config,'session',1,rows,.2,now_ms=1000)
        self.assertTrue(good['valid']);self.assertEqual(good['green_s'],[10.]*4);self.assertEqual(good['valid_until_utc_ms'],2800)
        for rows,age in ((None,0),(rows,2.1),(rows,float('nan'))):
            bad=build_proposal(self.config,'session',2,rows,age,now_ms=1000)
            self.assertFalse(bad['valid']);self.assertIsNone(bad['rows']);self.assertIsNone(bad['green_s']);self.assertEqual(bad['valid_until_utc_ms'],1000)

    def test_duration_bounds_and_fixed_cyclic_order(self):
        self.assertEqual(proposed_green(self.config,1000),60)
        self.assertEqual(proposed_green(self.config,2),14)
        with self.assertRaises(ValueError): proposed_green(self.config,-1)
        for change in ({'phase_order':[0,0,1,2]},{'fallback_green_s':70},{'green_max_s':float('inf')}):
            cfg={**self.config,**change}
            with self.assertRaises(ValueError):validate_config(cfg)

    def test_ambiguous_or_malformed_zones_are_rejected(self):
        cfg=copy.deepcopy(self.config);cfg['rois'][1]=cfg['rois'][0]
        with self.assertRaises(ValueError):validate_config(cfg)
        with self.assertRaises(ValueError):weighted_presence(cfg,[{'id':1,'class_id':2,'box':[.39,.05,.41,.1]}])
        with self.assertRaises(ValueError):weighted_presence(self.config,[{'id':1,'class_id':2,'box':[0,0,float('nan'),1]}])

    def test_default_transport_is_stdout_and_simulator_topic_only(self):
        publisher=Publisher(SimpleNamespace(broker=None,intersection='demo'),'session')
        self.assertIsNone(publisher.client);self.assertEqual(publisher.topic,'traffic/sim/demo/plan/proposed')
        data=build_proposal(self.config,'session',1,None,float('inf'),reason='offline',now_ms=1000)
        with redirect_stdout(io.StringIO()) as output:publisher.send(data)
        self.assertEqual(json.loads(output.getvalue())['output_scope'],'simulator-proposals-only')


if __name__=='__main__':unittest.main()
