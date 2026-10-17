import * as THREE from 'three';

const POOL_SIZE = 2500;

export class ParticleSystem {
  public mesh: THREE.InstancedMesh;

  // Typed arrays for particle state (ring-buffered, zero GC allocations)
  private posX: Float32Array = new Float32Array(POOL_SIZE);
  private posY: Float32Array = new Float32Array(POOL_SIZE);
  private posZ: Float32Array = new Float32Array(POOL_SIZE);
  private velX: Float32Array = new Float32Array(POOL_SIZE);
  private velY: Float32Array = new Float32Array(POOL_SIZE);
  private velZ: Float32Array = new Float32Array(POOL_SIZE);
  private age: Float32Array = new Float32Array(POOL_SIZE);
  private maxLife: Float32Array = new Float32Array(POOL_SIZE);
  private damping: Float32Array = new Float32Array(POOL_SIZE);
  private initialScale: Float32Array = new Float32Array(POOL_SIZE);
  private active: Uint8Array = new Uint8Array(POOL_SIZE);

  private cursor: number = 0;
  private activeCount: number = 0;
  private trailAccumulator: number = 0;

  // Reusable dummy object and colors to prevent allocations in hot path
  private dummy: THREE.Object3D = new THREE.Object3D();
  private scratchColor: THREE.Color = new THREE.Color();
  private whiteColor: THREE.Color = new THREE.Color(0xffffff);

  constructor() {
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    const material = new THREE.MeshBasicMaterial({
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.mesh = new THREE.InstancedMesh(geometry, material, POOL_SIZE);
    this.mesh.frustumCulled = false;

    // Initialize all instances as invisible (scale 0)
    this.dummy.position.set(0, 0, 0);
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();

    for (let i = 0; i < POOL_SIZE; i++) {
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.whiteColor);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  public emitTrail(
    pos: THREE.Vector3,
    colorHex: string,
    dt: number
  ): void {
    // Emit ~90 particles/sec frame-rate independently
    this.trailAccumulator += dt * 90;
    const count = Math.floor(this.trailAccumulator);
    if (count > 0) {
      this.trailAccumulator -= count;
      this.scratchColor.set(colorHex);

      for (let k = 0; k < count; k++) {
        const px = pos.x + (Math.random() - 0.5) * 0.015;
        const py = pos.y + (Math.random() - 0.5) * 0.015;
        const pz = pos.z + (Math.random() - 0.5) * 0.015;

        // Upward drift (~0.4 units/s) with slight lateral jitter
        const vx = (Math.random() - 0.5) * 0.08;
        const vy = 0.4 + (Math.random() - 0.5) * 0.08;
        const vz = (Math.random() - 0.5) * 0.08;

        const life = 0.7 + Math.random() * 0.6; // 0.7 - 1.3s
        const scale = 0.018 + Math.random() * 0.01;

        this.spawnParticle(px, py, pz, vx, vy, vz, life, scale, 0.4, this.scratchColor);
      }

      if (this.mesh.instanceColor) {
        this.mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  public emitBurst(
    pos: THREE.Vector3,
    colorHex: string,
    count: number = 150
  ): void {
    const baseColor = this.scratchColor.set(colorHex);

    for (let k = 0; k < count; k++) {
      // Uniform random direction on unit sphere
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const sinPhi = Math.sin(phi);

      const dirX = sinPhi * Math.cos(theta);
      const dirY = sinPhi * Math.sin(theta);
      const dirZ = Math.cos(phi);

      const speed = 1.5 + Math.random() * 2.0; // 1.5 - 3.5 units/s
      const vx = dirX * speed;
      const vy = dirY * speed;
      const vz = dirZ * speed;

      const life = 0.8 + Math.random() * 0.6; // 0.8 - 1.4s
      const scale = 0.024 + Math.random() * 0.018;

      // Color mixed toward bright white
      const particleColor = new THREE.Color()
        .copy(baseColor)
        .lerp(this.whiteColor, 0.4 + Math.random() * 0.4);

      this.spawnParticle(pos.x, pos.y, pos.z, vx, vy, vz, life, scale, 2.5, particleColor);
    }

    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  private spawnParticle(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    scale: number,
    damping: number,
    color: THREE.Color
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % POOL_SIZE;

    if (this.active[i] === 0) {
      this.activeCount++;
    }
    this.active[i] = 1;

    this.posX[i] = x;
    this.posY[i] = y;
    this.posZ[i] = z;
    this.velX[i] = vx;
    this.velY[i] = vy;
    this.velZ[i] = vz;
    this.age[i] = 0;
    this.maxLife[i] = life;
    this.initialScale[i] = scale;
    this.damping[i] = damping;

    this.dummy.position.set(x, y, z);
    this.dummy.scale.setScalar(scale);
    this.dummy.updateMatrix();

    this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.setColorAt(i, color);
  }

  public update(dt: number): void {
    // Skip updating entirely if there are no active particles
    if (this.activeCount === 0) return;

    for (let i = 0; i < POOL_SIZE; i++) {
      if (this.active[i] === 0) continue;

      this.age[i] += dt;
      if (this.age[i] >= this.maxLife[i]) {
        // Particle died: collapse instance scale to zero
        this.active[i] = 0;
        this.activeCount--;

        this.dummy.position.set(0, 0, 0);
        this.dummy.scale.setScalar(0);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }

      // Physics integration with exponential damping
      const damp = Math.exp(-this.damping[i] * dt);
      this.velX[i] *= damp;
      this.velY[i] *= damp;
      this.velZ[i] *= damp;

      this.posX[i] += this.velX[i] * dt;
      this.posY[i] += this.velY[i] * dt;
      this.posZ[i] += this.velZ[i] * dt;

      // Scale shrinks linearly to 0 over particle life
      const remainingLifeRatio = 1 - this.age[i] / this.maxLife[i];
      const currentScale = this.initialScale[i] * Math.max(0, remainingLifeRatio);

      this.dummy.position.set(this.posX[i], this.posY[i], this.posZ[i]);
      this.dummy.scale.setScalar(currentScale);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
  }

  public dispose(): void {
    this.mesh.geometry.dispose();
    if (Array.isArray(this.mesh.material)) {
      this.mesh.material.forEach((m) => m.dispose());
    } else {
      this.mesh.material.dispose();
    }
  }
}
