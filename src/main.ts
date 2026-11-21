import { RiverDuckerGame } from './game';

function showWebGlFallback(hudRoot: HTMLElement, message: string): void {
  hudRoot.style.pointerEvents = 'auto';
  hudRoot.innerHTML = `
    <div style="
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: linear-gradient(180deg, #103b4a 0%, #071e28 100%);
      color: #f3fbff;
      text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    ">
      <div style="
        max-width: 420px;
        padding: 24px;
        border-radius: 18px;
        background: rgba(11, 34, 44, 0.85);
        border: 1px solid rgba(155, 232, 245, 0.28);
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
      ">
        <h1 style="margin: 0 0 10px; font-size: 1.45rem;">River Ducker</h1>
        <p style="margin: 0; line-height: 1.5; opacity: 0.9;">${message}</p>
      </div>
    </div>
  `;
}

function boot(): void {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  const hudRoot = document.getElementById('hud-root');

  if (!canvas || !hudRoot) {
    console.error('[RiverDucker] Missing #game-canvas or #hud-root elements.');
    return;
  }

  let game: RiverDuckerGame | null = null;
  try {
    game = new RiverDuckerGame(canvas, hudRoot);
    game.start();
  } catch (err) {
    console.error('[RiverDucker] Failed to initialize WebGL game:', err);
    showWebGlFallback(
      hudRoot,
      'WebGL2 is required to play River Ducker. Please enable hardware acceleration or try a modern Chrome browser.',
    );
    return;
  }

  window.addEventListener('beforeunload', () => {
    game?.dispose();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
