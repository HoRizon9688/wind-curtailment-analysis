/** Reused from independently reviewed handoff time.mjs; Python T1 oracles are authoritative. */
import {formatTime,QUARTER_MS} from './time.mjs';

function bisectLeft(sortedArr, x) {
  let lo = 0, hi = sortedArr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedArr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * forecasts: Map<epochMs, {value, version, source}>
 * targets: epochMs 数组，已排序
 */
export function alignedForecast(tEpochMs, forecasts, targets) {
  const i = bisectLeft(targets, tEpochMs);
  let left, right;
  if (i < targets.length && targets[i] === tEpochMs) {
    left = right = tEpochMs;
  } else if (i === 0 || i === targets.length || targets[i] - targets[i - 1] !== QUARTER_MS) {
    return { f: null };
  } else {
    left = targets[i - 1]; right = targets[i];
  }
  const a = forecasts.get(left);
  const b = forecasts.get(right);
  const weight = right !== left ? (tEpochMs - left) / 900000 : 0;
  return {
    f: a.value + (b.value - a.value) * weight,
    version: a.version, rightVersion: b.version,
    target: formatTime(left), rightTarget: formatTime(right),
    leftF: a.value, rightF: b.value, weight,
    forecastSource: a.source, rightForecastSource: b.source,
  };
}
