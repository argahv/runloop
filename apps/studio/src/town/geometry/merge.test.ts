import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Line, BufferGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, SphereGeometry } from 'three';
import { mergeMeshes } from './merge';

describe('mergeMeshes (static subtrees in a few calls)', () => {
  it('bakes transforms and colours into one mesh per distinct material', () => {
    const root = new Group();
    root.position.set(10, 0, 0);
    const a = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: '#ff0000', roughness: 0.5 }));
    a.position.set(2, 0, 0);
    const b = new Mesh(new SphereGeometry(0.5), new MeshStandardMaterial({ color: '#0000ff', roughness: 0.5 }));
    b.position.set(0, 3, 0);
    const c = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: '#00ff00' }));
    const hidden = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 }));
    hidden.visible = false;
    const inner = new Group();
    inner.scale.setScalar(2);
    inner.add(b);
    root.add(a, inner, c, hidden);
    const out = mergeMeshes(root)!;
    expect(out).toHaveLength(2);
    const std = out.find((m) => (m.material as MeshStandardMaterial).type === 'MeshStandardMaterial')!;
    const mat = std.material as MeshStandardMaterial;
    expect(mat.vertexColors).toBe(true);
    expect(mat.color.getHex()).toBe(0xffffff);
    std.geometry.computeBoundingBox();
    const bb = std.geometry.boundingBox!;
    // In root's frame: the box at x 1.5…2.5, the sphere scaled by 2 at y 6 (radius 1); the hidden box is left out.
    expect(bb.min.x).toBeCloseTo(-1, 5);
    expect(bb.max.x).toBeCloseTo(2.5, 5);
    expect(bb.max.y).toBeCloseTo(7, 5);
    const col = std.geometry.getAttribute('color');
    const reds = Array.from({ length: col.count }, (_, i) => col.getX(i)).filter((r) => r > 0.99).length;
    expect(reds).toBe(36);
  });

  it('refuses subtrees it cannot bake', () => {
    const root = new Group();
    root.add(new Line(new BufferGeometry(), new MeshBasicMaterial()));
    expect(mergeMeshes(root)).toBeNull();
  });
});
