'use client';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Color, type AmbientLight, type DirectionalLight, type HemisphereLight } from 'three';
import { useTown } from './context';
import { skyAt } from './sky';

/**
 * Day and night from the world clock (DL-011): the sun (or the moon) as a
 * shadow-casting key light, a hemisphere fill and an ambient term, all from
 * skyAt(minute), plus the shared uNight uniform that lights windows, lamps
 * and signs. The shadow map is static geometry only, so it is re-rendered
 * only when the light has turned (about every few sim minutes), not per frame.
 * Shadows are variance shadow maps: soft, and (unlike hardware PCF compare
 * samplers) they also render under SwiftShader, where budgets are measured.
 */
export function SkyRig({ shadows, mapSize }: { shadows: boolean; mapSize: number }) {
  const { town, frame, uniforms } = useTown();
  const gl = useThree((s) => s.gl);
  const key = useRef<DirectionalLight>(null);
  const hemi = useRef<HemisphereLight>(null);
  const amb = useRef<AmbientLight>(null);
  const lastDir = useRef<[number, number, number] | null>(null);
  const span = Math.max(town.width, town.height) / 2 + 6;

  useEffect(() => {
    gl.shadowMap.enabled = shadows;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    lastDir.current = null;
  }, [gl, shadows]);

  useEffect(() => {
    const l = key.current;
    if (!l) return;
    // The shadow camera covers the whole town (props set its bounds, but only this applies them).
    const cam = l.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.near = 1;
    cam.far = 220;
    cam.updateProjectionMatrix();
    l.shadow.mapSize.set(mapSize, mapSize);
    l.shadow.map?.dispose();
    l.shadow.map = null;
    gl.shadowMap.needsUpdate = true;
  }, [mapSize, gl, span]);

  useFrame(() => {
    const s = skyAt(frame.minute);
    frame.sky = s;
    uniforms.uNight.value = s.night;
    const l = key.current;
    if (l) {
      l.color.set(s.sunColor);
      l.intensity = s.sunIntensity;
      l.position.set(s.sunDir[0] * 90, s.sunDir[1] * 90, s.sunDir[2] * 90);
      l.target.position.set(0, 0, 0);
      l.target.updateMatrixWorld();
      const prev = lastDir.current;
      const turned = !prev || prev[0] * s.sunDir[0] + prev[1] * s.sunDir[1] + prev[2] * s.sunDir[2] < Math.cos((0.6 * Math.PI) / 180);
      if (turned && shadows) {
        lastDir.current = [...s.sunDir];
        gl.shadowMap.needsUpdate = true;
      }
    }
    if (hemi.current) {
      hemi.current.color.set(s.hemiSky);
      hemi.current.groundColor.set(s.hemiGround);
      hemi.current.intensity = s.hemi;
    }
    if (amb.current) {
      amb.current.color.set(s.ambientColor);
      amb.current.intensity = s.ambient;
    }
  });

  return (
    <>
      <ambientLight ref={amb} intensity={0.5} color={new Color('#ffffff')} />
      <hemisphereLight ref={hemi} args={['#d2e4f4', '#8a7a62', 0.9]} />
      <directionalLight
        ref={key}
        castShadow={shadows}
        intensity={2}
        shadow-mapSize={[mapSize, mapSize]}
        shadow-bias={-0.0006}
        shadow-normalBias={0.02}
        shadow-radius={6}
        shadow-blurSamples={10}
        shadow-camera-left={-span}
        shadow-camera-right={span}
        shadow-camera-top={span}
        shadow-camera-bottom={-span}
        shadow-camera-near={1}
        shadow-camera-far={220}
      />
    </>
  );
}
