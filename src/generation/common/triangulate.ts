/**
 * Ear-clipping triangulation for simple polygons, optionally with holes.
 *
 * A pure-TypeScript implementation with no external dependencies. The terrain
 * builder and landmark generators need planar triangulation for arbitrary
 * footprints.
 *
 * Algorithm:
 * 1. If holes are present, bridge them into the outer ring by finding optimal
 *    mutually-visible vertices and inserting bridge edges.
 * 2. Walk the resulting polygon, clipping "ears" (convex vertices whose
 *    diagonal lies entirely inside the polygon).
 *
 * Complexity is O(n²) worst-case, which is fine for the polygon sizes we
 * encounter (typically < 200 vertices per footprint). This is not earcut's
 * z-order hashing optimisation, but it handles concave polygons and holes
 * correctly, which is the hard requirement.
 *
 * Input: polygon vertices as flat [x, y, x, y, ...] arrays. Outer ring is
 * counter-clockwise; holes are clockwise. Output: triangle indices into the
 * vertex array.
 *
 * Engine-agnostic — no three.js.
 */

import type { Vec2 } from '@/types';

// ─── Linked list node for the polygon ring ───────────────────────────────────

interface Node {
  /** Index in the original flat coordinate array (÷2 gives vertex index). */
  i: number;
  x: number;
  y: number;
  prev: Node;
  next: Node;
  /** Steiner point flag (bridge vertex). */
  steiner: boolean;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Triangulate a polygon defined by an outer ring and optional holes.
 *
 * @param outerRing Counter-clockwise 2D points forming the outer boundary.
 * @param holes     Zero or more clockwise rings forming interior holes.
 * @returns Indices into the combined vertex list (outer ring first, then holes
 *          in order). Three indices per triangle.
 */
export function triangulate(outerRing: readonly Vec2[], holes?: readonly Vec2[][]): number[] {
  if (outerRing.length < 3) return [];

  // Convert to flat arrays for internal processing
  const outerFlat = flattenRing(outerRing);
  const holeIndices: number[] = [];
  let allFlat = outerFlat;

  if (holes !== undefined && holes.length > 0) {
    for (const hole of holes) {
      holeIndices.push(allFlat.length / 2);
      allFlat = allFlat.concat(flattenRing(hole));
    }
  }

  return earcutTriangulate(allFlat, holeIndices.length > 0 ? holeIndices : undefined);
}

function flattenRing(ring: readonly Vec2[]): number[] {
  const flat: number[] = [];
  for (const p of ring) {
    flat.push(p.x, p.y);
  }
  return flat;
}

// ─── Core ear-clipping ───────────────────────────────────────────────────────

function earcutTriangulate(data: number[], holeIndices?: number[]): number[] {
  const hasHoles = holeIndices !== undefined && holeIndices.length > 0;
  const outerLen = hasHoles ? (holeIndices[0] ?? data.length / 2) * 2 : data.length;

  let outerNode = linkedList(data, 0, outerLen, true);
  if (outerNode === null) return [];

  const triangles: number[] = [];

  if (hasHoles && holeIndices !== undefined) {
    outerNode = eliminateHoles(data, holeIndices, outerNode);
  }

  earcutLinked(outerNode, triangles, 0);

  return triangles;
}

/**
 * Create a doubly-linked list from a polygon's coordinate flat array.
 * `clockwise` = false means CCW outer ring, which is preserved as-is.
 */
function linkedList(data: number[], start: number, end: number, ccw: boolean): Node | null {
  let last: Node | undefined;

  if (ccw === signedArea(data, start, end) > 0) {
    for (let i = start; i < end; i += 2) {
      last = insertNode(i, data[i] ?? 0, data[i + 1] ?? 0, last);
    }
  } else {
    for (let i = end - 2; i >= start; i -= 2) {
      last = insertNode(i, data[i] ?? 0, data[i + 1] ?? 0, last);
    }
  }

  if (last !== undefined && equals(last, last.next)) {
    removeNode(last);
    last = last.next;
  }

  if (last === undefined) return null;
  last.next.prev = last;
  last.prev.next = last;
  return last;
}

/**
 * Main ear-clipping loop. Pass is used for retry with different heuristics:
 * 0 = normal, 1 = filter collinear, 2 = split remaining.
 */
function earcutLinked(ear: Node | null, triangles: number[], pass: number): void {
  if (ear === null) return;

  let stop = ear;
  let node = ear;

   
  while (true) {
    const prev = node.prev;
    const next = node.next;

    if (isEar(node)) {
      triangles.push(prev.i / 2, node.i / 2, next.i / 2);

      removeNode(node);

      // Skip to the next vertex after removal
      node = next.next;
      stop = next.next;
      continue;
    }

    node = next;
    if (node === stop) {
      // No ears found — try fallback passes
      if (pass === 0) {
        earcutLinked(filterPoints(ear), triangles, 1);
      } else if (pass === 1) {
        const filtered = filterPoints(node);
        if (filtered !== null) {
          earcutLinked(filtered, triangles, 2);
        }
      } else if (pass === 2) {
        splitEarcut(node, triangles);
      }
      return;
    }
  }
}

/**
 * Check if a triangle formed by the vertex and its neighbours is an "ear" —
 * it has positive area and no other polygon vertex lies inside it.
 */
function isEar(ear: Node): boolean {
  const a = ear.prev;
  const b = ear;
  const c = ear.next;

  // Must be convex (positive area in CCW ring)
  if (area(a, b, c) >= 0) return false;

  // Check that no other point in the polygon lies inside this triangle
  let node = c.next;
  while (node !== a) {
    if (
      pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, node.x, node.y) &&
      area(node.prev, node, node.next) >= 0
    ) {
      return false;
    }
    node = node.next;
  }

