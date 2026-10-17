import * as THREE from 'three';
import { Point3, Stroke3D } from './types';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeCompletedStrokesCenter(
  meshes: THREE.Mesh[],
  target: THREE.Vector3
): THREE.Vector3 {
  if (meshes.length === 0) {
    return target.set(0, 0, 0);
  }

  const box = new THREE.Box3();
  for (const mesh of meshes) {
    if (!mesh.geometry.boundingBox) {
      mesh.geometry.computeBoundingBox();
    }
    if (mesh.geometry.boundingBox) {
      box.union(mesh.geometry.boundingBox);
    }
  }

  if (box.isEmpty()) {
    return target.set(0, 0, 0);
  }

  box.getCenter(target);
  return target;
}

export class RibbonManager {
  private sculptGroup: THREE.Group;
  private completedStrokes: Stroke3D[] = [];
  private completedMeshes: THREE.Mesh[] = [];

  // Active stroke state
  private activePoints: Point3[] = [];
  private activeVectors: THREE.Vector3[] = [];
  private activeMesh: THREE.Mesh | null = null;
  private activeColor: string = '#00F5FF';
  private activeRadius: number = 0.03;
  private lastRebuildTime: number = 0;
  private lastRebuiltPointCount: number = 0;

  // Track the last world coordinate to enforce the 0.01 distance threshold
  private lastWorldPoint: THREE.Vector3 = new THREE.Vector3();
  private hasPoints: boolean = false;

  constructor(sculptGroup: THREE.Group) {
    this.sculptGroup = sculptGroup;
  }

  public getCompletedStrokeCount(): number {
    return this.completedStrokes.length;
  }

  public getCompletedStrokes(): Stroke3D[] {
    return this.completedStrokes;
  }

  public getCompletedMeshes(): THREE.Mesh[] {
    return this.completedMeshes;
  }

  public addPoint(
    worldPoint: THREE.Vector3,
    color: string,
    radius: number,
    timestamp: number
  ): void {
    if (this.hasPoints) {
      if (worldPoint.distanceTo(this.lastWorldPoint) < 0.01) {
        return;
      }
    }

    this.lastWorldPoint.copy(worldPoint);
    this.hasPoints = true;

    // Convert world position into sculptGroup local space BEFORE storing
    const localVec = worldPoint.clone();
    this.sculptGroup.worldToLocal(localVec);

    if (this.activePoints.length === 0) {
      this.activeColor = color;
      this.activeRadius = radius;
      this.createActiveMesh(color);
    }

    const point3: Point3 = {
      x: localVec.x,
      y: localVec.y,
      z: localVec.z,
      time: timestamp,
    };

    this.activePoints.push(point3);
    this.activeVectors.push(localVec);

    // Auto-commit and split if stroke exceeds 500 points to keep geometry lightweight
    if (this.activePoints.length >= 500) {
      const lastPt = this.activePoints[this.activePoints.length - 1];
      const lastVec = this.activeVectors[this.activeVectors.length - 1].clone();

      this.finalizeStroke();

      // Start new contiguous stroke from the exact same last point
      this.createActiveMesh(color);
      this.activePoints.push({ ...lastPt });
      this.activeVectors.push(lastVec);
      this.lastRebuiltPointCount = 1;
    }
  }

  public updateActiveMesh(currentTime: number): void {
    if (!this.activeMesh || this.activeVectors.length < 2) return;

    // Throttle geometry rebuilds to at most once per 33ms (~30 FPS)
    if (
      currentTime - this.lastRebuildTime < 33 ||
      this.activeVectors.length === this.lastRebuiltPointCount
    ) {
      return;
    }

    this.lastRebuildTime = currentTime;
    this.lastRebuiltPointCount = this.activeVectors.length;

    const curve = new THREE.CatmullRomCurve3(
      this.activeVectors,
      false,
      'centripetal'
    );
    const segments = clamp(this.activeVectors.length * 2, 8, 1000);

    const newGeometry = new THREE.TubeGeometry(
      curve,
      segments,
      this.activeRadius,
      8,
      false
    );

    this.activeMesh.geometry.dispose();
    this.activeMesh.geometry = newGeometry;
  }

  public finalizeStroke(): boolean {
    if (!this.activeMesh || this.activePoints.length === 0) {
      this.resetActiveState();
      return false;
    }

    // Apply Phase 1 tail-trim: drop the trailing 3 frames of points
    const trimmedPoints = this.activePoints.slice(
      0,
      Math.max(0, this.activePoints.length - 3)
    );
    const trimmedVectors = this.activeVectors.slice(
      0,
      Math.max(0, this.activeVectors.length - 3)
    );

    // Dispose temporary active mesh
    this.sculptGroup.remove(this.activeMesh);
    this.activeMesh.geometry.dispose();
    if (Array.isArray(this.activeMesh.material)) {
      this.activeMesh.material.forEach((m) => m.dispose());
    } else {
      this.activeMesh.material.dispose();
    }
    this.activeMesh = null;

    if (trimmedVectors.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(
        trimmedVectors,
        false,
        'centripetal'
      );
      // High-fidelity final tube geometry
      const segments = clamp(trimmedVectors.length * 3, 8, 1500);
      const geometry = new THREE.TubeGeometry(
        curve,
        segments,
        this.activeRadius,
        8,
        false
      );

      const material = new THREE.MeshStandardMaterial({
        color: this.activeColor,
        emissive: new THREE.Color(this.activeColor),
        emissiveIntensity: 2.5,
        toneMapped: false,
        roughness: 0.4,
      });

      const finalMesh = new THREE.Mesh(geometry, material);
      finalMesh.matrixAutoUpdate = false;
      finalMesh.updateMatrix();

      this.sculptGroup.add(finalMesh);
      this.completedMeshes.push(finalMesh);

      this.completedStrokes.push({
        points: trimmedPoints,
        color: this.activeColor,
        radius: this.activeRadius,
      });

      this.resetActiveState();
      return true;
    }

    this.resetActiveState();
    return false;
  }

  public clear(): void {
    // Dispose all completed meshes
    for (const mesh of this.completedMeshes) {
      this.sculptGroup.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else {
        mesh.material.dispose();
      }
    }
    this.completedMeshes = [];
    this.completedStrokes = [];

    // Dispose active mesh if present
    if (this.activeMesh) {
      this.sculptGroup.remove(this.activeMesh);
      this.activeMesh.geometry.dispose();
      if (Array.isArray(this.activeMesh.material)) {
        this.activeMesh.material.forEach((m) => m.dispose());
      } else {
        this.activeMesh.material.dispose();
      }
      this.activeMesh = null;
    }

    this.resetActiveState();
  }

  private createActiveMesh(color: string): void {
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color),
      emissiveIntensity: 2.5,
      toneMapped: false,
      roughness: 0.4,
    });

    this.activeMesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.sculptGroup.add(this.activeMesh);
  }

  private resetActiveState(): void {
    this.activePoints = [];
    this.activeVectors = [];
    this.activeMesh = null;
    this.hasPoints = false;
    this.lastRebuiltPointCount = 0;
    this.lastRebuildTime = 0;
  }

  public dispose(): void {
    this.clear();
  }
}
