import { INPUT_CONFIG } from '../config';
import type { InputState } from '../types';

export interface InputCallbacks {
  onFirstGesture?: () => void;
  onPauseToggle?: () => void;
  onRestart?: () => void;
  onStartConfirm?: () => void;
  onMuteToggle?: () => void;
  onInputDeviceChange?: (device: 'touch' | 'keyboard' | 'gamepad') => void;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function expApproach(current: number, target: number, rate: number, dt: number): number {
  const alpha = 1 - Math.exp(-rate * dt);
  return current + (target - current) * alpha;
}

/**
 * Mobile-Chrome-first + Desktop Keyboard + Steam Deck Gamepad input manager.
 *
 * Touch / Pointer controls (on canvas):
 *  - Horizontal thumb-drag anywhere: continuous responsive kayaking steering (-1..1)
 *    with soft floating anchor and gentle return-to-center on lift.
 *  - Upward swipe: crisp Jump (or breach out of dive).
 *  - Downward swipe & hold: stays Diving while finger remains held down (while
 *    continuing to allow smooth left/right underwater steering!).
 *  - Multi-touch friendly virtual Jump & Hold-Dive buttons via setVirtualJump/Dive.
 *
 * Keyboard controls:
 *  - A / ArrowLeft & D / ArrowRight: steer
 *  - W / ArrowUp / Space: jump
 *  - S / ArrowDown: hold to dive
 *  - P / Escape: pause
 *  - R / Enter: quick restart / confirm
 *  - M: mute toggle
 */
export class InputManager {
  private element: HTMLElement | null = null;
  private callbacks: InputCallbacks = {};
  private attached = false;
  private gestureNotified = false;

  // Keyboard state
  private keys = new Set<string>();
  private keySteerSmoothed = 0;

  // Pointer / Touch drag & swipe state
  private steerPointerId: number | null = null;
  private anchorX = 0;
  private verticalAnchorY = 0;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private lastPointerTime = 0;
  private diveLowestY = 0;
  private touchSteerTarget = 0;
  private touchSteerSmoothed = 0;
  private gestureDiveHeld = false;

  // Virtual HUD button state (multi-touch independent of canvas steering thumb)
  private virtualJumpHeld = false;
  private virtualDiveHeld = false;

  // Gamepad edge tracking
  private prevGamepadJump = false;
  private prevGamepadPause = false;
  private gamepadDiveHeld = false;
  private gamepadJumpHeld = false;
  private gamepadSteer = 0;

  // Pending edge latches (consumed on frame latch / consume*)
  private pendingJump = false;
  private pendingPause = false;
  private pendingRestart = false;
  private pendingSteerDelta = 0;
  private prevDiveHeld = false;

  // Latched frame snapshot
  private lastTickMs = 0;
  private explicitUpdateUsed = false;
  private inputDevice: 'touch' | 'keyboard' | 'gamepad' = 'keyboard';
  private snapshot: InputState = {
    steer: 0,
    steerDelta: 0,
    jumpPressed: false,
    jumpHeld: false,
    diveHeld: false,
    diveJustPressed: false,
    diveJustReleased: false,
    pausePressed: false,
    pointerActive: false,
    inputDevice: 'keyboard',
  };

  constructor(callbacks?: InputCallbacks) {
    if (callbacks) {
      this.callbacks = { ...callbacks };
    }
    if (
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)
    ) {
      this.inputDevice = 'touch';
      this.snapshot.inputDevice = 'touch';
    }
  }