  return true;
}

/**
 * Last-resort: split the polygon at a diagonal and try each half.
 */
function splitEarcut(start: Node, triangles: number[]): void {
  let a = start;
   
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c: Node = splitPolygon(a, b);

        a = filterPoints(a) ?? a;
        c = filterPoints(c) ?? c;

        earcutLinked(a, triangles, 0);
        earcutLinked(c, triangles, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

// ─── Hole elimination ────────────────────────────────────────────────────────

function eliminateHoles(data: number[], holeIndices: number[], outerNode: Node): Node {
  const queue: Node[] = [];

  for (let i = 0; i < holeIndices.length; i++) {
    const holeIdx = holeIndices[i];
    if (holeIdx === undefined) continue;
    const start = holeIdx * 2;
    const nextHoleIdx = holeIndices[i + 1];
    const end = nextHoleIdx !== undefined ? nextHoleIdx * 2 : data.length;
    const list = linkedList(data, start, end, false);
    if (list !== null) {
      queue.push(getLeftmost(list));
    }
  }

  // Sort holes by leftmost x coordinate
  queue.sort((a, b) => a.x - b.x);

  let outer = outerNode;
  for (const hole of queue) {
    outer = eliminateHole(hole, outer);
  }
  return outer;
}

function eliminateHole(hole: Node, outerNode: Node): Node {
  const bridge = findHoleBridge(hole, outerNode);
  if (bridge === null) return outerNode;

  const bridgeReverse = splitPolygon(bridge, hole);
  filterPoints(bridgeReverse);
  return filterPoints(bridge) ?? outerNode;
}

/**
 * Find the outer polygon vertex visible from the leftmost hole vertex.
 * This is the "bridge" point where we connect hole to outer ring.
 */
function findHoleBridge(hole: Node, outerNode: Node): Node | null {
  let p = outerNode;
  const hx = hole.x;
  const hy = hole.y;
  let bestX = -Infinity;
  let bestNode: Node | null = null;

  // Find rightmost point to the left of the hole point
   
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) / (p.next.y - p.y)) * (p.next.x - p.x);
      if (x <= hx && x > bestX) {
        bestX = x;
        bestNode = p.x < p.next.x ? p : p.next;
      }
    }
    p = p.next;
  } while (p !== outerNode);

  if (bestNode === null) return null;

  // Check if any points inside the triangle (hole, bestX intersection, bestNode)
  // are better candidates (closer and still visible)
  const stop = bestNode;
  const mx = bestNode.x;
  const my = bestNode.y;
  let tanMin = Infinity;
  let result = bestNode;

  p = bestNode;
   
  do {
    if (
      hx >= p.x &&
      p.x >= mx &&
      hx !== p.x &&
      pointInTriangle(
        hy < my ? hx : bestX,
        hy,
        mx,
        my,
        hy < my ? bestX : hx,
        hy,
        p.x,
        p.y,
      )
    ) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && sectorContainsSector(p, result)))) {
        result = p;
        tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);

  return result;
}

