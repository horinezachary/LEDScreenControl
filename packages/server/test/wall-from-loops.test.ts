import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { wallGroupsFromLoops } from '@ledmon/shared';
import { parseLoops } from '../src/drivers/brompton.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/tessera-sx40-3.5.2.json', import.meta.url), 'utf8'));
const tree = fx.api ?? fx;

describe('building a Brompton wall from cable loops', () => {
  it('finds the XD pairs and cabled ports a real SX40 reports', () => {
    const loops = parseLoops(tree.output.network['cable-redundancy'].loops);
    const groups = wallGroupsFromLoops(loops, [], 81);
    expect(groups.map((g) => [g.left.trunk, g.right?.trunk])).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    // A1, and C1, C2, D3, C4, C5 (D1 is port 1 again): 6 chains share 81 tiles.
    expect(groups[0].chains).toEqual([14, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(groups[1].chains).toEqual([14, 14, 14, 14, 14, 0, 0, 0, 0, 0]);
    expect(groups[1].left).toEqual({ name: 'XD C', trunk: 'C', ports: 10 });
  });

  it('keeps tile counts, names and serials already entered', () => {
    const loops = parseLoops({ '1': { state: 'loop-found: A1->B1, loop-found: A2->B2' } });
    const existing = [{ left: { name: 'Stage left', trunk: 'A', ports: 10, serial: '017680' }, right: { name: 'Stage right', trunk: 'B', ports: 10 }, chains: [8, 0, 0, 0, 0, 0, 0, 0, 0, 0] }];
    const [g] = wallGroupsFromLoops(loops, existing, 20);
    expect(g.left).toMatchObject({ name: 'Stage left', serial: '017680' });
    expect(g.chains.slice(0, 3)).toEqual([8, 10, 0]);
  });
});
