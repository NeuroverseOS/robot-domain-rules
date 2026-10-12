/**
 * Example adapter: semantic volumes → rulebook areas.
 *
 * aukilabs/domain-harness stores authored boxes in a collection named
 * `spatial-harness.semantic-volumes/v1` (metres and radians; each volume has
 * a stable id, a required title, an optional description, a centre, a base
 * elevation, width, depth, height and a rotation about Y). This file maps
 * that shape — as described in their README, not fetched from it — onto the
 * areas a rulebook declares:
 *
 *   area.id   = volume.id          (the ID your spatial system will report)
 *   area.name = volume.title
 *   area.tags = words after '#' in the description — a convention THIS
 *               example suggests so a volume can say "#staff-only"; it is
 *               not part of the harness.
 *
 * `volumeAt(pose, volumes)` is an OPTIONAL helper for the replay: a
 * point-in-oriented-box test so the sample can turn a pose into an area.
 * In production your spatial system decides membership; this core never
 * does (PRINCIPLES.md § 9, BOUNDARY.md). It is here only so the example runs
 * on its own.
 */

import type { AreaDef } from '../../src/index';

export interface SemanticVolume {
  id: string;
  title: string;
  description?: string;
  /** Centre of the footprint, metres. `y` is ignored for membership; `baseElevation` and `height` bound it. */
  center: { x: number; y: number; z: number };
  baseElevation: number;
  width: number;
  depth: number;
  height: number;
  /** Rotation about the Y (up) axis, radians. */
  rotationY: number;
}

export interface SemanticVolumesCollection {
  collection: 'spatial-harness.semantic-volumes/v1';
  volumes: SemanticVolume[];
}

/** Tags are the `#words` in the description — a suggested convention, not the harness's. */
export function tagsOf(volume: SemanticVolume): string[] {
  return [...(volume.description ?? '').matchAll(/#([\w-]+)/g)].map(m => m[1]);
}

export function volumesToAreas(collection: SemanticVolumesCollection): AreaDef[] {
  if (collection.collection !== 'spatial-harness.semantic-volumes/v1') throw new Error(`Expected collection spatial-harness.semantic-volumes/v1, got ${collection.collection}`);
  return collection.volumes.map(v => {
    if (!v.id || !v.title) throw new Error(`Volume needs an id and a title: ${JSON.stringify(v)}`);
    const tags = tagsOf(v);
    return { id: v.id, name: v.title, ...(tags.length ? { tags } : {}) };
  });
}

/**
 * EXAMPLE ONLY — which volume a point is in, or null. Oriented-box test:
 * translate to the volume's centre, rotate by -rotationY about Y, compare
 * with half-extents; elevation between baseElevation and baseElevation + height.
 * First match wins when volumes overlap. In production the spatial system
 * reports the area; do not ship this.
 */
export function volumeAt(pose: { x: number; y: number; z: number }, volumes: SemanticVolume[]): SemanticVolume | null {
  for (const v of volumes) {
    const dx = pose.x - v.center.x, dz = pose.z - v.center.z;
    const c = Math.cos(-v.rotationY), s = Math.sin(-v.rotationY);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    if (Math.abs(lx) <= v.width / 2 && Math.abs(lz) <= v.depth / 2 && pose.y >= v.baseElevation && pose.y <= v.baseElevation + v.height) return v;
  }
  return null;
}
