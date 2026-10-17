'use client';
import { useFrame } from '@react-three/fiber';
import { useRef, useState } from 'react';
import { Character } from './Character';
import { useScene } from './context';

/** Mounts one <Character> per Layer-2 character; re-renders only when that list changes. */
export function Characters({
  selectedAgentId,
  onSelectAgent,
}: {
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
}) {
  const { getFrame } = useScene();
  const [ids, setIds] = useState<readonly string[]>(() => getFrame().state.world.characterOrder);
  const key = useRef(ids.join('|'));

  useFrame(() => {
    const order = getFrame().state.world.characterOrder;
    const k = order.join('|');
    if (k !== key.current) {
      key.current = k;
      setIds(order);
    }
  });

  return (
    <group>
      {ids.map((id) => (
        <Character key={id} agentId={id} selected={id === selectedAgentId} onSelect={onSelectAgent} />
      ))}
    </group>
  );
}
