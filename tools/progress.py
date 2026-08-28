#!/usr/bin/env python3
"""Progress from the ledger: per-milestone % + weighted overall %. Run: python3 tools/progress.py"""
import json, os, re
os.chdir(os.path.join(os.path.dirname(__file__), '..'))
# Milestone weights ~ effort share of the 8 days
WEIGHTS = {'M0': 8, 'M1': 8, 'M2': 20, 'M3': 20, 'M4': 16, 'M5': 12, 'M6': 12, 'M7': 4}
STATUS_VAL = {'done': 1.0, 'in_progress': 0.5, 'todo': 0.0, 'blocked': 0.0, 'cut': None}
d = json.load(open('features.json'))
phases = {}
for f in d['features']:
    m = re.match(r'(M\d+)', f['id']).group(1)
    v = STATUS_VAL.get(f['status'], 0.0)
    if v is None: continue  # cut items don't count
    phases.setdefault(m, []).append(v)
print('=== PROGRESS ===')
overall_num = overall_den = 0.0
for m in sorted(WEIGHTS):
    if m in phases:
        pct = 100 * sum(phases[m]) / len(phases[m])
        print(f'{m}: {pct:5.1f}%  ({sum(1 for v in phases[m] if v==1.0)}/{len(phases[m])} done)')
    else:
        pct = 0.0
        print(f'{m}:   0.0%  (no ledger entries yet)')
    overall_num += WEIGHTS[m] * pct
    overall_den += WEIGHTS[m]
print(f'--- OVERALL: {overall_num/overall_den:.1f}% (weighted by effort share)')
