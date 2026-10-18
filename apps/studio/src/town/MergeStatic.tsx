'use client';
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Group, Material, Mesh } from 'three';
import { mergeMeshes } from './geometry/merge';

/**
 * Draws a static subtree (built by components we do not own, such as the
 * diorama's Props) in a few calls: once mounted, its meshes are baked
 * (transform and colour) into one geometry per distinct material and the
 * original subtree is hidden. Only for content that never changes after it
 * mounts; key the component to rebuild it.
 */
export const MergeStatic = memo(function MergeStatic({ children }: { children: ReactNode }) {
  const src = useRef<Group>(null);
  const [merged, setMerged] = useState<Mesh[] | null>(null);
  const frames = useRef(0);
  useFrame(() => {
    // Wait a frame so every child has mounted; give up (drawing the original) if it cannot be merged.
    if (merged || !src.current || ++frames.current !== 2) return;
    const out = mergeMeshes(src.current);
    if (out) {
      src.current.visible = false;
      setMerged(out);
    }
  });
  useEffect(
    () => () => {
      for (const m of merged ?? []) {
        m.geometry.dispose();
        (m.material as Material).dispose();
      }
    },
    [merged],
  );
  return (
    <>
      <group ref={src}>{children}</group>
      {merged?.map((m) => (
        <primitive key={m.uuid} object={m} />
      ))}
    </>
  );
});