  public setCallbacks(callbacks: InputCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Attach pointer, touch, and keyboard listeners to the interactive game surface.
   */
  public attach(element: HTMLElement): void {
    if (this.attached) {
      this.dispose();
    }
    this.element = element;
    this.attached = true;
    this.lastTickMs = typeof performance !== 'undefined' ? performance.now() : 0;

    element.style.touchAction = 'none';
    element.style.userSelect = 'none';

    element.addEventListener('pointerdown', this.handlePointerDown);
    element.addEventListener('pointermove', this.handlePointerMove);
    element.addEventListener('pointerup', this.handlePointerUp);
    element.addEventListener('pointercancel', this.handlePointerUp);
    element.addEventListener('touchstart', this.handleTouchPrevent, { passive: false });
    element.addEventListener('touchmove', this.handleTouchPrevent, { passive: false });
    element.addEventListener('contextmenu', this.handleContextMenu);

    window.addEventListener('keydown', this.handleKeyDown, { passive: false });
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  /**
   * Cleanly detach all DOM listeners and reset state.
   */
  public dispose(): void {
    if (!this.attached) return;
    this.attached = false;

    if (this.element) {
      this.element.removeEventListener('pointerdown', this.handlePointerDown);
      this.element.removeEventListener('pointermove', this.handlePointerMove);
      this.element.removeEventListener('pointerup', this.handlePointerUp);
      this.element.removeEventListener('pointercancel', this.handlePointerUp);
      this.element.removeEventListener('touchstart', this.handleTouchPrevent);
      this.element.removeEventListener('touchmove', this.handleTouchPrevent);
      this.element.removeEventListener('contextmenu', this.handleContextMenu);
      this.element = null;
    }

    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);

    this.reset();
  }

  /**
   * Clear held inputs and active touches (call on pause, game over, or tab blur).
   */
  public reset(): void {
    this.keys.clear();
    this.steerPointerId = null;
    this.touchSteerTarget = 0;
    this.touchSteerSmoothed = 0;
    this.keySteerSmoothed = 0;
    this.gestureDiveHeld = false;
    this.virtualJumpHeld = false;
    this.virtualDiveHeld = false;
    this.gamepadDiveHeld = false;
    this.gamepadJumpHeld = false;
    this.gamepadSteer = 0;
    this.pendingJump = false;
    this.pendingPause = false;
    this.pendingRestart = false;
    this.pendingSteerDelta = 0;
    this.prevDiveHeld = false;

    this.snapshot = {
      steer: 0,
      steerDelta: 0,
      jumpPressed: false,
      jumpHeld: false,
      diveHeld: false,
      diveJustPressed: false,
      diveJustReleased: false,
      pausePressed: false,
      pointerActive: false,
      inputDevice: this.inputDevice,
    };
  }

  /**
   * Optional explicit per-frame tick. If callers invoke `update(dt)` once per frame,
   * `getState()` returns the stable latched snapshot for the remainder of that frame.
   * If callers only call `getState()`, it auto-ticks seamlessly using `performance.now()`.
   */
  public update(dt?: number): void {
    this.explicitUpdateUsed = true;
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const stepDt =
      dt !== undefined && Number.isFinite(dt)
        ? clamp(dt, 0.001, 0.1)
        : clamp((now - this.lastTickMs) / 1000, 0.001, 0.1);
    this.lastTickMs = now;
    this.latchFrame(stepDt);
  }

  /**
   * Returns a snapshot of the current frame's unified InputState.
   */
  public getState(): InputState {
    if (!this.explicitUpdateUsed) {
      const now = typeof performance !== 'undefined' ? performance.now() : 0;
      const elapsedMs = now - this.lastTickMs;
      // Avoid double-latching if getState() is queried multiple times within the same frame.
      if (elapsedMs >= 4 || this.lastTickMs === 0) {
        const dt = this.lastTickMs === 0 ? 1 / 60 : clamp(elapsedMs / 1000, 0.001, 0.1);
        this.lastTickMs = now;
        this.latchFrame(dt);
      }
    }
    return { ...this.snapshot };
  }

  /**
   * Consume a queued jump edge once (prevents double-triggering across substeps).
   */
  public consumeJump(): boolean {
    const had = this.snapshot.jumpPressed || this.pendingJump;
    this.snapshot.jumpPressed = false;
    this.pendingJump = false;
    return had;
  }

  /**
   * Consume a queued pause toggle edge once.
   */
  public consumePause(): boolean {
    const had = this.snapshot.pausePressed || this.pendingPause;
    this.snapshot.pausePressed = false;
    this.pendingPause = false;
    return had;
  }

  /**
   * Consume a queued quick-restart edge (R / Enter) once.
   */
  public consumeRestart(): boolean {
    const had = this.pendingRestart;
    this.pendingRestart = false;
    return had;
  }

  /**
   * Hook for optional on-screen mobile Jump button.
   */
  public setVirtualJump(pressed: boolean): void {
    this.notifyFirstGesture();
    this.setDevice('touch');
    if (pressed && !this.virtualJumpHeld) {
      this.queueJump();
    }
    this.virtualJumpHeld = pressed;
  }

  /**
   * Hook for optional on-screen mobile Hold-Dive button.
   */
  public setVirtualDive(held: boolean): void {
    this.notifyFirstGesture();
    this.setDevice('touch');
    this.virtualDiveHeld = held;
  }

  public getInputDevice(): 'touch' | 'keyboard' | 'gamepad' {
    return this.inputDevice;
  }

  // ---------------------------------------------------------------------------
  // Internal Frame Latching & Gamepad Poll
  // ---------------------------------------------------------------------------

  private latchFrame(dt: number): void {
    this.pollGamepad();

    // Keyboard steering with responsive ramp + return-to-center
    const keyLeft = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const keyRight = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    const rawKeySteer = (keyRight ? 1 : 0) - (keyLeft ? 1 : 0);
    const keyRate = rawKeySteer !== 0 ? 18 : 14;
    this.keySteerSmoothed = expApproach(this.keySteerSmoothed, rawKeySteer, keyRate, dt);
    if (Math.abs(this.keySteerSmoothed) < 0.005 && rawKeySteer === 0) {
      this.keySteerSmoothed = 0;
    }

    // Touch steering: crisp tracking while held, gentle return-to-center on lift
    const pointerActive = this.steerPointerId !== null;
    if (!pointerActive) {
      this.touchSteerTarget = 0;
    }
    const touchRate = pointerActive ? 24 : 9.5;
    this.touchSteerSmoothed = expApproach(
      this.touchSteerSmoothed,
      this.touchSteerTarget,
      touchRate,
      dt,
    );
    if (!pointerActive && Math.abs(this.touchSteerSmoothed) < 0.005) {
      this.touchSteerSmoothed = 0;
    }

    // Combine steering inputs cleanly without exceeding [-1, 1]
    const combinedSteer = clamp(
      this.touchSteerSmoothed + this.keySteerSmoothed + this.gamepadSteer,
      -1,
      1,
    );

    const keyJumpHeld =
      this.keys.has('Space') || this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const keyDiveHeld = this.keys.has('KeyS') || this.keys.has('ArrowDown');

    const jumpHeld = keyJumpHeld || this.virtualJumpHeld || this.gamepadJumpHeld;
    const diveHeld =
      keyDiveHeld || this.gestureDiveHeld || this.virtualDiveHeld || this.gamepadDiveHeld;

    const diveJustPressed = diveHeld && !this.prevDiveHeld;
    const diveJustReleased = !diveHeld && this.prevDiveHeld;
    this.prevDiveHeld = diveHeld;

    this.snapshot = {
      steer: combinedSteer,
      steerDelta: this.pendingSteerDelta,
      jumpPressed: this.pendingJump,
      jumpHeld,
      diveHeld,
      diveJustPressed,
      diveJustReleased,
      pausePressed: this.pendingPause,
      pointerActive,
      inputDevice: this.inputDevice,
    };

    this.pendingJump = false;
    this.pendingPause = false;
    this.pendingSteerDelta = 0;
  }

  private pollGamepad(): void {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return;
    }
    let pads: (Gamepad | null)[];
    try {
      pads = navigator.getGamepads();
    } catch {
      return;
    }

    let pad: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) {
      if (pads[i]?.connected) {
        pad = pads[i];
        break;
      }
    }
    if (!pad) {
      this.gamepadSteer = 0;
      this.gamepadJumpHeld = false;
      this.gamepadDiveHeld = false;
      return;
    }

