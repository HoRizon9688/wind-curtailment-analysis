// View-only time navigation. These helpers never change allocation or input data.
const DAY = 1440;
const MINIMUM = 15;

function boundedRange(start, duration) {
  const span = Math.max(MINIMUM, Math.min(DAY, Math.round(duration)));
  const first = Math.max(0, Math.min(DAY - span, Math.round(start)));
  return [first, first + span];
}

export function panRange(range, deltaPixels, widthPixels) {
  if (!Number.isFinite(deltaPixels) || !Number.isFinite(widthPixels) || widthPixels <= 0) return [...range];
  const span = range[1] - range[0];
  return boundedRange(range[0] - deltaPixels / widthPixels * span, span);
}

export function zoomRange(range, position, delta, deltaMode = 0) {
  if (!Number.isFinite(delta) || !Number.isFinite(position) || delta === 0) return [...range];
  const fraction = Math.max(0, Math.min(1, position));
  const span = range[1] - range[0];
  const pixels = delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1);
  const duration = Math.max(MINIMUM, Math.min(DAY, Math.round(span * Math.exp(Math.max(-1, Math.min(1, pixels * .002))))));
  const anchor = range[0] + fraction * span;
  return boundedRange(anchor - fraction * duration, duration);
}
