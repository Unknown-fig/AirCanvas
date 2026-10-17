import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RibbonManager, computeCompletedStrokesCenter } from './ribbon';
import { ParticleSystem } from './particles';

export const BLOOM_STRENGTH = 1.5;
export const BLOOM_RADIUS = 0.5;
export const BLOOM_THRESHOLD = 0.2;
export const ORBIT_SPEED = Math.PI * 1.5; // Radians per normalized screen width

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

export class SculptScene {
  public renderer: THREE.WebGLRenderer;
  public camera: THREE.PerspectiveCamera;
  public scene: THREE.Scene;

  // Orbit rotation hierarchy: pivotGroup handles rotation around the strokes bounding center
  public pivotGroup: THREE.Group;
  public sculptGroup: THREE.Group;
  private pivotCenter: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

  public ribbons: RibbonManager;
  public particles: ParticleSystem;
  public composer: EffectComposer;
  private bloomPass: UnrealBloomPass;

  // Orbit state
  private yaw: number = 0;
  private pitch: number = 0;
  private yawVelocity: number = 0;
  private pitchVelocity: number = 0;
  private prevFistX: number | null = null;
  private prevFistY: number | null = null;
  private isResettingView: boolean = false;

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    // 1. WebGL Renderer with alpha support
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // ALPHA CAVEAT WORKAROUND:
    // UnrealBloomPass makes WebGL transparency opaque.
    // By clearing to pure black (0x000000, 1.0) and setting the canvas CSS to `mix-blend-mode: screen`,
    // black areas remain 100% transparent to the underlying webcam feed, while bloom glows additively.
    this.renderer.setClearColor(0x000000, 1.0);

    // 2. Perspective Camera (fov 60, aspect, near 0.1, far 100) looking at origin from (0, 0, 5)
    const aspect = width > 0 && height > 0 ? width / height : 1;
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
    this.camera.position.set(0, 0, 5);
    this.camera.lookAt(0, 0, 0);

    // 3. Scene & Lights
    this.scene = new THREE.Scene();
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(2, 3, 4);
    this.scene.add(dirLight);

    // 4. Orbit Hierarchy: scene -> pivotGroup -> sculptGroup
    this.pivotGroup = new THREE.Group();
    this.sculptGroup = new THREE.Group();
    this.pivotGroup.add(this.sculptGroup);
    this.scene.add(this.pivotGroup);

    // 5. Ribbon and Particle Subsystems
    this.ribbons = new RibbonManager(this.sculptGroup);
    this.particles = new ParticleSystem();
    this.scene.add(this.particles.mesh);

    // 6. Post-processing Composer
    this.composer = new EffectComposer(this.renderer);
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD
    );
    this.composer.addPass(this.bloomPass);

    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);
  }

  public setSize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
  }

  /**
   * Recalculates the orbit pivot to the center of all completed ribbon bounding boxes.
   * Fallback is (0, 0, 0) if no strokes exist.
   */
  public updateOrbitPivot(): void {
    computeCompletedStrokesCenter(
      this.ribbons.getCompletedMeshes(),
      this.pivotCenter
    );

    this.pivotGroup.position.copy(this.pivotCenter);
    this.sculptGroup.position.copy(this.pivotCenter).negate();
    this.sculptGroup.updateMatrixWorld(true);
  }

  public updateOrbit(
    isFist: boolean,
    hand9ScreenX: number | null,
    hand9ScreenY: number | null,
    containerWidth: number,
    dt: number
  ): void {
    if (this.isResettingView) {
      // Smoothly return yaw and pitch back to zero
      const lerpFactor = 1 - Math.exp(-8.0 * dt);
      this.yaw = lerp(this.yaw, 0, lerpFactor);
      this.pitch = lerp(this.pitch, 0, lerpFactor);

      if (Math.abs(this.yaw) < 0.001 && Math.abs(this.pitch) < 0.001) {
        this.yaw = 0;
        this.pitch = 0;
        this.isResettingView = false;
      }

      this.pivotGroup.rotation.y = this.yaw;
      this.pivotGroup.rotation.x = this.pitch;
      this.pivotGroup.updateMatrixWorld(true);
      return;
    }

    if (isFist && hand9ScreenX !== null && hand9ScreenY !== null && containerWidth > 0) {
      if (this.prevFistX !== null && this.prevFistY !== null && dt > 0.001) {
        const dx = (hand9ScreenX - this.prevFistX) / containerWidth;
        const dy = (hand9ScreenY - this.prevFistY) / containerWidth;

        const deltaYaw = dx * ORBIT_SPEED;
        const deltaPitch = dy * ORBIT_SPEED;

        this.yaw += deltaYaw;
        this.pitch += deltaPitch;

        // Clamp pitch to ±80 degrees (±1.396 radians)
        this.pitch = Math.max(-1.396, Math.min(1.396, this.pitch));

        this.yawVelocity = deltaYaw / dt;
        this.pitchVelocity = deltaPitch / dt;
      }

      this.prevFistX = hand9ScreenX;
      this.prevFistY = hand9ScreenY;
    } else {
      this.prevFistX = null;
      this.prevFistY = null;

      // Apply damped exponential inertia after fist release
      if (Math.abs(this.yawVelocity) > 0.001 || Math.abs(this.pitchVelocity) > 0.001) {
        const damp = Math.exp(-4.5 * dt);
        this.yaw += this.yawVelocity * dt;
        this.pitch += this.pitchVelocity * dt;

        this.pitch = Math.max(-1.396, Math.min(1.396, this.pitch));

        this.yawVelocity *= damp;
        this.pitchVelocity *= damp;
      }
    }

    this.pivotGroup.rotation.y = this.yaw;
    this.pivotGroup.rotation.x = this.pitch;
    this.pivotGroup.updateMatrixWorld(true);
  }

  public resetView(): void {
    this.isResettingView = true;
    this.yawVelocity = 0;
    this.pitchVelocity = 0;
  }

  public render(dt: number, bloomEnabled: boolean): void {
    this.particles.update(dt);

    if (bloomEnabled) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  public clear(): void {
    this.ribbons.clear();
    this.updateOrbitPivot();
  }

  public dispose(): void {
    this.ribbons.dispose();
    this.particles.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