function sectorContainsSector(a: Node, b: Node): boolean {
  return area(a.prev, a, b.prev) < 0 && area(b.next, a, a.next) < 0;
}

// ─── Geometry helpers ────────────────────────────────────────────────────────

function signedArea(data: number[], start: number, end: number): number {
  let sum = 0;
  let j = end - 2;
  for (let i = start; i < end; i += 2) {
    sum += ((data[j] ?? 0) - (data[i] ?? 0)) * ((data[i + 1] ?? 0) + (data[j + 1] ?? 0));
    j = i;
  }
  return sum;
}

function area(p: Node, q: Node, r: Node): number {
  return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

function pointInTriangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
): boolean {
  return (
    (cx - px) * (ay - py) - (ax - px) * (cy - py) >= 0 &&
    (ax - px) * (by - py) - (bx - px) * (ay - py) >= 0 &&
    (bx - px) * (cy - py) - (cx - px) * (by - py) >= 0
  );
}

function equals(a: Node, b: Node): boolean {
  return a.x === b.x && a.y === b.y;
}

function locallyInside(a: Node, b: Node): boolean {
  return area(a.prev, a, a.next) < 0
    ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
    : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

function isValidDiagonal(a: Node, b: Node): boolean {
  return (
    a.next.i !== b.i &&
    a.prev.i !== b.i &&
    !intersectsPolygon(a, b) &&
    ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b)) ||
      (equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0))
  );
}

function intersectsPolygon(a: Node, b: Node): boolean {
  let p = a;
   
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) {
      return true;
    }
    p = p.next;
  } while (p !== a);
  return false;
}

function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
  const o1 = sign(area(p1, q1, p2));
  const o2 = sign(area(p1, q1, q2));
  const o3 = sign(area(p2, q2, p1));
  const o4 = sign(area(p2, q2, q1));

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

function onSegment(p: Node, q: Node, r: Node): boolean {
  return (
    q.x <= Math.max(p.x, r.x) &&
    q.x >= Math.min(p.x, r.x) &&
    q.y <= Math.max(p.y, r.y) &&
    q.y >= Math.min(p.y, r.y)
  );
}

function middleInside(a: Node, b: Node): boolean {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  let p = a;
  let inside = false;
   
  do {
    if (p.y > my !== p.next.y > my && p.next.y !== p.y && mx < ((p.next.x - p.x) * (my - p.y)) / (p.next.y - p.y) + p.x) {
      inside = !inside;
    }
    p = p.next;
  } while (p !== a);
  return inside;
}

function getLeftmost(start: Node): Node {
  let p = start;
  let leftmost = start;
   
  do {
    if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) {
      leftmost = p;
    }
    p = p.next;
  } while (p !== start);
  return leftmost;
}

// ─── Linked-list operations ──────────────────────────────────────────────────

function insertNode(i: number, x: number, y: number, last: Node | undefined): Node {
  const node: Node = {
    i,
    x,
    y,
    prev: null as unknown as Node,
    next: null as unknown as Node,
    steiner: false,
  };

  if (last === undefined) {
    node.prev = node;
    node.next = node;
  } else {
    node.next = last.next;
    node.prev = last;
    last.next.prev = node;
    last.next = node;
  }

  return node;
}

function removeNode(p: Node): void {
  p.next.prev = p.prev;
  p.prev.next = p.next;
}

function filterPoints(start: Node | null): Node | null {
  if (start === null) return null;

  let end = start;
  let p = start;
  let again: boolean;

  do {
    again = false;
    if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
      removeNode(p);
      p = end = p.prev;
      if (p === p.next) return null;
      again = true;
    } else {
      p = p.next;
    }
  } while (again || p !== end);

  return end;
}

function splitPolygon(a: Node, b: Node): Node {
  const a2: Node = {
    i: a.i,
    x: a.x,
    y: a.y,
    prev: null as unknown as Node,
    next: null as unknown as Node,
    steiner: false,
  };

  const b2: Node = {
    i: b.i,
    x: b.x,
    y: b.y,
    prev: null as unknown as Node,
    next: null as unknown as Node,
    steiner: false,
  };

  const an = a.next;
  const bp = b.prev;

  a.next = b;
  b.prev = a;

  a2.next = an;
  an.prev = a2;

  b2.next = a2;
  a2.prev = b2;

  bp.next = b2;
  b2.prev = bp;

  return b2;
}