    const deadzone = 0.14;
    const axisX = pad.axes[0] ?? 0;
    const dpadLeft = pad.buttons[14]?.pressed ? -1 : 0;
    const dpadRight = pad.buttons[15]?.pressed ? 1 : 0;
    let stick = 0;
    if (Math.abs(axisX) > deadzone) {
      const sign = Math.sign(axisX);
      stick = sign * ((Math.abs(axisX) - deadzone) / (1 - deadzone));
    }
    this.gamepadSteer = clamp(stick + dpadLeft + dpadRight, -1, 1);

    const jumpBtn = Boolean(pad.buttons[0]?.pressed || pad.buttons[5]?.pressed);
    const diveBtn = Boolean(
      pad.buttons[1]?.pressed ||
        pad.buttons[4]?.pressed ||
        (pad.buttons[6]?.value ?? 0) > 0.35 ||
        (pad.buttons[7]?.value ?? 0) > 0.35,
    );
    const pauseBtn = Boolean(pad.buttons[9]?.pressed);

    if (
      Math.abs(this.gamepadSteer) > 0.05 ||
      jumpBtn ||
      diveBtn ||
      pauseBtn
    ) {
      this.notifyFirstGesture();
      this.setDevice('gamepad');
    }

    if (jumpBtn && !this.prevGamepadJump) {
      this.queueJump();
      this.callbacks.onStartConfirm?.();
    }
    if (pauseBtn && !this.prevGamepadPause) {
      this.pendingPause = true;
      this.callbacks.onPauseToggle?.();
    }

