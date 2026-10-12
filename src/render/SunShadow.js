import { Matrix4, Vector3, WebGPUCoordinateSystem } from 'three';
import { SunLightShadow } from 'three/addons/lights/SunLightShadow.js';

const _lightOrientationMatrix = new Matrix4();
const _viewToLightMatrix = new Matrix4();
const _lightDirection = new Vector3();
const _up = new Vector3();
const _center = new Vector3();
const _nearCorners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const _farCorners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const _cascadeCorners = Array.from({ length: 8 }, () => new Vector3());

const CASCADES = 2; // fixed by three's sun shadow shader chunk

/**
 * Two-cascade sun shadow (three r186 SunLight/SunLightShadow, which every built-in
 * material supports natively) with game-specific fitting:
 *   - shadows start at `nearDistance` (skips empty air below a high camera: the drop
 *     camera at 3 km gets its whole resolution on the ground, not on the sky)
 *   - split position controlled by `lambda` (0 = uniform, 1 = logarithmic)
 *   - the last cascade fades out over `fadeOut` of its depth range instead of a hard cut
 * Atmosphere sets nearDistance / maxDistance every frame from the camera height.
 */
export class FittedSunShadow extends SunLightShadow {
  constructor() {
    super();
    this.nearDistance = 0.5;
    this.maxDistance = 1500;
    this.lambda = 0.8;
    this.cascadeFade = 0.12;
    this.fadeOut = 0.25;
    this.casterHeight = 1600; // how far towards the sun casters may sit outside the view frustum
  }

  updateMatrices(light, viewCamera) {
    if (viewCamera === undefined) return;

    const insetX = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.x);
    const insetY = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.y);
    for (let i = 0; i < CASCADES; i++) this._viewports[i].set(i + insetX, insetY, 1 - 2 * insetX, 1 - 2 * insetY);
    const resolutionX = this.mapSize.x * (1 - 2 * insetX);
    const resolutionY = this.mapSize.y * (1 - 2 * insetY);
    const resolution = Math.min(resolutionX, resolutionY);

    const camera = this.camera;
    const cameraNear = viewCamera.near;
    const far = Math.max(cameraNear + 1, Math.min(this.maxDistance, viewCamera.far));
    const near = Math.min(Math.max(this.nearDistance, cameraNear), far * 0.5);

    // practical split between [near, far]
    const splits = this._cascadeSplits;
    splits[0] = near;
    for (let i = 1; i < CASCADES; i++) {
      const a = i / CASCADES;
      const uniform = near + (far - near) * a;
      const log = near * Math.pow(far / near, a);
      splits[i] = uniform + (log - uniform) * this.lambda;
    }
    splits[CASCADES] = far;

    _lightDirection.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_lightDirection)) > 0.99) _up.set(0, 0, 1);
    _lightOrientationMatrix.lookAt(_center.set(0, 0, 0), _lightDirection, _up);
    _viewToLightMatrix.copy(_lightOrientationMatrix).transpose().multiply(viewCamera.matrixWorld);

    const zNear = viewCamera.reversedDepth ? 1 : viewCamera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1;
    const inverseProjectionMatrix = viewCamera.projectionMatrixInverse;
    let globalMaxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1;
      const y = i === 0 || i === 3 ? 1 : -1;
      const nearCorner = _nearCorners[i].set(x, y, zNear).applyMatrix4(inverseProjectionMatrix);
      // corners at the shadow near / far distances (view space, along the view rays)
      _farCorners[i].copy(nearCorner).multiplyScalar(far / cameraNear);
      nearCorner.multiplyScalar(near / cameraNear);
      nearCorner.applyMatrix4(_viewToLightMatrix);
      _farCorners[i].applyMatrix4(_viewToLightMatrix);
      globalMaxZ = Math.max(globalMaxZ, nearCorner.z, _farCorners[i].z);
    }
    globalMaxZ += this.casterHeight;

    const shadowNear = camera.near;
    for (let i = 0; i < CASCADES; i++) {
      const last = i === CASCADES - 1;
      const cascadeNear = i === 0 ? splits[0] : this._cascadeData[i - 1].z;
      const cascadeFar = splits[i + 1];
      const fade = last ? this.fadeOut : this.cascadeFade;
      const fadeStart = cascadeFar - fade * (cascadeFar - splits[i]);
      this._cascadeData[i].set(i === 0 ? -1e10 : cascadeNear, cascadeFar, fadeStart, 0);

      const nearAlpha = (cascadeNear - near) / (far - near);
      const farAlpha = (cascadeFar - near) / (far - near);
      _center.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        _cascadeCorners[j * 2].lerpVectors(_nearCorners[j], _farCorners[j], nearAlpha);
        _cascadeCorners[j * 2 + 1].lerpVectors(_nearCorners[j], _farCorners[j], farAlpha);
        _center.add(_cascadeCorners[j * 2]).add(_cascadeCorners[j * 2 + 1]);
      }
      _center.multiplyScalar(1 / 8);
      let radiusSq = 0;
      let minZ = Infinity;
      for (let j = 0; j < 8; j++) {
        radiusSq = Math.max(radiusSq, _cascadeCorners[j].distanceToSquared(_center));
        minZ = Math.min(minZ, _cascadeCorners[j].z);
      }
      let radius = Math.sqrt(radiusSq);
      if (resolution > 1) {
        radius /= 1 - 1 / resolution;
        // quantize the radius so FOV / height changes don't make the texel grid swim every frame
        const q = Math.pow(2, Math.ceil(Math.log2(radius)) - 5);
        radius = Math.ceil(radius / q) * q;
        const texelSizeX = (2 * radius) / resolutionX;
        const texelSizeY = (2 * radius) / resolutionY;
        _center.x = Math.round(_center.x / texelSizeX) * texelSizeX;
        _center.y = Math.round(_center.y / texelSizeY) * texelSizeY;
      }
      // light-space minZ minus a margin below the lowest point of the slice
      minZ -= 50;
      _center.z = globalMaxZ + shadowNear;
      _center.applyMatrix4(_lightOrientationMatrix);

      const cascadeCamera = this._cameras[i];
      cascadeCamera.position.copy(_center);
      cascadeCamera.quaternion.setFromRotationMatrix(_lightOrientationMatrix);
      cascadeCamera.left = -radius;
      cascadeCamera.right = radius;
      cascadeCamera.top = radius;
      cascadeCamera.bottom = -radius;
      cascadeCamera.near = shadowNear;
      cascadeCamera.far = globalMaxZ - minZ + 2 * shadowNear;
      cascadeCamera.coordinateSystem = camera.coordinateSystem;
      cascadeCamera._reversedDepth = camera.reversedDepth;
      cascadeCamera.updateProjectionMatrix();
      cascadeCamera.updateMatrixWorld();
      this._updateMatrix(cascadeCamera, this._matrices[i], this._frustums[i], this._viewports[i]);
    }
  }
}