    this.prevGamepadJump = jumpBtn;
    this.prevGamepadPause = pauseBtn;
    this.gamepadJumpHeld = jumpBtn;
    this.gamepadDiveHeld = diveBtn;
  }

  private queueJump(): void {
    this.pendingJump = true;
    // Jumping while gesture-diving cleanly breaches out of dive!
    if (this.gestureDiveHeld) {
      this.gestureDiveHeld = false;
    }
  }

  private notifyFirstGesture(): void {
    if (!this.gestureNotified) {
      this.gestureNotified = true;
      this.callbacks.onFirstGesture?.();
    }
  }

  private setDevice(device: 'touch' | 'keyboard' | 'gamepad'): void {
    if (this.inputDevice !== device) {
      this.inputDevice = device;
      this.snapshot.inputDevice = device;
      this.callbacks.onInputDeviceChange?.(device);
    }
  }

  // ---------------------------------------------------------------------------
  // DOM Event Handlers
  // ---------------------------------------------------------------------------

  private readonly handleTouchPrevent = (e: TouchEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-hud-interactive]')) return;
    if (e.cancelable) {
      e.preventDefault();
    }
  };

  private readonly handleContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private readonly handlePointerDown = (e: PointerEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-hud-interactive]')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    this.notifyFirstGesture();
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      this.setDevice('touch');
    }

    // Track primary steering finger; allow secondary touches on HUD buttons simultaneously
    if (this.steerPointerId !== null) return;

    this.steerPointerId = e.pointerId;
    this.anchorX = e.clientX;
    this.verticalAnchorY = e.clientY;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
    this.diveLowestY = e.clientY;
    this.lastPointerTime = e.timeStamp || performance.now();
    this.touchSteerTarget = 0;

    if (this.element && typeof this.element.setPointerCapture === 'function') {
      try {
        this.element.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events in automated browsers may not support pointer capture.
      }
    }
  };

  private readonly handlePointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.steerPointerId) return;

    const now = e.timeStamp || performance.now();
    const dtMs = Math.max(1, now - this.lastPointerTime);
    const vw = Math.max(240, window.innerWidth || 390);
    const fullRangePx = Math.max(76, vw * INPUT_CONFIG.touchDragFullRange);

    const frameDx = e.clientX - this.lastPointerX;
    const frameDy = e.clientY - this.lastPointerY;
    this.pendingSteerDelta += frameDx / vw;

    // Continuous horizontal kayaking steering with soft floating anchor
    let dxFromAnchor = e.clientX - this.anchorX;
    if (Math.abs(dxFromAnchor) > fullRangePx) {
      // Gently pull anchor behind thumb past full throw so reversing feels instant
      const excess = dxFromAnchor - Math.sign(dxFromAnchor) * fullRangePx;
      this.anchorX += excess * 0.85;
      dxFromAnchor = e.clientX - this.anchorX;
    }
    this.touchSteerTarget = clamp(dxFromAnchor / fullRangePx, -1, 1);

    // Vertical gestures: Upward swipe -> Jump; Downward swipe & hold -> Dive
    const dyFromAnchor = e.clientY - this.verticalAnchorY;
    const vyPxPerMs = frameDy / dtMs;

    if (!this.gestureDiveHeld) {
      const quickUpFlick = dyFromAnchor <= -20 && vyPxPerMs <= -0.48;
      if (dyFromAnchor <= -INPUT_CONFIG.swipeUpThresholdPx || quickUpFlick) {
        this.queueJump();
        this.verticalAnchorY = e.clientY;
      } else if (dyFromAnchor >= INPUT_CONFIG.swipeDownThresholdPx) {
        this.gestureDiveHeld = true;
        this.diveLowestY = e.clientY;
      } else if (Math.abs(frameDx) > Math.abs(frameDy) * 2.2 && Math.abs(dyFromAnchor) < 16) {
        // During pure horizontal carving, gently recenter vertical anchor to prevent accidental drift
        this.verticalAnchorY = lerpValue(this.verticalAnchorY, e.clientY, 0.14);
      }
    } else {
      // Stay diving while finger remains held down!
      if (e.clientY > this.diveLowestY) {
        this.diveLowestY = e.clientY;
      }
      // Pulling strongly upward while still holding breaches back to surface cleanly
      const pullUpDelta = e.clientY - this.diveLowestY;
      if (pullUpDelta <= -INPUT_CONFIG.swipeUpThresholdPx * 0.85) {
        this.gestureDiveHeld = false;
        this.verticalAnchorY = e.clientY;
        if (vyPxPerMs <= -0.5) {
          this.queueJump();
        }
      }
    }

    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
    this.lastPointerTime = now;
  };

  private readonly handlePointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.steerPointerId) return;

    if (this.element && typeof this.element.releasePointerCapture === 'function') {
      try {
        if (this.element.hasPointerCapture?.(e.pointerId)) {
          this.element.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore if capture already lost.
      }
    }

    this.steerPointerId = null;
    this.touchSteerTarget = 0;
    this.gestureDiveHeld = false;
  };

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    const active = document.activeElement;
    if (
      active &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT')
    ) {
      return;
    }

    this.notifyFirstGesture();
    this.setDevice('keyboard');

    const code = e.code;
    if (
      code === 'Space' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight'
    ) {
      e.preventDefault();
    }

    const wasDown = this.keys.has(code);
    this.keys.add(code);

    if (wasDown) return;

    if (code === 'Space' || code === 'KeyW' || code === 'ArrowUp') {
      this.queueJump();
      if (code === 'Space') {
        this.callbacks.onStartConfirm?.();
      }
    } else if (code === 'KeyP' || code === 'Escape') {
      this.pendingPause = true;
      this.callbacks.onPauseToggle?.();
    } else if (code === 'KeyR' || code === 'Enter') {
      this.pendingRestart = true;
      this.callbacks.onRestart?.();
      if (code === 'Enter') {
        this.callbacks.onStartConfirm?.();
      }
    } else if (code === 'KeyM') {
      this.callbacks.onMuteToggle?.();
    }
  };

  private readonly handleKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private readonly handleBlur = (): void => {
    this.reset();
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) {
      this.reset();
    }
  };
}

function lerpValue(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
